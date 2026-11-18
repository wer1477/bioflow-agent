import crypto from 'node:crypto';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { getLLMClient } from './llm_client.js';
import { mcpManager } from './mcp_manager.js';
import type { AgentChatRequest, AgentEvent, MCPConnectResult } from './types.js';
import { buildObservationPayload, createObservation } from './observation_manager.js';
import {
  executeCoreTool,
  isParallelizableCoreTool,
  TOOLLOAD_TOOL_NAME,
} from './core_tools_runtime.js';
import { buildResidentTools } from './resident_tools.js';
import {
  readActivatedToolNames,
  readSystemPromptHash,
  recordActivatedToolNames,
  recordSystemPromptHash,
} from './config/conversation_cache_state_store.js';
import { subagentRuntime } from './core_tools/subagent_runtime.js';
import {
  MAX_RUNTIME_COMPACTIONS,
  compactRuntimeMessages,
  estimateContextBudget,
  formatBudgetStatus,
  getTokenUsageCalibration,
  recordObservedPromptTokens,
  resolveMaxOutputTokens,
  shouldCompactInRun,
} from './context_manager.js';
import { resolveContextWindow } from './context_window.js';
import { RepeatedToolFailureError, ToolFailureTracker } from './tool_failure_guard.js';
import { securityApprovalStore } from './security_approval_store.js';
import { normalizeSecurityMode } from './security_policy.js';
import { assessRuntimeToolSecurity } from './runtime_security_gate.js';
import { resolveConversationProjectPath } from './project_boundary.js';
import { RuntimeToolDispatcher } from './runtime_tool_dispatcher.js';
import { extractToolResultEvents, producedFilesOf } from './tool_result_events.js';
import type { ToolResultMeta } from './context/cold_zone_pack.js';
import { buildToolMessageContent, extractToolResultImages } from './core_tools/image_payload.js';
import { createTranscriptRecorder, type RequestPrefixHashes, type TranscriptRecorder } from './transcript_store.js';

const LOOP_HEALTH_CHECK_TOOL_TURNS = 10;

/**
 * Injects a runtime note in the middle of a conversation.
 *
 * It must ride as a user message, never as a system message: strict chat templates
 * (observed on the vLLM/Qwen endpoint, "System message must be at the beginning."
 * -> HTTP 400) accept exactly one system message, and only at index 0. A second
 * system message fails the *next* model request and kills the whole run, which is
 * why every mid-run note goes through this helper.
 */
function pushRuntimeGuidance(messages: ChatCompletionMessageParam[], detail: string): void {
  messages.push({ role: 'user', content: detail });
}

/** How many leading messages describe the reusable request prefix. */
const PREFIX_PROBE_MESSAGES = 3;

/** 16 hex chars: long enough that a collision never explains a cache miss, short enough to read. */
function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Describe how a candidate compaction would rewrite the message at index 0, if it would.
 *
 * Returns `null` when the head is preserved byte-for-byte, otherwise a short reason for the
 * event detail. The system message is the first token of the provider's prefix, so this is
 * the one message a rewrite may never touch.
 */
function systemHeadDifference(
  current: ChatCompletionMessageParam[],
  next: ChatCompletionMessageParam[],
): string | null {
  const before = current[0] as { role?: unknown; content?: unknown } | undefined;
  const after = next[0] as { role?: unknown; content?: unknown } | undefined;
  if (!before) return null;
  if (!after) return 'the candidate has no leading message';
  if (after.role !== 'system') return `role changed from ${String(before.role)} to ${String(after.role)}`;
  if (before.role !== after.role) return `role changed from ${String(before.role)} to system`;
  if (before.content !== after.content) return 'the rendered prompt text differs';
  return null;
}

/**
 * Segment fingerprints of the request prefix, recorded with every model request.
 *
 * A provider prefix cache only matches from token 0, so two consecutive runs hit the cache
 * only when their leading bytes are identical. One hash cannot say *which* segment broke
 * it, so every segment a request is built from is hashed separately:
 *
 * `tools` is hashed on its own because the chat template renders tool declarations ahead
 * of the system message — a tool-set change therefore invalidates the entire prompt, and
 * a combined hash over messages would never have made that visible.
 */
function hashRequestPrefix(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[] | undefined,
): RequestPrefixHashes {
  const probe = messages.slice(0, PREFIX_PROBE_MESSAGES).map((message) => ({
    role: (message as { role?: unknown }).role,
    content: (message as { content?: unknown }).content,
  }));
  const all = messages.map((message) => ({
    role: (message as { role?: unknown }).role,
    content: (message as { content?: unknown }).content,
  }));
  return {
    tools: digest(tools ?? []),
    system: digest(all[0] ?? null),
    head: digest(probe),
    full: digest(all),
  };
}

function findFunctionToolDescription(tools: ChatCompletionTool[], toolName: string): string | undefined {
  for (const tool of tools) {
    if (tool.type === 'function' && tool.function.name === toolName) return tool.function.description;
  }
  return undefined;
}

export class AgentRuntime {
  constructor(private readonly manager = mcpManager) {}

  async *chat(request: AgentChatRequest): AsyncGenerator<AgentEvent> {
    const runInstanceId = crypto.randomUUID();
    let transcript: TranscriptRecorder | null = null;
    let terminal: { status: 'completed' | 'failed' | 'cancelled'; error?: string } = { status: 'failed', error: 'Run did not reach a terminal state.' };
    // Set once the message array exists; the finally block runs outside the try's block
    // scope, so the run-end budget report needs a handle it can call.
    let reportFinalBudget: (() => void) | null = null;
    try {
    transcript = createTranscriptRecorder(request.conversationId, request.runId, {
      agentId: request.agentId,
      roleId: request.roleId ?? null,
      parentConversationId: request.parentConversationId ?? null,
      parentRunId: request.parentRunId ?? null,
      delegationDepth: request.delegationDepth ?? null,
    });
    // Hand the handle to the caller so engine events it raises itself land in the same
    // sequence as the ones yielded from here. A single writer owns the log; this is a
    // handoff, not a second recorder.
    request.onTranscript?.(transcript);
    if (request.conversationId) subagentRuntime.registerParentRun(request.conversationId);
    const llm = getLLMClient(request.llm);
    const messages: ChatCompletionMessageParam[] = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    // Provenance for the prompt is hashed once per run: it is assembled once per run, so
    // every request in this run carries the same text and the same sections.
    const systemPromptProvenance = request.systemPrompt && request.systemPromptSections?.length
      ? {
          sha256: crypto.createHash('sha256').update(request.systemPrompt).digest('hex'),
          sections: request.systemPromptSections,
        }
      : undefined;

    for (const message of request.messages) {
      if (message.role === 'assistant') {
        // Replay assistant tool calls with their arguments: a `tool` row is only valid
        // directly after the assistant turn that asked for it.
        messages.push({
          role: 'assistant',
          content: (message.content ?? null) as any,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        } as any);
        continue;
      }
      if (message.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content } as any);
        continue;
      }
      messages.push({ role: 'user', content: message.content as any });
    }
    // Volatile per-run blocks go here, not into `messages[0]`: everything above this point
    // is the reusable prefix a provider can cache, so only these lines and the user message
    // are prefilled fresh on the first turn of a run.
    for (const block of request.pinnedTail || []) {
      if (block) messages.push({ role: 'user', content: block });
    }
    messages.push({ role: 'user', content: request.userMessage });

    let tools: ChatCompletionTool[] = [];
    let toolUseTurns = 0;
    let currentTurnIndex = 0;
    let currentRequestId = '';
    let contextWatermarkAnnounced = false;
    let runtimeCompactionAttempts = 0;
    const toolFailureTracker = new ToolFailureTracker();
    // What each call was and how it ended, keyed by tool-call id. The messages array holds
    // only role + content, so a compaction would otherwise see a `tool` message with no idea
    // which tool produced it, whether it failed, or where its full output was archived.
    const toolResultMeta = new Map<string, ToolResultMeta>();
    const loadedToolNames = new Set<string>();
    const mcpToolsByName = new Map<string, ChatCompletionTool>();
    let mcpServers: MCPConnectResult['serverCatalog'] = [];
    const result = await this.manager.connectServers(request.mcpServers);
    yield {
      type: 'mcp_status',
      connected: result.connected,
      failed: result.failed,
      disconnected: result.disconnected,
    };
    mcpServers = result.serverCatalog;
    for (const tool of result.tools as ChatCompletionTool[]) {
      const name = tool.type === 'function' ? tool.function.name : '';
      if (name) mcpToolsByName.set(name, tool);
    }

    const addTools = (nextTools: ChatCompletionTool[]): string[] => {
      const added: string[] = [];
      for (const tool of nextTools) {
        const name = tool.type === 'function' ? tool.function.name : '';
        if (!name) continue;
        if (loadedToolNames.has(name)) continue;
        tools.push(tool);
        loadedToolNames.add(name);
        added.push(name);
      }
      return added;
    };

    const pushToolResult = (toolCallId: string, toolName: string, modelContent: string | Array<Record<string, unknown>>, rawResult: string): AgentEvent | null => {
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: modelContent } as any);
      request.onContextMessage?.({ role: 'tool', content: modelContent, toolCallId, toolName });
      const failure = toolFailureTracker.record(toolName, rawResult);
      if (!failure.failed) {
        return null;
      }

      if (failure.shouldAbort) {
        throw new RepeatedToolFailureError(toolName, failure.failureCount);
      }
      if (!failure.shouldWarn) {
        return null;
      }

      const detail = `Tool ${toolName} has failed repeatedly. Do not retry the same action blindly; change strategy, ask the user for missing input, or explain the blocker if needed.`;
      pushRuntimeGuidance(messages, detail);
      return { type: 'loop_health', level: 'warning', reason: 'repeated_tool_failure', toolName, detail };
    };

    const finalizeToolResult = (
      toolCallId: string,
      toolName: string,
      result: string,
      execution?: { durationMs?: number; producedFiles?: string[]; arguments?: unknown },
    ): AgentEvent[] => {
      // Images are transported as tool-message content parts, not inside the JSON text:
      // keeping base64 out of the observation/transcript would otherwise blow up every
      // downstream consumer (file budgets, event previews, transcript storage).
      const imagePayload = extractToolResultImages(result);
      const textResult = imagePayload.warnings.length
        ? `${imagePayload.text}\n[image warnings: ${imagePayload.warnings.join('; ')}]`
        : imagePayload.text;
      const observation = createObservation({
        conversationId: request.conversationId,
        toolName,
        result: textResult,
      });
      const observationPayload = buildObservationPayload(observation);
      if (imagePayload.images.length) {
        observationPayload.imageCount = imagePayload.images.length;
      }
      const loadedCapability = getLoadedCapability(toolName, textResult);
      if (loadedCapability) {
        observationPayload.loadedCapability = loadedCapability;
      }
      const toolError = detectToolError(textResult);
      // The blob reference is deterministic (sha256 of the exact text), so it can be recorded
      // here even though the transcript writer owns the file: readers resolve the same path
      // from the same hash.
      const digest = crypto.createHash('sha256').update(Buffer.from(textResult, 'utf8')).digest('hex');
      toolResultMeta.set(toolCallId, {
        toolName,
        argsPreview: previewArguments(execution?.arguments),
        outcome: toolError === undefined ? 'unknown' : toolError ? 'error' : 'ok',
        producedFiles: execution?.producedFiles ? [...execution.producedFiles] : [],
        blobRef: `blobs/sha256-${digest}.txt`,
      });
      transcript?.recordToolResult({
        requestId: currentRequestId,
        turnIndex: currentTurnIndex,
        callId: toolCallId,
        toolName,
        rawResult: textResult,
        modelVisibleResult: observation.modelContent,
        observation: observationPayload,
        // Omitted when nothing executed (a denied approval), so the absence itself
        // distinguishes "did not run" from "ran quickly".
        ...(execution ? { durationMs: execution.durationMs, producedFiles: execution.producedFiles } : {}),
        ...(toolError === undefined ? {} : { isError: toolError }),
      });
      const events: AgentEvent[] = [{
        type: 'tool_call_result',
        tool_name: toolName,
        result: observation.eventPreview,
        observation: observationPayload,
        turnIndex: currentTurnIndex,
        planStepIndex: null,
      }];
      const toolMessageContent = buildToolMessageContent(observation.modelContent, imagePayload.images);
      const healthEvent = pushToolResult(toolCallId, toolName, toolMessageContent, textResult);
      if (healthEvent) events.push(healthEvent);
      if (observation.artifact) {
        events.push({
          type: 'workspace_artifact',
          artifact: {
            id: observation.artifact.id,
            title: observation.artifact.title,
            path: observation.artifact.path,
            type: observation.artifact.type,
          },
        });
      }
      return events;
    };

    // The same builder the context assembly prices, so the pre-run watermark and the
    // first real request cannot disagree about how much the tool schemas cost.
    addTools(buildResidentTools(request.mainAgent ? request.mainAgent.coreToolIds : undefined));
    // Re-declare the MCP tools this conversation installed in earlier runs, in their
    // original order. Tool declarations serialize ahead of every message, so an array that
    // shrinks back to the resident set at each run start invalidates the provider prefix
    // cache from token 0 on the first request of every run. Only tools still discovered on
    // this run's servers are restored; one that disappeared is simply not re-declared.
    if (request.conversationId) {
      const restored = readActivatedToolNames(request.conversationId)
        .map((name) => mcpToolsByName.get(name))
        .filter((tool): tool is ChatCompletionTool => Boolean(tool));
      if (restored.length) addTools(restored);
    }
    // Anything the model installs mid-run has to be remembered, or the next run starts
    // again from the resident set and pays the same full re-prefill.
    const installTools = (nextTools: ChatCompletionTool[]): string[] => {
      const added = addTools(nextTools);
      const installedMcp = added.filter((name) => mcpToolsByName.has(name));
      if (request.conversationId && installedMcp.length) {
        recordActivatedToolNames(request.conversationId, installedMcp);
      }
      return added;
    };
    // A system prompt rebuilt from disk can change between runs without any single request
    // looking different, and a change here invalidates the cached prefix of every
    // conversation that re-assembles it. Say so once, instead of leaving a cache drop to be
    // discovered as an unexplained slowdown.
    if (request.conversationId) {
      const systemHash = digest(messages[0] ?? null);
      const previousSystemHash = readSystemPromptHash(request.conversationId);
      if (!previousSystemHash) {
        recordSystemPromptHash(request.conversationId, systemHash);
      } else if (previousSystemHash !== systemHash) {
        recordSystemPromptHash(request.conversationId, systemHash);
        yield {
          type: 'loop_health',
          level: 'warning',
          reason: 'system_prompt_invalidated',
          detail: `The assembled system prompt changed since this conversation's previous run (${previousSystemHash} → ${systemHash}). Every request now begins with a different first token, so the provider prefix cache cannot be reused until the new prompt has been seen once.`,
        };
      }
    }
    const toolDispatcher = new RuntimeToolDispatcher({
      request,
      manager: this.manager,
      mcpToolsByName,
      mcpServers,
      addTools: installTools,
      runInstanceId,
      runId: request.runId ?? null,
    });
    const contextWindow = resolveContextWindow(request.llm);
    // One estimator for the loop body and for the final report: `tools` grows when
    // `toolload` installs an MCP schema, so the closure must read the current value.
    const estimateRuntimeBudget = () => estimateContextBudget({
      systemPrompt: '',
      messages: messages.map((message) => ({ ...message })) as unknown as Record<string, unknown>[],
      userMessage: '',
      contextWindowTokens: contextWindow.tokens,
      contextWindowSource: contextWindow.source,
      contextWindowReason: contextWindow.reason,
      maxOutputTokens: undefined,
      tools,
      calibrationMultiplier: getTokenUsageCalibration(request.llm),
    });
    reportFinalBudget = () => request.onRuntimeContext?.({ budget: estimateRuntimeBudget() });
    while (true) {
      throwIfAborted(request.abortSignal);
      // A finished child is delivered as a user message at the nearest step boundary: it
      // must ride as a user row (a second system message breaks strict chat templates),
      // and the same text is already durable in the transcript for later runs.
      if (request.conversationId) {
        for (const notice of subagentRuntime.drainNotices(request.conversationId)) {
          pushRuntimeGuidance(messages, notice);
        }
      }
      let sawToolCalls = false;
      let responseTruncated = false;
      let turnContent = '';
      currentTurnIndex += 1;
      let runtimeBudget = estimateRuntimeBudget();
      if (shouldCompactInRun(runtimeBudget, runtimeCompactionAttempts)) {
        runtimeCompactionAttempts += 1;
        yield {
          type: 'loop_health',
          level: 'info',
          reason: 'context_compaction_started',
          detail: `${formatBudgetStatus(runtimeBudget)}. Compacting cold history before the next model turn (attempt ${runtimeCompactionAttempts}/${MAX_RUNTIME_COMPACTIONS}).`,
        };
        const compacted = await compactRuntimeMessages({
          llm: request.llm,
          messages,
          contextWindowTokens: contextWindow.tokens,
          abortSignal: request.abortSignal,
          toolMeta: toolResultMeta,
          priorCheckpoint: request.priorCheckpoint ?? null,
        });
        if (compacted.compacted) {
          // Node 0 is the request prefix's first token. A compaction that rewrites it makes
          // every later request in the run differ from the first token, and any later run
          // that replays a different head pays the same penalty a second time. Refuse the
          // splice rather than silently trading the whole prefix for one checkpoint.
          const headChange = systemHeadDifference(messages, compacted.messages);
          if (headChange) {
            yield {
              type: 'loop_health',
              level: 'warning',
              reason: 'context_compaction_head_rewrite_blocked',
              detail: `Compaction would have rewritten the system message at index 0 (${headChange}), which invalidates the provider prefix cache from token 0. The splice was skipped.`,
            };
          } else {
            messages.splice(0, messages.length, ...compacted.messages);
            runtimeBudget = estimateRuntimeBudget();
            yield {
              type: 'loop_health',
              level: 'info',
              reason: 'context_compaction_completed',
              detail: formatBudgetStatus(runtimeBudget),
            };
            // Hand the structured summary to the caller now: at run end it can persist this
            // object instead of summarising the same history a second time.
            request.onRuntimeContext?.({ budget: runtimeBudget, summary: compacted.summary });
          }
        } else if (compacted.degraded) {
          // Nothing was replaced, so nothing was lost — but calling this "completed" would
          // hide a summariser that fails on every turn and leave the run limping toward the
          // hard watermark with the model none the wiser.
          yield {
            type: 'loop_health',
            level: 'warning',
            reason: 'context_compaction_failed',
            detail: `${formatBudgetStatus(runtimeBudget)}. Compaction failed (${compacted.degraded.reason}); the cold segment was kept verbatim, so no context was lost. The hard-watermark guard still applies to this turn.`,
          };
        }
      }
      if (runtimeBudget.softExceeded && !contextWatermarkAnnounced) {
        contextWatermarkAnnounced = true;
        yield {
          type: 'loop_health',
          level: runtimeBudget.hardExceeded ? 'warning' : 'info',
          reason: 'context_watermark_exceeded',
          detail: `${formatBudgetStatus(runtimeBudget)}. In-run compaction waits for the hard watermark; the durable checkpoint is written when the task finishes.`,
        };
      }
      if (runtimeBudget.hardExceeded) {
        const exhausted = runtimeCompactionAttempts >= MAX_RUNTIME_COMPACTIONS;
        const detail = [
          `${formatBudgetStatus(runtimeBudget)}.`,
          exhausted
            ? `In-run compaction budget exhausted (${runtimeCompactionAttempts}/${MAX_RUNTIME_COMPACTIONS}); no further compaction is attempted.`
            : '',
          'Hard context watermark exceeded. Finish from the available context now, avoid further tool calls, and keep the response concise.',
        ].filter(Boolean).join(' ');
        pushRuntimeGuidance(messages, detail);
        yield {
          type: 'loop_health',
          level: 'warning',
          reason: 'context_hard_watermark_guard',
          detail,
        };
      }
      yield { type: 'run_status', runId: request.runId || null, status: 'model_turn' };

      const toolsForTurn = runtimeBudget.hardExceeded ? undefined : tools.length ? tools : undefined;
      const maxTokensForTurn = resolveMaxOutputTokens(runtimeBudget);
      currentRequestId = crypto.randomUUID();
      transcript?.recordModelRequest({
        requestId: currentRequestId,
        turnIndex: currentTurnIndex,
        llm: request.llm,
        maxOutputTokens: maxTokensForTurn,
        messages,
        tools: toolsForTurn || null,
        // A tool-less request caused by the hard watermark is a degradation, not a
        // choice. Without this the transcript shows `tools: null` and cannot explain
        // why the model stopped using tools.
        ...(toolsForTurn?.length ? { toolChoice: 'auto' as const } : {}),
        ...(runtimeBudget.hardExceeded && tools.length
          ? { degradations: [{ kind: 'tools_dropped' as const, reason: 'context_hard_watermark' }] }
          : {}),
        budget: runtimeBudget,
        prefixHash: hashRequestPrefix(messages, toolsForTurn),
        ...(systemPromptProvenance ? { systemPrompt: systemPromptProvenance } : {}),
      });
      for await (const event of llm.chatStream(
        messages,
        toolsForTurn,
        request.abortSignal,
        maxTokensForTurn,
        (chunk) => transcript?.recordModelChunk(currentRequestId, chunk),
      )) {
        throwIfAborted(request.abortSignal);
        if (event.type === 'content') {
          turnContent += event.content;
          yield event;
        } else if (event.type === 'thinking') {
          // Reasoning is forwarded to the UI but deliberately kept out of `turnContent`:
          // that string becomes the assistant message and the next request's messages, and
          // a provider must never receive its own reasoning back as assistant content.
          yield event;
        } else if (event.type === 'truncated') {
          responseTruncated = true;
        } else if (event.type === 'usage') {
          const calibration = recordObservedPromptTokens(request.llm, runtimeBudget.heuristicTokenEstimate, event.promptTokens);
          const cachedPromptTokens = Number.isFinite(event.cachedPromptTokens) ? Number(event.cachedPromptTokens) : null;
          const detail = [
            `Provider usage observed: prompt_tokens=${event.promptTokens}, completion_tokens=${event.completionTokens ?? 'unknown'}, total_tokens=${event.totalTokens ?? 'unknown'}.`,
            cachedPromptTokens === null
              ? 'This endpoint reported no prefix-cache counters.'
              : `Prefix cache: cached_prompt_tokens=${cachedPromptTokens} (${Math.round((cachedPromptTokens / event.promptTokens) * 100)}% of prompt).`,
            `This turn's heuristic estimate was ${runtimeBudget.heuristicTokenEstimate}; subsequent turns for this endpoint and model will use calibration=${calibration.toFixed(3)}.`,
          ].join(' ');
          yield {
            type: 'loop_health',
            level: 'info',
            reason: 'token_usage_observed',
            detail,
            tokenUsage: {
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens ?? null,
              totalTokens: event.totalTokens ?? null,
              heuristicPromptTokens: runtimeBudget.heuristicTokenEstimate,
              calibrationMultiplier: calibration,
              cachedPromptTokens,
            },
          };
        } else if (event.type === 'tool_calls') {
          sawToolCalls = true;
          const toolCalls = event.tool_calls;
          transcript?.recordModelResponse({
            requestId: currentRequestId,
            turnIndex: currentTurnIndex,
            content: turnContent,
            toolCalls,
            finishReason: 'tool_calls',
          });
          messages.push({ role: 'assistant', content: turnContent || null, tool_calls: toolCalls } as any);
          request.onContextMessage?.({
            role: 'assistant',
            content: turnContent || null,
            toolCalls: toolCalls.map((call) => ({
              id: call.id,
              name: call.function?.name ?? '',
              arguments: call.function?.arguments ?? '{}',
            })),
          });
          yield { type: 'run_status', runId: request.runId || null, status: 'tool_execution' };

          if (toolCalls.length > 1 && toolCalls.every((toolCall) => isParallelizableCoreTool(toolCall.function?.name ?? ''))) {
            const parallelCalls = toolCalls.map((toolCall) => {
              const toolName = toolCall.function?.name ?? '';
              const rawArguments = toolCall.function?.arguments ?? '{}';
              const args = parseToolArguments(rawArguments);
              return { toolCall, toolName, rawArguments, args };
            });
            for (const item of parallelCalls) {
              transcript?.recordToolCall({
                requestId: currentRequestId,
                turnIndex: currentTurnIndex,
                callId: item.toolCall.id,
                toolName: item.toolName,
                rawArguments: item.rawArguments,
                parsedArguments: item.args,
              });
              yield {
                type: 'tool_call_start',
                tool_name: item.toolName,
                arguments: item.args,
                turnIndex: currentTurnIndex,
                planStepIndex: null,
              };
            }
            const parallelResults = await Promise.all(parallelCalls.map(async (item) => {
              const startedAt = Date.now();
              const result = await executeCoreTool(item.toolName, item.args, {
                conversationId: request.conversationId,
                runInstanceId,
                runId: request.runId ?? undefined,
                agent: request.mainAgent,
                abortSignal: request.abortSignal,
                projectPath: resolveConversationProjectPath(request.conversationId) ?? undefined,
                delegationDepth: request.delegationDepth ?? 0,
              });
              return { ...item, result, durationMs: Date.now() - startedAt };
            }));
            for (const item of parallelResults) {
              const resultEvents = extractToolResultEvents(item.result);
              for (const resultEvent of resultEvents) yield resultEvent;
              for (const finalEvent of finalizeToolResult(item.toolCall.id, item.toolName, item.result, {
                durationMs: item.durationMs,
                producedFiles: producedFilesOf(item.result),
                arguments: item.args,
              })) yield finalEvent;
            }
            continue;
          }

          for (const toolCall of toolCalls) {
            throwIfAborted(request.abortSignal);
            const toolName = toolCall.function?.name ?? '';
            const rawArguments = toolCall.function?.arguments ?? '{}';
            const args = parseToolArguments(rawArguments);
            transcript?.recordToolCall({
              requestId: currentRequestId,
              turnIndex: currentTurnIndex,
              callId: toolCall.id,
              toolName,
              rawArguments,
              parsedArguments: args,
            });

            const security = await assessRuntimeToolSecurity(request, toolName, args, findFunctionToolDescription(tools, toolName));
            if (security.decision === 'ask' && request.approvalPolicy === 'never') {
              // A delegated child has no approval UI. Waiting would stall the child for the
              // store's ten-minute timeout, so fail closed with a stable, actionable error.
              const denied = JSON.stringify({
                ok: false,
                error: {
                  code: 'approval_unavailable',
                  message: 'This action needs user approval, but a delegated subagent cannot request approval. Use a non-interactive alternative, or leave this step to the parent agent.',
                },
                security: { mode: normalizeSecurityMode(request.securityMode), risk: security.risk, reason: security.reason },
              });
              for (const finalEvent of finalizeToolResult(toolCall.id, toolName, denied, { arguments: args })) yield finalEvent;
              continue;
            }
            if (security.decision === 'ask') {
              const pendingApproval = securityApprovalStore.create({
                runId: request.runId || null,
                conversationId: request.conversationId || null,
                toolName,
                arguments: args,
                mode: normalizeSecurityMode(request.securityMode),
                risk: security.risk,
                reason: security.reason,
              }, request.abortSignal);
              yield {
                type: 'security_approval_request',
                approvalId: pendingApproval.request.id,
                runId: request.runId || null,
                toolName,
                arguments: args,
                mode: pendingApproval.request.mode,
                risk: security.risk,
                reason: security.reason,
              };
              let approvalDecision: 'approve' | 'deny';
              try {
                approvalDecision = await pendingApproval.wait;
              } catch (err) {
                throwIfAborted(request.abortSignal);
                approvalDecision = 'deny';
              }
              yield { type: 'security_approval_result', approvalId: pendingApproval.request.id, decision: approvalDecision };
              if (approvalDecision === 'deny') {
                const result = JSON.stringify({
                  ok: false,
                  error: 'Operation was not approved by the user.',
                  security: { mode: pendingApproval.request.mode, risk: security.risk, reason: security.reason },
                });
                for (const finalEvent of finalizeToolResult(toolCall.id, toolName, result, { arguments: args })) yield finalEvent;
                continue;
              }
            }

            yield { type: 'tool_call_start', tool_name: toolName, arguments: args, turnIndex: currentTurnIndex, planStepIndex: null };

            const dispatchStartedAt = Date.now();
            const dispatched = await toolDispatcher.execute(toolName, args);
            // Measured around the tool body only: the security assessment and any
            // approval wait above are not execution time.
            const dispatchDurationMs = Date.now() - dispatchStartedAt;
            for (const event of dispatched.events) yield event;
            for (const finalEvent of finalizeToolResult(toolCall.id, toolName, dispatched.result, {
              durationMs: dispatchDurationMs,
              producedFiles: producedFilesOf(dispatched.result),
              arguments: args,
            })) yield finalEvent;
          }
        }
      }

      if (responseTruncated) {
        transcript?.recordModelResponse({
          requestId: currentRequestId,
          turnIndex: currentTurnIndex,
          content: turnContent,
          toolCalls: [],
          finishReason: 'length',
        });
        const detail = 'The previous model response hit its output-length limit. Its entire tool-call batch was discarded and nothing was executed. Continue with a shorter, complete response; if tools are needed, emit complete tool arguments.';
        pushRuntimeGuidance(messages, detail);
        yield {
          type: 'loop_health',
          level: 'warning',
          reason: 'model_response_truncated',
          detail,
          discardedContentChars: turnContent.length,
        };
        continue;
      }
      if (!sawToolCalls) {
        transcript?.recordModelResponse({
          requestId: currentRequestId,
          turnIndex: currentTurnIndex,
          content: turnContent,
          toolCalls: [],
          finishReason: 'stop',
        });
        if (turnContent.trim()) {
          messages.push({ role: 'assistant', content: turnContent });
          request.onContextMessage?.({ role: 'assistant', content: turnContent, toolCalls: null });
        }
        terminal = { status: 'completed' };
        yield { type: 'done' };
        return;
      }
      toolUseTurns += 1;
      if (toolUseTurns % LOOP_HEALTH_CHECK_TOOL_TURNS === 0) {
        const detail = `The run has completed ${toolUseTurns} tool-use turns without a hard turn cap. Reassess progress, avoid repeating failed actions, and decide whether to continue, change strategy, ask the user, or finish.`;
        pushRuntimeGuidance(messages, detail);
        yield { type: 'loop_health', level: 'info', reason: 'checkpoint', detail };
      }
    }
    } catch (error) {
      terminal = request.abortSignal?.aborted
        ? { status: 'cancelled', error: 'Run cancelled by user.' }
        : { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      // The last per-turn budget is measured before that turn's output exists, so the
      // run-end checkpoint decision needs one measurement of the array as it ends.
      try {
        reportFinalBudget?.();
      } catch {
        // A reporting callback must never turn a finished run into a failed one.
      }
      transcript?.end(terminal.status, terminal.error);
      if (request.conversationId) subagentRuntime.unregisterParentRun(request.conversationId);
    }
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getLoadedCapability(toolName: string, result: string): { kind: 'coretool' | 'mcp' | 'skill'; id: string } | null {
  if (toolName !== TOOLLOAD_TOOL_NAME) return null;
  const parsed = parseToolArguments(result);
  if (!parsed.ok) return null;
  switch (parsed.action) {
    case 'skill':
      return typeof parsed.skillId === 'string' ? { kind: 'skill', id: parsed.skillId } : null;
    case 'mcp_tool':
      return typeof parsed.id === 'string' ? { kind: 'mcp', id: parsed.id } : null;
    case 'mcp_resource':
      return typeof parsed.uri === 'string' ? { kind: 'mcp', id: parsed.uri } : null;
    default:
      // directory_catalog and resource listings load no content of their own.
      return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AgentRunCancelledError();
}

export class AgentRunCancelledError extends Error {
  constructor() {
    super('Run cancelled by user.');
    this.name = 'AgentRunCancelledError';
  }
}

/**
 * Tools signal failure with `ok: false`. Anything else — a payload without the field,
 * or text that is not JSON at all — leaves the outcome unstated, and an unstated
 * outcome is recorded as absent rather than guessed at.
 */
function detectToolError(result: string): boolean | undefined {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const ok = (parsed as { ok?: unknown }).ok;
    if (ok === false) return true;
    if (ok === true) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

export const agentRuntime = new AgentRuntime();

/** Arguments as one short line, for the cold-zone metadata of a tool result. */
function previewArguments(args: unknown): string {
  if (args === undefined || args === null) return '';
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  if (!text || text === '{}') return '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
