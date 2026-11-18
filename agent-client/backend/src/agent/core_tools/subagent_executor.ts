import type { CoreToolExecutionContext } from '../core_tools_runtime.js';
import {
  createConversation,
  getConversation,
  getMessages,
} from '../config/conversation_service.js';
import {
  describeSubagentConversation,
  listSubagentConversations,
  type SubagentConversationStatus,
  type SubagentConversationSummary,
} from '../subagent_catalog.js';
import type { AgentCompletionEventSink, AgentCompletionRequest } from '../service/agent_service.js';
import type { AgentEvent } from '../types.js';
import { SUBAGENT_TOOL_NAME } from './ids.js';
import { clampNumber } from './shared.js';
import {
  resolveSubagentLimits,
  subagentRuntime,
  type SubagentHandle,
} from './subagent_runtime.js';

export { SUBAGENT_TOOL_NAME };

type ChildRunner = (request: AgentCompletionRequest, sink: AgentCompletionEventSink) => Promise<void>;

/**
 * Test seam for the child run.
 *
 * The production path resolves `agentService` lazily (importing it eagerly would close an
 * import cycle through the runtime), so tests cannot monkey-patch the module binding.
 * Injecting the runner keeps the real async lifecycle — conversation creation, notices,
 * cancellation — under test without a live LLM endpoint.
 */
let childRunnerOverride: ChildRunner | null = null;

export function setSubagentRunnerForTests(runner: ChildRunner | null): void {
  childRunnerOverride = runner;
}

const MAX_DESCRIPTION_CHARS = 120;
const MAX_TASK_CHARS = 40_000;
const MIN_TIMEOUT_MS = 30_000;
const NOTICE_PREVIEW_CHARS = 1_600;

type SubagentAction = 'start' | 'status' | 'result' | 'cancel';
type ChildOutcome = 'completed' | 'failed' | 'cancelled' | 'timed_out';

/**
 * The model-facing `subagent` CoreTool.
 *
 * One tool with an `action` discriminator rather than four schemas: every schema is
 * resident in every request, so four tools would cost their descriptions on every turn
 * for four operations that share one capability.
 *
 * Delegation is asynchronous. `start` returns as soon as the child is admitted, and the
 * child's outcome comes back as a durable `[subagent ...]` notice in the parent's model
 * transcript (the context store that feeds the next request), not in the parent's
 * `events.jsonl`: the parent has no live recorder while the child finishes, so the
 * notice is written where it is guaranteed to be replayed rather than duplicated. The
 * parent's log still records the `subagent` tool call and its result, which is the
 * first-class record of the delegation. That keeps a long child from pinning the parent's
 * turn, and it means a child that outlives the parent run is still delivered on the next
 * run.
 */
export async function executeSubagent(
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
): Promise<string> {
  const action = String(args.action || '').trim() as SubagentAction;
  switch (action) {
    case 'start':
      return startSubagent(args, context);
    case 'status':
      return listSubagents(args, context);
    case 'result':
      return readSubagentResult(args, context);
    case 'cancel':
      return cancelSubagent(args, context);
    default:
      return fail('invalid_arguments', 'action must be start, status, result, or cancel.');
  }
}

async function startSubagent(
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
): Promise<string> {
  const description = String(args.description || '').trim().slice(0, MAX_DESCRIPTION_CHARS);
  const task = String(args.task || '').trim();
  if (!description) return fail('invalid_arguments', 'description is required for action=start; use 3-5 words.');
  if (!task) return fail('invalid_arguments', 'task is required for action=start; write a self-contained prompt.');
  if (task.length > MAX_TASK_CHARS) {
    return fail('invalid_arguments', `task must be at most ${MAX_TASK_CHARS} characters.`);
  }
  if (!context.conversationId) {
    return fail(
      'subagent_requires_conversation',
      'A delegated subagent needs a persisted parent conversation so its result can be delivered back.',
    );
  }
  if (!context.projectPath) {
    return fail('missing_project', 'The conversation is not bound to a project directory, so a subagent has no working root.');
  }

  const limits = resolveSubagentLimits();
  const depth = context.delegationDepth ?? 0;
  if (depth >= limits.maxDepth) {
    return fail(
      'subagent_depth_exceeded',
      `Delegation depth ${depth} has reached the limit of ${limits.maxDepth}; finish this task in the current agent.`,
    );
  }
  if (!subagentRuntime.canStart(limits)) {
    return fail(
      'subagent_busy',
      `${subagentRuntime.activeCount()} subagent(s) are already running (limit ${limits.maxConcurrent}); wait for a [subagent ...] notice instead of starting another.`,
    );
  }

  const timeoutMs = clampNumber(args.timeout_ms, limits.timeoutMs, MIN_TIMEOUT_MS, limits.timeoutMs);
  const childConversation = createConversation({
    projectPath: context.projectPath,
    title: `Subagent · ${description}`,
    parentConversationId: context.conversationId,
    subagentDepth: depth + 1,
    subagentDescription: description,
    // The child runs with the creating role's profile; recording it on the conversation
    // keeps that identity for any later run, not just the one that started it.
    agentId: context.agent?.id,
  });

  const controller = new AbortController();
  const handle: SubagentHandle = {
    conversationId: childConversation.id,
    parentConversationId: context.conversationId,
    description,
    depth: depth + 1,
    startedAt: Date.now(),
    controller,
    timer: null,
    timedOut: false,
    detachParentAbort: null,
  };
  handle.timer = setTimeout(() => {
    handle.timedOut = true;
    controller.abort(new Error('Subagent timed out.'));
  }, timeoutMs);

  // A cancelled parent run owns its children: the child aborts with the same signal, so a
  // stopped parent never leaves a paid-for LLM loop running behind it.
  const parentSignal = context.abortSignal;
  const forwardParentAbort = () => controller.abort(new Error('Parent run was cancelled.'));
  if (parentSignal) {
    if (parentSignal.aborted) {
      forwardParentAbort();
    } else {
      parentSignal.addEventListener('abort', forwardParentAbort, { once: true });
      handle.detachParentAbort = () => parentSignal.removeEventListener('abort', forwardParentAbort);
    }
  }

  subagentRuntime.track(handle);
  void runChild(handle, task, context.agent?.id, context.runId ?? null).catch(() => {
    // runChild settles its own state; this catch only keeps an unexpected rejection from
    // becoming an unhandled one.
  });

  return JSON.stringify({
    ok: true,
    action: 'start',
    subagent: {
      conversationId: handle.conversationId,
      description,
      status: 'running',
      depth: handle.depth,
      timeoutMs,
    },
    note: 'The result will arrive later as a [subagent ...] notice in this conversation. Continue with independent work instead of polling.',
  });
}

async function runChild(
  handle: SubagentHandle,
  task: string,
  agentId: string | undefined,
  parentRunId: string | null,
): Promise<void> {
  let outcome: ChildOutcome = 'failed';
  let error: string | undefined;
  let streamed = '';

  try {
    const sink = {
      emit(event: AgentEvent | { type: 'info'; content: string }): void {
        if (event.type === 'content') streamed += event.content;
      },
      isOpen: () => true,
    };
    await runChildCompletion({
      conversationId: handle.conversationId,
      message: formatChildTask(task),
      agentId,
      parentRunId,
      abortSignal: handle.controller.signal,
      delegationDepth: handle.depth,
      approvalPolicy: 'never',
    }, sink);
    outcome = 'completed';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    outcome = handle.timedOut
      ? 'timed_out'
      : handle.controller.signal.aborted
        ? 'cancelled'
        : 'failed';
  } finally {
    subagentRuntime.release(handle.conversationId);
    const output = outcome === 'completed' ? finalAssistantOutput(handle.conversationId) || streamed.trim() : '';
    try {
      subagentRuntime.publishNotice(handle.parentConversationId, formatCompletionNotice({
        handle,
        outcome,
        output,
        error,
        durationMs: Date.now() - handle.startedAt,
      }));
    } catch {
      // A notice is best-effort from the child's point of view: failing to persist it must
      // not turn a completed child into a crash.
    }
  }
}

async function runChildCompletion(
  request: AgentCompletionRequest,
  sink: AgentCompletionEventSink,
): Promise<void> {
  if (childRunnerOverride) return childRunnerOverride(request, sink);
  const { agentService } = await import('../service/agent_service.js');
  return agentService.runCompletion(request, sink);
}

function listSubagents(args: Record<string, unknown>, context: CoreToolExecutionContext): string {
  if (!context.conversationId) {
    return fail('subagent_requires_conversation', 'A delegated subagent needs a persisted parent conversation.');
  }
  const requested = String(args.conversation_id || '').trim();
  if (requested) {
    const child = resolveChild(requested, context.conversationId);
    if (!child) return fail('subagent_not_found', `Conversation ${requested} is not a subagent of this conversation.`);
    return JSON.stringify({ ok: true, action: 'status', subagents: [describeChild(child.id)] });
  }
  const children = listSubagentConversations(context.conversationId).map((summary) => describeChild(summary.conversationId));
  return JSON.stringify({ ok: true, action: 'status', subagents: children });
}

function readSubagentResult(args: Record<string, unknown>, context: CoreToolExecutionContext): string {
  if (!context.conversationId) {
    return fail('subagent_requires_conversation', 'A delegated subagent needs a persisted parent conversation.');
  }
  const requested = String(args.conversation_id || '').trim();
  if (!requested) return fail('invalid_arguments', 'conversation_id is required for action=result.');
  const child = resolveChild(requested, context.conversationId);
  if (!child) return fail('subagent_not_found', `Conversation ${requested} is not a subagent of this conversation.`);

  const summary = describeChild(child.id);
  if (summary.status === 'running') {
    return fail('subagent_running', `Subagent ${child.id} is still running; its result will arrive as a notice.`);
  }
  const output = finalAssistantOutput(child.id);
  if (!output) {
    return JSON.stringify({
      ok: true,
      action: 'result',
      subagent: summary,
      output: '',
      note: 'The child produced no final assistant text; inspect its conversation or run error instead.',
    });
  }
  return JSON.stringify({ ok: true, action: 'result', subagent: summary, output });
}

function cancelSubagent(args: Record<string, unknown>, context: CoreToolExecutionContext): string {
  if (!context.conversationId) {
    return fail('subagent_requires_conversation', 'A delegated subagent needs a persisted parent conversation.');
  }
  const requested = String(args.conversation_id || '').trim();
  if (!requested) return fail('invalid_arguments', 'conversation_id is required for action=cancel.');
  const child = resolveChild(requested, context.conversationId);
  if (!child) return fail('subagent_not_found', `Conversation ${requested} is not a subagent of this conversation.`);

  const cancelled = subagentRuntime.cancel(child.id);
  return JSON.stringify({
    ok: true,
    action: 'cancel',
    cancelled,
    subagent: describeChild(child.id),
    note: cancelled
      ? 'Cancellation was requested; a [subagent cancelled] notice will follow.'
      : 'The subagent is no longer running, so there was nothing to cancel.',
  });
}

function resolveChild(conversationId: string, parentConversationId: string) {
  const conversation = getConversation(conversationId);
  if (!conversation || conversation.parentConversationId !== parentConversationId) return undefined;
  return conversation;
}

/**
 * The tool-facing projection of a child.
 *
 * Status and timing come from the shared catalog — the same source the Web header
 * renders — so the model and the user never see two different states for one child.
 * `preview` is tool-only: a header badge polls the catalog and must not carry text.
 */
function describeChild(conversationId: string): {
  conversationId: string;
  description: string;
  status: SubagentConversationStatus;
  depth: number | null;
  startedAt: string | null;
  durationMs: number | null;
  preview: string | null;
} {
  const summary: SubagentConversationSummary | null = describeSubagentConversation(conversationId);
  return {
    conversationId,
    description: summary?.description ?? '',
    status: summary?.status ?? 'unknown',
    depth: summary?.depth ?? null,
    startedAt: summary?.startedAt ?? null,
    durationMs: summary?.durationMs ?? null,
    preview: summary?.status === 'running' ? null : truncate(finalAssistantOutput(conversationId), 240),
  };
}

function finalAssistantOutput(conversationId: string): string {
  const messages = getMessages(conversationId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.content.trim()) return message.content.trim();
  }
  return '';
}

/**
 * The delegation scope statement handed to every child.
 *
 * It repeats what the tool description already says on purpose: the child starts with a
 * fresh context and never sees the parent's conversation, so "do not ask the user" is
 * advice it cannot otherwise infer from the task text.
 */
function formatChildTask(task: string): string {
  return [
    'You are a delegated subagent. No user is present in this conversation: do not ask questions,',
    'do not wait for confirmation, and do not assume access to the parent conversation.',
    'Finish with a self-contained answer: what you did, what you found, and the absolute paths of any artifacts.',
    '',
    'Task:',
    task,
  ].join('\n');
}

function formatCompletionNotice(input: {
  handle: SubagentHandle;
  outcome: ChildOutcome;
  output: string;
  error?: string;
  durationMs: number;
}): string {
  const { handle, outcome, output, error, durationMs } = input;
  const seconds = (durationMs / 1000).toFixed(1);
  const label = `"${handle.description}" (conversation ${handle.conversationId})`;
  const lines: string[] = [];

  if (outcome === 'completed') {
    lines.push(`[subagent completed] ${label} completed in ${seconds}s.`);
    lines.push('Its closing message:');
    lines.push(output ? truncate(output, NOTICE_PREVIEW_CHARS) : '(no closing message)');
    lines.push('');
    lines.push(`Use subagent action="result" conversation_id="${handle.conversationId}" to read the full output again.`);
    return lines.join('\n');
  }
  if (outcome === 'timed_out') {
    lines.push(`[subagent timed out] ${label} exceeded its time limit and was stopped after ${seconds}s.`);
  } else if (outcome === 'cancelled') {
    lines.push(`[subagent cancelled] ${label} was cancelled after ${seconds}s.`);
  } else {
    lines.push(`[subagent failed] ${label} failed after ${seconds}s${error ? `: ${error}` : '.'}`);
  }
  lines.push('Its partial transcript is in that conversation; continue without waiting for it.');
  return lines.join('\n');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… [truncated: ${value.length - maxChars} more characters]`;
}

function fail(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}
