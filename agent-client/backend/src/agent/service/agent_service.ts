import { AgentRunCancelledError, ContextBudgetExceededError, PendingTasksError, agentRuntime } from '../agent_runtime.js';
import { RepeatedToolFailureError } from '../tool_failure_guard.js';
import type { AgentChatMessage, AgentChatRequest, AgentContextMessage, AgentEvent, RuntimeContextUpdate } from '../types.js';
import {
  AgentContextError,
  agentContextResolver,
  type AgentRuntimeContext,
} from './agent_context_resolver.js';
import type { AgentRole } from '../config/agent_config_store.js';
import type { Message } from '../config/conversation_types.js';
import {
  createAgentRun,
  createAgentRunStep,
  updateAgentRun,
  updateAgentRunStep,
  type AgentRun,
  type AgentRunStatus,
  type AgentRunStopReason,
  type AgentRunStep,
} from '../config/run_store.js';
import {
  formatBudgetStatus,
  planRunEndCompaction,
  runtimeContextManager,
} from '../context_manager.js';
import { compactRecord } from '../config/conversation_file_store.js';
import { beginRunActivity, endRunActivity, settleRunActivity } from '../run_activity.js';
import { finalizeRunManifest } from '../provenance/run_manifest.js';
import { maybeDiscoveryPreflight } from '../discovery_preflight_runtime.js';
import type { TranscriptRecorder, TranscriptRunIdentity } from '../transcript_store.js';
import { runRegistry } from '../run_registry.js';
import { getConversation } from '../config/conversation_service.js';

type RunStatus = 'running' | 'completed' | 'error';

/**
 * Events kept for the UI that the transcript does not already carry as a first-class
 * record. Tool calls and their results are deliberately absent: the transcript has
 * `tool_call` / `tool_result` records for those, and the read side rebuilds their
 * runtime-event shape from them rather than storing the same activity twice.
 */
export const TRANSCRIPT_MIRRORED_EVENT_TYPES = [
  'info',
  'loop_health',
  'mcp_status',
  'planning_panel',
  'goal_change',
  'goal_round',
  'security_approval_request',
  'security_approval_result',
  'workspace_artifact',
  'error',
];

export interface AgentCompletionRequest {
  conversationId?: string;
  message: string;
  abortSignal?: AbortSignal;
  llmProviderId?: string;
  agentId?: string;
  /** Delegation depth for this run; see `AgentChatRequest.delegationDepth`. */
  delegationDepth?: number;
  /** Approval handling for this run; delegated children pass `never`. */
  approvalPolicy?: 'ask' | 'never';
  /** Run that spawned this one, recorded on the run and in the transcript. */
  parentRunId?: string | null;
  /**
   * Set when this run is an automatic goal continuation round.
   *
   * Recorded before the loop starts so the round counter is durable even if the run fails
   * or is cancelled: a round that was admitted but never finished still consumed budget,
   * and the fold derives `roundsStarted` from these records alone.
   */
  goalRound?: GoalRoundRequest;
}

/** One admitted automatic continuation round. */
export interface GoalRoundRequest {
  goalId: string;
  revision: number;
  round: number;
}

export interface AgentCompletionEventSink {
  emit(event: AgentEvent | { type: 'info'; content: string }): void;
  isOpen(): boolean;
}

export class AgentService {
  /**
   * Run one completion, serialized against every other run of the same conversation.
   *
   * The transcript allocates its sequence from the log tail once, so two live recorders on
   * one conversation would duplicate sequence numbers and permanently break that log. A
   * team dispatch batch can target one role session twice, so this is not hypothetical:
   * the queue is what makes "one writer per log" true for every run path, including the
   * delegated children that never pass through the HTTP layer.
   */
  async runCompletion(request: AgentCompletionRequest, sink: AgentCompletionEventSink): Promise<void> {
    if (!request.message) {
      throw new AgentServiceError(400, 'message is required');
    }
    const release = request.conversationId ? await runRegistry.acquire(request.conversationId) : null;
    try {
      await this.runCompletionLocked(request, sink);
    } finally {
      release?.();
    }
  }

  private async runCompletionLocked(request: AgentCompletionRequest, sink: AgentCompletionEventSink): Promise<void> {
    // A run admitted while the client was disconnecting still holds a queue slot; drop it
    // before it spends a model request.
    if (request.abortSignal?.aborted) throw new AgentRunCancelledError();

    const { history } = this.prepareConversationHistory(request.conversationId, request.message);
    let context: AgentRuntimeContext;
    try {
      context = agentContextResolver.resolve(request);
    } catch (err) {
      if (err instanceof AgentContextError) {
        throw new AgentServiceError(err.statusCode, err.message);
      }
      throw err;
    }

    const conversation = request.conversationId ? getConversation(request.conversationId) : undefined;
    const identity: TranscriptRunIdentity = {
      agentId: context.agent.id,
      roleId: conversation?.roleId ?? null,
      parentConversationId: conversation?.parentConversationId ?? null,
      parentRunId: request.parentRunId ?? null,
      delegationDepth: request.delegationDepth ?? 0,
    };
    const runState = new PersistedRunState({
      conversationId: request.conversationId,
      agentId: context.agent.id,
      agentRole: context.agent.role,
      parentRunId: request.parentRunId ?? null,
    });
    const agentInfoEvent = {
      type: 'info' as const,
      content: context.info,
    };

    runState.recordEvent(agentInfoEvent);
    if (request.goalRound) {
      const roundEvent = { type: 'goal_round' as const, ...request.goalRound };
      runState.recordEvent(roundEvent);
      sink.emit(roundEvent);
    }
    runState.persist('running');
    sink.emit({ type: 'run_status', runId: runState.runId, status: 'building_context' });
    sink.emit(agentInfoEvent);
    if (request.conversationId) {
      // The tail lands in the transcript before the user turn so the next run replays it
      // in place. Without this every run boundary truncates the reusable prefix to the
      // previous run's history and re-prefills everything that run produced.
      agentContextResolver.appendPinnedTail(request.conversationId, runState.runId, context.pinnedTail);
      agentContextResolver.appendUserContextMessage(request.conversationId, runState.runId, request.message);
    }

    const managedHistory = runtimeContextManager.buildManagedHistory({
      conversationId: request.conversationId,
      history,
      context,
      userMessage: request.message,
    });
    const discovery = await maybeDiscoveryPreflight({
      context,
      userMessage: request.message,
      messages: managedHistory.messages,
    });
    if (discovery) {
      context.systemPrompt = `${context.systemPrompt}

[bounded capability discovery] ${discovery.text}`;
      const discoveryEvent = {
        type: 'info' as const,
        content: `discovery_preflight: ${JSON.stringify({
          status: discovery.card.status,
          selectedId: discovery.card.selectedId,
          entrypoint: discovery.card.entrypoint,
          latencyMs: discovery.card.latencyMs,
          contextChars: discovery.card.contextChars,
          textChars: discovery.text.length,
          materializedChars: discovery.materialized_chars,
        })}`,
      };
      runState.recordEvent(discoveryEvent);
      sink.emit(discoveryEvent);
    }
    // Live view of the runtime's own message array: the service assembles the first
    // request but does not see how full the run gets afterwards, and it cannot decide
    // about the run-end checkpoint from the assembly snapshot alone.
    let runtimeContext: RuntimeContextUpdate = { budget: managedHistory.budget };
    const budgetEvent = {
      type: 'loop_health' as const,
      level: managedHistory.budget.hardExceeded ? 'warning' as const : 'info' as const,
      reason: managedHistory.budget.softExceeded ? 'context_watermark_exceeded' : 'context_watermark_checked',
      detail: formatBudgetStatus(managedHistory.budget),
    };
    runState.applyRuntimeEvent(budgetEvent);
    sink.emit(budgetEvent);

    try {
      for await (const event of agentRuntime.chat(toAgentChatRequest(
        context,
        managedHistory.messages,
        request,
        runState.runId,
        (recorder) => runState.attachTranscript(recorder),
        (update) => {
          // A summary update only arrives with a compaction; the final budget update
          // carries no summary, so the last summary must be kept across updates.
          runtimeContext = { budget: update.budget, summary: update.summary ?? runtimeContext.summary };
        },
        // The checkpoint is handed to the runtime, not injected into the messages: the
        // assembly now sends the full history, so a summary in the request would pay for the
        // same content twice. It is consumed only if this run has to compact.
        managedHistory.checkpoint,
        (message) => {
          if (request.conversationId) {
            agentContextResolver.appendRunContextMessage(request.conversationId, runState.runId, message);
          }
        },
        identity,
      ))) {
        if (request.abortSignal?.aborted) throw new AgentRunCancelledError();
        runState.applyRuntimeEvent(event);
        if (sink.isOpen()) {
          sink.emit(event);
        }
      }

      runState.persist('completed');
      if (sink.isOpen()) {
        sink.emit({ type: 'run_status', runId: runState.runId, status: 'completed', stopReason: runState.stopReason });
      }
      const finalBudget = runtimeContext.budget;
      const runtimeSummary = runtimeContext.summary;
      // Two different reasons to write a checkpoint: the run compacted mid-run (the
      // summary already exists and only needs persisting), or the run ended above the
      // soft watermark (an incremental summary is needed). Neither fires for a short run.
      const aboveSoftWatermark = runtimeContextManager.shouldCompressAfterRun(finalBudget);
      const plan = planRunEndCompaction({ runtimeSummary, aboveSoftWatermark });
      if (request.conversationId && plan.action !== 'skip') {
        sink.emit({
          type: 'loop_health',
          level: 'info',
          reason: 'context_compaction_started',
          detail: runtimeSummary
            ? 'Run compacted in context. Persisting its summary instead of summarising the same history again.'
            : 'Context watermark exceeded. Compressing current conversation after task completion.',
        });
        // Two sources on purpose: the transcript is what the summariser should read, while
        // the chat record carries the run metadata `programState` is extracted from.
        const chatMessages = agentContextResolver.getMessages(request.conversationId);
        const contextMessages = agentContextResolver.getContextMessages(request.conversationId).map((item) => ({
          role: item.role,
          content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        }));
        if (plan.action === 'reuse' && runtimeSummary) {
          const checkpoint = runtimeContextManager.saveCheckpoint({
            conversationId: request.conversationId,
            runId: runState.runId,
            context,
            messages: chatMessages,
            budget: finalBudget,
            triggerReason: 'runtime_summary_after_task',
            modelSummary: runtimeSummary,
          });
          sink.emit({
            type: 'loop_health',
            level: 'info',
            reason: 'context_compaction_completed',
            detail: `Context checkpoint ${checkpoint.id} saved from the in-run summary; no second summariser call was needed.`,
          });
        } else {
          const { checkpoint, degraded } = await runtimeContextManager.compactAfterRun({
            conversationId: request.conversationId,
            runId: runState.runId,
            context,
            messages: contextMessages,
            runMessages: chatMessages,
            budget: finalBudget,
            triggerReason: 'soft_watermark_after_task',
            ...(runtimeSummary ? { priorSummary: runtimeSummary } : {}),
            abortSignal: request.abortSignal,
          });
          // A degraded summary is still saved — programState is mechanical and correct — but
          // reporting it as a clean compaction hides a summariser that keeps failing.
          sink.emit(degraded ? {
            type: 'loop_health',
            level: 'warning',
            reason: 'context_compaction_degraded',
            detail: `Context checkpoint ${checkpoint.id} saved for current conversation only, but its model summary is a fallback (${degraded.reason}). Program state is unaffected.`,
          } : {
            type: 'loop_health',
            level: 'info',
            reason: 'context_compaction_completed',
            detail: `Context checkpoint ${checkpoint.id} saved for current conversation only.`,
          });
        }
      }
    } catch (err) {
      if (err instanceof AgentRunCancelledError || request.abortSignal?.aborted) {
        runState.cancel();
        if (sink.isOpen()) {
          sink.emit({ type: 'run_status', runId: runState.runId, status: 'cancelled', stopReason: 'cancelled' });
        }
        return;
      }
      if (err instanceof RepeatedToolFailureError) {
        runState.failTool(err.message);
        if (sink.isOpen()) {
          sink.emit({
            type: 'loop_health',
            level: 'warning',
            reason: 'repeated_tool_failure_limit',
            toolName: err.toolName,
            detail: err.message,
          });
          sink.emit({ type: 'run_status', runId: runState.runId, status: 'failed', stopReason: 'tool_error' });
          sink.emit({ type: 'error', error: err.message });
        }
        return;
      }
      if (err instanceof ContextBudgetExceededError || err instanceof PendingTasksError) {
        const stopReason = err instanceof ContextBudgetExceededError ? 'budget_exceeded' : 'unfinished_tasks';
        runState.recordEvent({ type: 'error', error: err.message });
        runState.persist('error', err.message, stopReason);
        if (sink.isOpen()) {
          sink.emit({ type: 'run_status', runId: runState.runId, status: 'failed', stopReason });
          sink.emit({ type: 'error', error: err.message });
        }
        if (err instanceof ContextBudgetExceededError && request.conversationId) {
          try {
            const previousSummary = managedHistory.checkpoint?.modelSummary;
            runtimeContextManager.saveCheckpoint({
              conversationId: request.conversationId,
              runId: runState.runId,
              context,
              messages: agentContextResolver.getMessages(request.conversationId),
              budget: runtimeContext.budget,
              triggerReason: 'context_budget_blocked',
              modelSummary: runtimeContext.summary ?? (previousSummary && typeof previousSummary === 'object' && !Array.isArray(previousSummary) ? previousSummary as Record<string, unknown> : {
                schemaVersion: 1,
                taskState: { currentStatus: 'blocked' },
                continuationPrompt: 'Continue the unfinished task using the persisted conversation and workspace.',
              }),
            });
          } catch (checkpointError) {
            const event = {
              type: 'loop_health' as const,
              level: 'warning' as const,
              reason: 'context_checkpoint_save_failed',
              detail: checkpointError instanceof Error ? checkpointError.message : String(checkpointError),
            };
            runState.recordEvent(event);
            if (sink.isOpen()) sink.emit(event);
          }
        }
        return;
      }
      const errorMessage = `Connection error: ${err instanceof Error ? err.message : String(err)}`;
      runState.persist('error', errorMessage);
      if (sink.isOpen()) {
        sink.emit({ type: 'run_status', runId: runState.runId, status: 'failed', stopReason: 'connection_error' });
        sink.emit({ type: 'error', error: errorMessage });
      }
    } finally {
      // A run can stop between an assistant tool call and its result (cancel, crash,
      // repeated-failure abort). The missing row is filled here so the transcript stays
      // replayable; without it the next request would carry an invalid tool pairing.
      if (request.conversationId && runState.runId) {
        agentContextResolver.repairRunToolPairs(request.conversationId, runState.runId);
        // Every branch above settles the activity record; this is the net for a throw that
        // escaped them, so a crashed run can never leave a conversation spinning forever.
        endRunActivity(request.conversationId, runState.runId);
      }
    }
  }

  private prepareConversationHistory(conversationId: string | undefined, message: string): { history: AgentChatMessage[] } {
    if (!conversationId) {
      return { history: [] };
    }

    const userMessage = agentContextResolver.createUserMessage(conversationId, message);
    const chatMessages = agentContextResolver.getMessages(conversationId);
    agentContextResolver.maybeUpdateConversationTitle(conversationId, message, chatMessages.length);

    const contextHistory = agentContextResolver.getContextMessages(conversationId);
    if (contextHistory.length) {
      return { history: contextHistory.map((item) => ({
        role: item.role,
        content: item.content,
        ...(item.toolCalls?.length ? { toolCalls: item.toolCalls } : {}),
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
      })) };
    }

    // Legacy session: seed the model transcript from the chat record once, minus the
    // user row that belongs to this run, then replay it like any other history.
    const legacyHistory = chatMessages.filter((item) => item.id !== userMessage.id);
    if (legacyHistory.length) {
      agentContextResolver.seedContextMessages(conversationId, legacyHistory.map((item) => ({ role: item.role, content: item.content })));
      return { history: legacyHistory.map((item) => ({ role: item.role, content: item.content })) };
    }

    return { history: [] };
  }
}

function toAgentChatRequest(
  context: AgentRuntimeContext,
  history: AgentChatMessage[],
  request: AgentCompletionRequest,
  runId: string | null,
  onTranscript?: (recorder: TranscriptRecorder | null) => void,
  onRuntimeContext?: (update: RuntimeContextUpdate) => void,
  priorCheckpoint?: AgentChatRequest['priorCheckpoint'],
  onContextMessage?: (message: AgentContextMessage) => void,
  identity: TranscriptRunIdentity = {},
): AgentChatRequest {
  return {
    runId,
    ...(identity.agentId ? { agentId: identity.agentId } : {}),
    roleId: identity.roleId ?? null,
    parentConversationId: identity.parentConversationId ?? null,
    parentRunId: identity.parentRunId ?? null,
    llm: context.llm,
    messages: history,
    userMessage: request.message,
    abortSignal: request.abortSignal,
    systemPrompt: context.systemPrompt,
    systemPromptSections: context.systemPromptSections,
    pinnedTail: context.pinnedTail,
    conversationId: request.conversationId,
    mainAgent: context.agent,
    mcpServers: context.mcpServers,
    skills: context.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      resources: skill.resources,
      // Runtime-only source directory: lets provenance.json resolve without a second
      // lookup or a duplicated path table. It is not persisted in the skills index.
      ...(skill.directory ? { directory: skill.directory } : {}),
    })),
    securityMode: context.agent.securityMode,
    ...(typeof request.delegationDepth === 'number' ? { delegationDepth: request.delegationDepth } : {}),
    ...(request.approvalPolicy ? { approvalPolicy: request.approvalPolicy } : {}),
    ...(onTranscript ? { onTranscript } : {}),
    ...(onRuntimeContext ? { onRuntimeContext } : {}),
    ...(priorCheckpoint ? { priorCheckpoint } : {}),
    ...(onContextMessage ? { onContextMessage } : {}),
  };
}

export class AgentServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export { AgentContextError };

export class PersistedNarrationBuffer {
  private content = '';

  append(content: string): void {
    this.content += content;
  }

  discard(count: number): void {
    this.content = this.content.slice(0, Math.max(0, this.content.length - count));
  }

  clear(): void {
    this.content = '';
  }

  peek(): string {
    return this.content;
  }

  flush(): { type: 'info'; content: string } | null {
    const content = this.content.trim();
    this.clear();
    return content ? { type: 'info', content } : null;
  }
}

/** Exported for tests: the run's event/step bookkeeping is otherwise unreachable. */
export class PersistedRunState {
  private fullContent = '';
  private runEvents: any[] = [];
  private runPlan: { title: string; steps: string[] } | null = null;
  private narration = new PersistedNarrationBuffer();
  private readonly assistantMessage: Message | null;
  private readonly run: AgentRun | null;
  private activeToolSteps: AgentRunStep[] = [];
  private loadedTools = new Set<string>();
  private loadedSkills = new Set<string>();
  private currentStatus: AgentRunStatus = 'building_context';
  private contentPersistTimer: ReturnType<typeof setTimeout> | null = null;
  stopReason: AgentRunStopReason | null = null;
  private transcript: TranscriptRecorder | null = null;

  constructor({
    conversationId,
    agentId,
    agentRole,
    parentRunId,
  }: {
    conversationId?: string;
    agentId?: string | null;
    agentRole: AgentRole;
    parentRunId?: string | null;
  }) {
    this.assistantMessage = conversationId
      ? agentContextResolver.createAssistantRunMessage(conversationId)
      : null;
    this.run = conversationId
      ? createAgentRun({
          conversationId,
          assistantMessageId: this.assistantMessage?.id || null,
          agentId,
          parentRunId: parentRunId || null,
          status: 'building_context',
          metadata: { agentRole },
        })
      : null;
    // Liveness is in-memory and starts here, not with the first model request: another view
    // of the same conversation must be able to see the run as busy while it is being built.
    beginRunActivity(conversationId, this.run?.id);
  }

  get runId(): string | null {
    return this.run?.id || null;
  }

  /**
   * Take the run's transcript handle.
   *
   * The runtime creates the handle when the generator first advances, which is after
   * this service has already raised the run-context and budget events. Replaying what
   * was collected so far keeps those ahead of everything the runtime yields.
   */
  attachTranscript(transcript: TranscriptRecorder | null): void {
    this.transcript = transcript;
    if (!transcript) return;
    for (const event of this.runEvents) {
      if (TRANSCRIPT_MIRRORED_EVENT_TYPES.includes(event?.type)) transcript.recordEngineEvent(event);
    }
  }

  /** Record an event for the UI and mirror it into the transcript. */
  private pushRunEvent(event: AgentEvent | { type: string; [key: string]: unknown }): void {
    this.runEvents.push(event);
    if (TRANSCRIPT_MIRRORED_EVENT_TYPES.includes(event.type)) {
      this.transcript?.recordEngineEvent(event);
    }
  }

  applyRuntimeEvent(event: AgentEvent): void {
    if (event.type === 'run_status') {
      this.setRunStatus(event.status as AgentRunStatus);
      if (event.stopReason) {
        this.stopReason = event.stopReason as AgentRunStopReason;
      }
      this.persist('running');
      return;
    }

    if (event.type === 'content' && event.content) {
      this.fullContent += event.content;
      this.narration.append(event.content);
      this.scheduleContentPersist();
      return;
    }

    if (event.type === 'thinking' && event.content) {
      // Reasoning is live-only at this layer: the transcript already holds the raw provider
      // chunk it came from and the read side rebuilds it from there, so there is nothing to
      // persist. Returning early also keeps a thinking delta from reaching the trailing
      // `persist('running')` — there are as many of them as there are content deltas.
      return;
    }

    if (event.type === 'loop_health' && event.reason === 'model_response_truncated') {
      const count = Math.max(0, Number(event.discardedContentChars || 0));
      if (count) {
        this.fullContent = this.fullContent.slice(0, Math.max(0, this.fullContent.length - count));
        this.narration.discard(count);
      }
    }

    if (event.type === 'plan_update' && event.steps?.length) {
      this.narration.clear();
      this.runPlan = { title: event.title || 'Execution plan', steps: event.steps };
      this.appendRunStep('plan', 'completed', this.runPlan.title, this.runPlan, event.steps.join('\n'));
    } else if (isPersistedRunEvent(event)) {
      this.flushRunNarration();
      this.pushRunEvent(event);
      this.recordRunStepForEvent(event);
    }

    this.persist('running');
  }

  recordEvent(event: { type: string; [key: string]: unknown }): void {
    this.pushRunEvent(event);
    this.appendRunStep('info', 'completed', 'Run context', event, String(event.content || ''));
  }

  cancel(): void {
    this.stopReason = 'cancelled';
    this.flushRunNarration();
    this.pushRunEvent({ type: 'error', error: 'Run cancelled by user.' });
    this.appendRunStep('cancelled', 'cancelled', 'Run cancelled', { reason: 'user_interrupt' }, 'Run cancelled by user.');
    this.persist('error', 'Run cancelled by user.');
    if (this.run) {
      updateAgentRun(this.run.conversationId, this.run.id, {
        status: 'cancelled',
        stopReason: 'cancelled',
        error: 'Run cancelled by user.',
        completedAt: new Date().toISOString(),
      });
      // The persisted record above is the durable status; the activity record is corrected
      // too, so the sidebar reports a cancellation rather than the error it went through.
      settleRunActivity(this.run.conversationId, this.run.id, 'cancelled');
    }
  }

  failTool(error: string): void {
    this.stopReason = 'tool_error';
    this.flushRunNarration();
    this.pushRunEvent({ type: 'error', error });
    this.appendRunStep('tool_failure_limit', 'failed', 'Tool retry limit reached', { reason: 'repeated_tool_failure_limit' }, error);
    this.persist('error', error, 'tool_error');
  }

  persist(status: RunStatus, error?: string, errorStopReason?: AgentRunStopReason): void {
    if (!this.assistantMessage) return;
    this.cancelScheduledContentPersist();
    if (status === 'completed') {
      this.flushRunNarration();
    }
    const runSummaryContent = stripLeadingPlanNarration(this.narration.peek()).trim();
    agentContextResolver.updateMessage(this.assistantMessage.conversationId, this.assistantMessage.id, {
      content: this.fullContent,
      toolCalls: {
        run: {
          plan: this.runPlan,
          runId: this.run?.id || null,
          summary: runSummaryContent || stripLeadingPlanNarration(this.fullContent),
          startedAt: this.assistantMessage.createdAt,
          ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
          // `interruptedAt` 只表示「用户中断了这次运行」。曾经它在每个 error 上都写，
          // 于是真正的失败与用户主动停止在消息记录里长得一模一样，读侧无法分辨。
          ...(status === 'error'
            ? {
              error: error || 'Unknown error',
              ...(this.stopReason === 'cancelled' ? { interruptedAt: new Date().toISOString() } : {}),
            }
            : {}),
          status,
        },
      },
    });
    this.persistAgentRun(status, runSummaryContent || stripLeadingPlanNarration(this.fullContent), error, errorStopReason);
    if (status === 'completed' || status === 'error') {
      compactRecord(this.assistantMessage.conversationId);
    }
  }

  private scheduleContentPersist(): void {
    if (this.contentPersistTimer) return;
    this.contentPersistTimer = setTimeout(() => {
      this.contentPersistTimer = null;
      this.persist('running');
    }, 250);
    this.contentPersistTimer.unref?.();
  }

  private cancelScheduledContentPersist(): void {
    if (!this.contentPersistTimer) return;
    clearTimeout(this.contentPersistTimer);
    this.contentPersistTimer = null;
  }

  private flushRunNarration(): void {
    const narration = this.narration.flush();
    if (narration) {
      this.runEvents.push(narration);
      this.appendRunStep('narration', 'completed', 'Assistant narration', narration, narration.content);
    }
  }

  private recordRunStepForEvent(event: AgentEvent): void {
    if (event.type === 'tool_call_start') {
      this.setRunStatus('tool_execution');
      const step = this.appendRunStep('tool_call', 'running', `Tool: ${event.tool_name}`, {
        toolName: event.tool_name,
        arguments: event.arguments,
        turnIndex: event.turnIndex ?? null,
        planStepIndex: event.planStepIndex ?? null,
      }, '', {
        turnIndex: event.turnIndex ?? null,
        planStepIndex: event.planStepIndex ?? null,
      });
      if (step) this.activeToolSteps.push(step);
      return;
    }

    if (event.type === 'tool_call_result') {
      const index = this.activeToolSteps.findIndex((step) => step.title === `Tool: ${event.tool_name}`);
      const step = index >= 0 ? this.activeToolSteps.splice(index, 1)[0] : null;
      const preview = previewText(event.result);
      if (step) {
        updateAgentRunStep(this.run?.conversationId || this.assistantMessage?.conversationId || '', step.id, {
          status: 'completed',
          resultPreview: preview,
          payload: {
            ...(typeof step.payload === 'object' && step.payload ? step.payload : {}),
            observation: event.observation || null,
          },
          turnIndex: event.turnIndex ?? step.turnIndex,
          planStepIndex: event.planStepIndex ?? step.planStepIndex,
          completedAt: new Date().toISOString(),
        });
      } else {
        this.appendRunStep('tool_result', 'completed', `Tool result: ${event.tool_name}`, {
          toolName: event.tool_name,
          observation: event.observation || null,
        }, preview, {
          turnIndex: event.turnIndex ?? null,
          planStepIndex: event.planStepIndex ?? null,
        });
      }
      this.trackLoadedCapability(event);
      return;
    }

    if (event.type === 'mcp_status') {
      this.appendRunStep('mcp_status', 'completed', 'MCP connection status', event, summarizeMcpStatus(event));
      return;
    }

    if (event.type === 'loop_health') {
      this.appendRunStep('loop_health', event.level, `Loop health: ${event.reason}`, event, event.detail);
      return;
    }

    if (event.type === 'workspace_artifact') {
      this.appendRunStep('workspace_artifact', 'completed', `Artifact: ${event.artifact.title}`, event.artifact, event.artifact.path);
      return;
    }

    if (event.type === 'planning_panel') {
      this.appendRunStep('planning_panel', event.status === 'complete' ? 'completed' : 'waiting', `Planning: ${event.title}`, event, event.filePath || event.note || event.panel);
      return;
    }

    if (event.type === 'security_approval_request') {
      this.setRunStatus('waiting_user_input');
      this.appendRunStep('security_approval', 'waiting', `Security approval: ${event.toolName}`, event, event.reason);
      return;
    }

    if (event.type === 'security_approval_result') {
      this.appendRunStep('security_approval_result', 'completed', `Security approval: ${event.decision}`, event, event.decision);
      return;
    }

    if (event.type === 'error') {
      this.stopReason = 'tool_error';
      this.appendRunStep('error', 'failed', 'Runtime error', event, event.error);
    }
  }

  private appendRunStep(kind: string, status: string, title: string, payload?: unknown, resultPreview = '', metadata: {
    turnIndex?: number | null;
    planStepIndex?: number | null;
    parentStepId?: string | null;
  } = {}): AgentRunStep | null {
    if (!this.run) return null;
    return createAgentRunStep({
      conversationId: this.run.conversationId,
      runId: this.run.id,
      turnIndex: metadata.turnIndex ?? null,
      planStepIndex: metadata.planStepIndex ?? null,
      parentStepId: metadata.parentStepId ?? null,
      kind,
      status,
      title,
      payload,
      resultPreview: previewText(resultPreview),
    });
  }

  private setRunStatus(status: AgentRunStatus): void {
    this.currentStatus = status;
    if (this.run) updateAgentRun(this.run.conversationId, this.run.id, { status });
  }

  private persistAgentRun(status: RunStatus, summary: string, error?: string, errorStopReason?: AgentRunStopReason): void {
    if (!this.run) return;
    const nextStatus: AgentRunStatus = status === 'completed' ? 'completed' : status === 'error' ? 'failed' : this.currentStatus;
    const stopReason = status === 'completed' ? (this.stopReason || 'final_answer') : status === 'error' ? (errorStopReason || 'connection_error') : this.stopReason;
    updateAgentRun(this.run.conversationId, this.run.id, {
      status: nextStatus,
      stopReason,
      error: error || '',
      plan: this.runPlan || {},
      loadedTools: [...this.loadedTools],
      loadedSkills: [...this.loadedSkills],
      summary,
      completedAt: status === 'completed' || status === 'error' ? new Date().toISOString() : undefined,
    });
    if (status === 'completed' || status === 'error') {
      settleRunActivity(this.run.conversationId, this.run.id, nextStatus === 'completed' ? 'completed' : 'failed');
      // Provenance is observability, not a gate: the manifest write runs after the
      // durable run record and can never fail the turn or delay its status.
      void finalizeRunManifest({
        conversationId: this.run.conversationId,
        runId: this.run.id,
      });
    }
  }

  private trackLoadedCapability(event: Extract<AgentEvent, { type: 'tool_call_result' }>): void {
    const loadedCapability = event.observation?.loadedCapability as { kind?: string; id?: string } | undefined;
    if (loadedCapability?.id && (loadedCapability.kind === 'coretool' || loadedCapability.kind === 'mcp')) {
      this.loadedTools.add(loadedCapability.id);
      return;
    }
    if (loadedCapability?.id && loadedCapability.kind === 'skill') {
      this.loadedSkills.add(loadedCapability.id);
      return;
    }

    // Historical transcripts recorded the retired `load_skill` tool; accept both names so
    // re-parsing an old run still restores its loaded capabilities.
    const parsed = parseToolResult(event.result);
    if ((event.tool_name !== 'toolload' && event.tool_name !== 'load_skill') || !parsed?.ok) return;
    if (parsed.action === 'mcp_tool' && typeof parsed.id === 'string') {
      this.loadedTools.add(parsed.id);
    }
    if (parsed.action === 'mcp_resource' && typeof parsed.uri === 'string') {
      this.loadedTools.add(parsed.uri);
    }
    if (parsed.action === 'skill' && typeof parsed.skillId === 'string') {
      this.loadedSkills.add(parsed.skillId);
    }
  }
}

/**
 * Runtime-yielded events that reach the UI and the transcript.
 *
 * This is the one gate in `applyRuntimeEvent`; a type missing here is silently dropped
 * before it reaches `pushRunEvent`, which is how `goal_change` once vanished: the tool
 * returned the new goal, the model's next `get_goal` read the log, found nothing, and
 * the Web panel stayed empty. Every type in `TRANSCRIPT_MIRRORED_EVENT_TYPES` except
 * `info` must be listed here — `test/run_event_persistence.test.ts` enforces that.
 */
export function isPersistedRunEvent(event: AgentEvent): boolean {
  return [
    'workspace_artifact',
    'planning_panel',
    'goal_change',
    'goal_round',
    'security_approval_request',
    'security_approval_result',
    'tool_call_start',
    'tool_call_result',
    'loop_health',
    'mcp_status',
    'error',
  ].includes(event.type);
}

function previewText(value: unknown, maxLength = 2000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated]` : text;
}

function parseToolResult(value: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeMcpStatus(event: Extract<AgentEvent, { type: 'mcp_status' }>): string {
  return [
    `connected=${event.connected.length}`,
    `failed=${event.failed.length}`,
    `disconnected=${event.disconnected.length}`,
  ].join(', ');
}

function stripLeadingPlanNarration(content: string): string {
  const trimmedStart = content.trimStart();
  const leadingWhitespace = content.slice(0, content.length - trimmedStart.length);
  const firstBreak = trimmedStart.search(/\n{2,}|#{1,6}\s/);
  const firstBlockEnd = firstBreak > 0 ? firstBreak : Math.min(trimmedStart.length, 700);
  const firstBlock = trimmedStart.slice(0, firstBlockEnd);
  const normalizedBlock = firstBlock.toLowerCase();
  const isPlanNarration = /(plan|todo|steps|[\u8ba1\u89c4][\u5212\u5212])/.test(normalizedBlock)
    && /(create|show|execute|start|first|[\u521b\u5236\u751f\u4fdd\u5c55\u6267\u5148])/.test(normalizedBlock)
    && !/^(#{1,6}\s|\*\*)/.test(firstBlock.trim());

  if (!isPlanNarration) return content;
  return `${leadingWhitespace}${trimmedStart.slice(firstBlockEnd).replace(/^\s+/, '')}`;
}

export const agentService = new AgentService();
