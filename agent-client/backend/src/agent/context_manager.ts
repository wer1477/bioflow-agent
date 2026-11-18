import crypto from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getLLMClient } from './llm_client.js';
import type { AgentChatMessage, LLMConfig } from './types.js';
import { IMAGE_TOKEN_ESTIMATE, countMessageImages, stripImageParts } from './core_tools/image_payload.js';
import type { AgentRuntimeContext } from './service/agent_context_resolver.js';
import type { Message } from './config/conversation_types.js';
import * as contextStore from './config/context_store.js';
import { resolveContextWindow, type ContextWindowSource } from './context_window.js';
import { buildResidentTools } from './resident_tools.js';
import {
  DEFAULT_COLD_ZONE_POLICY,
  firstSentence,
  messageText,
  planColdZone,
  resolveTailTokenLimit,
  splitColdZone,
  type ColdZoneGroup,
  type ColdZonePlan,
  type ColdZonePolicy,
} from './context/cold_zone.js';
import { buildBiodColdZoneScorer } from './biod/context_scorer.js';
import {
  packChatMessages,
  packStoredMessages,
  type ChatLikeMessage,
  type StoredLikeMessage,
  type ToolResultMeta,
} from './context/cold_zone_pack.js';

const MIN_RESERVED_OUTPUT_TOKENS = 8_000;
/** Floor for the proportional reserve, so a tiny window still leaves room to answer. */
const MIN_OUTPUT_RESERVE_TOKENS = 1_024;
const OUTPUT_RESERVE_RATIO = 0.2;
const SOFT_WATERMARK = 0.6;
const HARD_WATERMARK = 0.8;
/**
 * Cold-zone routing policy.
 *
 * Kept in code rather than in a config file: every value here is a ratio of the window or a
 * cap on one request, and changing one without the others silently breaks the balance (a
 * large verbatim quota next to a 3k summary is the failure this policy exists to prevent).
 * Reviewing them together, in one diff, is the point.
 */
export const CONTEXT_POLICY: ColdZonePolicy = DEFAULT_COLD_ZONE_POLICY;
/**
 * Upper bound on in-run compaction attempts for one run.
 *
 * Compaction is not free: every attempt rewrites `messages[1..]` and spends one
 * summariser call. Without a cap, a run that keeps growing can cycle
 * "cross the hard watermark → compact → grow → compact" indefinitely, because the
 * runtime has no turn limit of its own. The cap is what turns that loop into a
 * bounded worst case; past it the hard-watermark guard stops the run instead.
 *
 * Attempts, not successes, are counted: a summariser that fails every turn would
 * otherwise be retried on every turn of the run, paying a call each time.
 */
export const MAX_RUNTIME_COMPACTIONS = 3;
/**
 * How much condensed cold-zone text one summariser call may read.
 *
 * Not a cap on coverage: a larger zone is split into several calls, each refining the
 * previous summary, so the whole zone is always represented. The number only keeps a
 * single prompt (and therefore one call's latency and price) bounded.
 */
const SUMMARY_SOURCE_CHUNK_TOKENS = 8_000;
/**
 * One summary schema for both compaction paths.
 *
 * The runtime checkpoint and the conversation checkpoint used to be two different
 * artefacts — free text and strict JSON — produced by two prompts that asked for
 * different things. That made it impossible to keep the runtime summary and reuse it
 * when the run ended: the run-end path had to summarise the same history again to get
 * JSON. With a single schema the object produced mid-run is already the object the next
 * run needs, and only its rendering differs.
 */
const SUMMARY_JSON_SCHEMA = {
  schemaVersion: 1,
  taskState: {
    userGoal: '',
    currentStatus: 'in_progress|done|blocked',
    latestUserInstruction: '',
    openQuestions: [],
  },
  decisions: [{ decision: '', reason: '', supersedes: [] }],
  stableFacts: [{ fact: '', source: 'user|tool|file|assistant', confidence: 'high|medium|low' }],
  completedActions: [],
  pendingActions: [],
  discardedContext: {
    loadedSkills: [],
    loadedTools: [],
    loadedMcpTools: [],
    fullFilesRemoved: [],
  },
  continuationPrompt: '',
};
const REQUEST_OVERHEAD_TOKENS = 12;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_OVERHEAD_TOKENS = 12;
const TOKEN_USAGE_OBSERVATION_LIMIT = 24;
const tokenUsageRatios = new Map<string, number[]>();

export interface ContextBudgetBreakdown {
  system: number;
  messages: number;
  user: number;
  tools: number;
  overhead: number;
  reservedOutput: number;
}

/**
 * What `breakdown.tools` measured.
 *
 * `resident` is the set installed before the first turn (the core tools);
 * `request` is the exact `tools` array of a concrete request, which grows when `toolload`
 * adds MCP schemas. Reported so a budget can be compared with another without guessing
 * which list it counted.
 */
export type ContextToolsScope = 'resident' | 'request';

export interface ContextBudgetStatus {
  /** Raw character-based estimate before calibration against provider usage. */
  heuristicTokenEstimate: number;
  tokenEstimate: number;
  calibrationMultiplier: number;
  contextLimit: number;
  contextWindowTokens: number;
  contextWindowSource: ContextWindowSource;
  contextWindowReason: string;
  toolsScope?: ContextToolsScope;
  ratio: number;
  softExceeded: boolean;
  hardExceeded: boolean;
  breakdown: ContextBudgetBreakdown;
}

/** A provider message as it will be serialized for the chat-completions API. */
export type ContextBudgetMessage = Record<string, unknown>;

export interface ManagedHistory {
  messages: AgentChatMessage[];
  checkpoint: contextStore.ContextCheckpoint | null;
  /**
   * Set when a stored checkpoint exists but was deliberately not injected because the
   * pinned context it summarised under no longer matches this request.
   *
   * Reported instead of carried silently: a discarded summary is the difference between
   * "the model forgot" and "the model was never told", and only this field distinguishes them.
   */
  discardedCheckpoint?: { id: string; reason: 'pinned_context_changed' };
  budget: ContextBudgetStatus;
}

/**
 * Whether the runtime should compact before its next model turn.
 *
 * Two watermarks, two different jobs:
 *
 * - **Soft (0.6)** marks the run for a checkpoint after it finishes. Compaction is
 *   deliberately *not* started here: it rewrites `messages[1..]`, and a provider's
 *   prefix cache matches only from token 0, so every rewrite invalidates the whole
 *   prefix for the rest of the run. With 40% of the window still free there is
 *   nothing to buy.
 * - **Hard (0.8)** is where continuing without the rewrite is no longer possible,
 *   so that is where the compaction and its cache cost belong.
 *
 * `attempts` is the number of compactions already tried in this run, successful or
 * not.
 */
export function shouldCompactInRun(
  status: Pick<ContextBudgetStatus, 'hardExceeded'>,
  attempts: number,
): boolean {
  return status.hardExceeded && attempts < MAX_RUNTIME_COMPACTIONS;
}

/**
 * What the run-end checkpoint should do.
 *
 * - `reuse`: the run already compacted and ended below the soft watermark. The summary
 *   exists and persisting it costs nothing, so skipping it would throw away the only
 *   record of the region the next assembly is about to drop.
 * - `summarise`: there is no summary yet (the run ended above the soft watermark without
 *   compacting), or the run kept growing after compacting (`priorSummary` is carried into
 *   the prompt so the second call refines rather than restarts).
 * - `skip`: short run, nothing to persist.
 */
export type RunEndCompactionPlan = { action: 'skip' | 'reuse' | 'summarise' };

export function planRunEndCompaction({
  runtimeSummary,
  aboveSoftWatermark,
}: {
  runtimeSummary?: Record<string, unknown>;
  aboveSoftWatermark: boolean;
}): RunEndCompactionPlan {
  if (runtimeSummary) return { action: aboveSoftWatermark ? 'summarise' : 'reuse' };
  return { action: aboveSoftWatermark ? 'summarise' : 'skip' };
}

export class RuntimeContextManager {
  buildManagedHistory({
    conversationId,
    history,
    context,
    userMessage,
  }: {
    conversationId?: string;
    history: AgentChatMessage[];
    context: AgentRuntimeContext;
    userMessage: string;
  }): ManagedHistory {
    const latestCheckpoint = conversationId ? contextStore.getLatestContextCheckpoint(conversationId) : null;
    // A checkpoint is a summary of what *this* agent, prompt and tool set were doing.
    // Applying one written under a different pinned context would hand the model a
    // confident summary of someone else's run, so the fingerprint decides injection.
    const checkpoint = latestCheckpoint && checkpointMatchesContext(latestCheckpoint, context)
      ? latestCheckpoint
      : null;
    const discardedCheckpoint = latestCheckpoint && !checkpoint
      ? { id: latestCheckpoint.id, reason: 'pinned_context_changed' as const }
      : undefined;
    const contextWindow = resolveContextWindow(context.llm);
    // Every recorded message is sent.
    //
    // This used to be a sliding window of `min(20k, 0.25W)` tokens, truncated unconditionally.
    // That made the watermarks below decorative: below a ~80k window the request never came
    // close to 0.6, so history was dropped on every turn while a checkpoint was never written.
    // Dropping now belongs to the compaction step alone and happens only once the budget is
    // actually exceeded.
    //
    // A checkpoint is deliberately *not* prepended: with the full history in the request, an
    // extra summary message would send the same content twice and pay for both. It travels to
    // the runtime as `priorCheckpoint` instead, so a compaction reuses it rather than starting
    // from nothing.
    const messages: AgentChatMessage[] = history.map((item) => ({
      role: item.role,
      content: item.content,
      ...(item.toolCalls?.length ? { toolCalls: item.toolCalls } : {}),
      ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    }));
    const budget = estimateContextBudget({
      systemPrompt: context.systemPrompt,
      messages: messages as unknown as Record<string, unknown>[],
      userMessage,
      contextWindowTokens: contextWindow.tokens,
      contextWindowSource: contextWindow.source,
      contextWindowReason: contextWindow.reason,
      maxOutputTokens: undefined,
      // Priced, not ignored: these are the schemas the runtime installs before its first
      // turn. Leaving them out made the reported ratio ~3–4k tokens optimistic, which is
      // exactly the margin the watermarks are supposed to measure.
      tools: buildResidentTools(context.coreTools.map((tool) => tool.id)),
      toolsScope: 'resident',
      calibrationMultiplier: getTokenUsageCalibration(context.llm),
    });

    return { messages, checkpoint, ...(discardedCheckpoint ? { discardedCheckpoint } : {}), budget };
  }

  shouldCompressAfterRun(status: Pick<ContextBudgetStatus, 'softExceeded'>): boolean {
    return status.softExceeded;
  }

  /**
   * Persist a checkpoint from an already-written summary.
   *
   * Used when the run compacted mid-run: that summary is already in the checkpoint
   * schema, and the only thing missing is the deterministic `programState`.
   */
  saveCheckpoint({
    conversationId,
    runId,
    context,
    messages,
    budget,
    triggerReason,
    modelSummary,
    programState,
  }: {
    conversationId: string;
    runId?: string | null;
    context: AgentRuntimeContext;
    messages: Message[];
    budget: Pick<ContextBudgetStatus, 'tokenEstimate' | 'ratio'>;
    triggerReason: string;
    modelSummary: Record<string, unknown>;
    programState?: Record<string, unknown>;
  }): contextStore.ContextCheckpoint {
    return contextStore.createContextCheckpoint({
      conversationId,
      runId,
      triggerReason,
      tokenEstimate: budget.tokenEstimate,
      watermarkRatio: budget.ratio,
      pinnedFingerprint: fingerprintPinnedContext(context),
      programState: programState ?? buildProgramState(context, messages),
      modelSummary,
    });
  }

  async compactAfterRun({
    conversationId,
    runId,
    context,
    messages,
    runMessages,
    budget,
    triggerReason,
    priorSummary,
    abortSignal,
  }: {
    conversationId: string;
    runId?: string | null;
    context: AgentRuntimeContext;
    /**
     * Model transcript rows to summarise — the history the next request would replay.
     *
     * Kept separate from `runMessages` because the mechanical program state is derived
     * from the chat record's run metadata (`toolCalls.run.events`), which the transcript
     * rows do not carry.
     */
    messages: Pick<Message, 'role' | 'content'>[];
    runMessages?: Message[];
    budget: Pick<ContextBudgetStatus, 'tokenEstimate' | 'ratio' | 'contextWindowTokens'>;
    triggerReason: string;
    /** Summary already produced by an in-run compaction; carried forward, not ignored. */
    priorSummary?: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }): Promise<{ checkpoint: contextStore.ContextCheckpoint; degraded?: { reason: string } }> {
    const storedPrior = contextStore.getLatestContextCheckpoint(conversationId);
    const priorCheckpoint = priorSummary
      ? { programState: storedPrior?.programState ?? {}, modelSummary: priorSummary }
      : storedPrior;
    const programState = buildProgramState(context, runMessages ?? (messages as unknown as Message[]));
    // Same triage as the runtime path, over stored messages instead of live ones. The zone
    // is only the part the next assembly would stop sending; the tail is re-sent verbatim
    // anyway, so summarising it would describe content that is still in the request.
    const { cold } = splitColdZone(
      messages,
      resolveTailTokenLimit(budget.contextWindowTokens),
      estimateTextTokens,
      estimateMessageTokens,
    );
    const groups = packStoredMessages(cold as unknown as StoredLikeMessage[], { estimateTokens: estimateTextTokens });
    // The cold-zone ranker is the only learned decision in this path. It never decides what
    // is *kept* mechanically: quotas, evidence lines and the threshold are unchanged, and a
    // failed call falls back to the deterministic prior inside the scorer.
    const taskText = String(programState.latestUserPrompt || lastUserText(messages) || '');
    const scorer = await buildBiodColdZoneScorer(groups, taskText);
    const plan = planColdZone(groups, {
      contextWindowTokens: budget.contextWindowTokens,
      estimateTokens: estimateTextTokens,
      // No request is being built, so `keep`/`evidence` would name a destination nothing
      // reads. Everything above the threshold goes to the summariser, which is what makes
      // the checkpoint cover the whole zone instead of just its prose half.
      mode: 'checkpoint',
      ...(scorer ? { scorer } : {}),
    });
    const summary = await summariseColdZone({
      llm: context.llm,
      plan,
      programState,
      priorCheckpoint,
      abortSignal,
    });

    // The checkpoint is saved either way: `programState` is deterministic and still
    // correct, so a degraded summary is worth keeping — but it must not be reported as a
    // clean compaction, or a systematically failing summariser stays invisible.
    const modelSummary = summary.ok
      ? withArchiveIndex(summary.summary, plan.archiveIndex)
      : withArchiveIndex(fallbackSummary(programState), plan.archiveIndex);
    const checkpoint = this.saveCheckpoint({
      conversationId,
      runId,
      context,
      messages: runMessages ?? (messages as unknown as Message[]),
      budget,
      triggerReason,
      modelSummary,
      programState,
    });
    return {
      checkpoint,
      ...(summary.ok ? {} : { degraded: { reason: summary.reason } }),
    };
  }
}

export function estimateContextBudget({
  systemPrompt,
  messages,
  userMessage,
  contextWindowTokens,
  contextWindowSource,
  contextWindowReason,
  maxOutputTokens,
  tools,
  toolsScope,
  calibrationMultiplier,
}: {
  systemPrompt: string;
  messages: ContextBudgetMessage[];
  userMessage: string;
  contextWindowTokens: number;
  contextWindowSource?: ContextWindowSource;
  contextWindowReason?: string;
  maxOutputTokens?: number;
  tools?: unknown[];
  /** Defaults to `request`: a caller pricing a concrete turn prices that turn's tools. */
  toolsScope?: ContextToolsScope;
  calibrationMultiplier?: number;
}): ContextBudgetStatus {
  const system = estimateTextTokens(systemPrompt);
  const user = estimateTextTokens(userMessage) + (userMessage ? MESSAGE_OVERHEAD_TOKENS : 0);
  // Count the whole serialized message rather than only `content`.  In
  // particular, assistant tool calls carry their arguments outside content.
  // Image parts are replaced first: a base64 data URL is not text and would
  // otherwise make one screenshot look like a million-token conversation.
  const textOnlyMessages = stripImageParts(messages, '[image]');
  const messageTokens = textOnlyMessages.reduce((total, message) => (
    total + MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message)
  ), 0) + countMessageImages(messages) * IMAGE_TOKEN_ESTIMATE;
  const toolsTokens = estimateToolsTokens(tools || []);
  const overhead = REQUEST_OVERHEAD_TOKENS;
  const heuristicTokenEstimate = system + user + messageTokens + toolsTokens + overhead;
  const suppliedMultiplier = Number(calibrationMultiplier);
  const multiplier = Math.max(1, Number.isFinite(suppliedMultiplier) ? suppliedMultiplier : 1);
  const tokenEstimate = Math.ceil(heuristicTokenEstimate * multiplier);
  const reservedOutput = resolveReservedOutputTokens(contextWindowTokens, maxOutputTokens);
  const contextLimit = Math.max(1, contextWindowTokens - reservedOutput);
  const ratio = tokenEstimate / contextLimit;
  return {
    heuristicTokenEstimate,
    tokenEstimate,
    calibrationMultiplier: multiplier,
    contextLimit,
    contextWindowTokens,
    contextWindowSource: contextWindowSource || 'configured',
    contextWindowReason: contextWindowReason || 'llm.json contextWindowTokens',
    toolsScope: toolsScope || 'request',
    ratio,
    softExceeded: ratio >= SOFT_WATERMARK,
    hardExceeded: ratio >= HARD_WATERMARK,
    breakdown: {
      system,
      messages: messageTokens,
      user,
      tools: toolsTokens,
      overhead,
      reservedOutput,
    },
  };
}

/**
 * Cap generated tokens to what the current request can still fit.  Providers
 * enforce input + output against the same context window, so reserving output
 * only in a local ratio calculation is insufficient.
 */
export function resolveMaxOutputTokens(
  status: Pick<ContextBudgetStatus, 'tokenEstimate' | 'contextWindowTokens'>,
  configuredMaxTokens?: number,
): number {
  const configured = Number(configuredMaxTokens);
  const requested = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : MIN_RESERVED_OUTPUT_TOKENS;
  const safetyMargin = Math.max(256, Math.floor(status.contextWindowTokens * 0.02));
  const remaining = status.contextWindowTokens - status.tokenEstimate - safetyMargin;
  return Math.max(1, Math.min(requested, remaining));
}

export interface CompactionOutcome {
  /** The messages to send next. Identical to the input whenever nothing was compacted. */
  messages: ChatCompletionMessageParam[];
  compacted: boolean;
  /**
   * Set when compaction was attempted and produced nothing usable.
   *
   * The cold segment is then kept verbatim: replacing real history with an apology loses
   * information *and* reports success for a no-op. The hard watermark still forces the run
   * to converge, so a failed compaction degrades cost, never correctness.
   */
  degraded?: { reason: string };
  /**
   * The structured summary this compaction produced, already in the checkpoint schema.
   *
   * Carried out of the runtime so the service can persist it at run end instead of
   * summarising the same history a second time.
   */
  summary?: Record<string, unknown>;
  /** Archive index lines for groups that left the context; already merged into `summary`. */
  archiveIndex?: string[];
}

export async function compactRuntimeMessages({
  llm,
  messages,
  contextWindowTokens,
  abortSignal,
  toolMeta,
  priorCheckpoint,
}: {
  llm: LLMConfig;
  messages: ChatCompletionMessageParam[];
  contextWindowTokens: number;
  abortSignal?: AbortSignal;
  /** Result metadata the runtime collected as tools returned; absent for replayed history. */
  toolMeta?: Map<string, ToolResultMeta>;
  /** Summary from a previous run: a compaction refines it instead of starting over. */
  priorCheckpoint?: Pick<contextStore.ContextCheckpoint, 'programState' | 'modelSummary'> | null;
}): Promise<CompactionOutcome> {
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === 'system') firstNonSystem += 1;
  const pinned = messages.slice(0, firstNonSystem);
  const mutable = messages.slice(firstNonSystem);
  if (mutable.length < 2) return { messages, compacted: false };

  const { cold, tail } = splitColdZone(
    mutable as unknown as ChatLikeMessage[],
    resolveTailTokenLimit(contextWindowTokens),
    estimateTextTokens,
    estimateMessageTokens,
  );
  if (!cold.length) return { messages, compacted: false };

  // The per-run runtime blocks (date, artifact map) sit near the end of the request but can
  // drift into the cold segment on a long run. Summarising them would paraphrase facts the
  // model must treat as exact, so they are lifted out and re-anchored after the summary.
  const { rest: coldMessages, preserved } = extractPinnedRuntimeBlocks(cold);
  if (!coldMessages.length) return { messages, compacted: false };

  const groups = packChatMessages(coldMessages, {
    meta: toolMeta,
    estimateTokens: estimateTextTokens,
    estimateMessage: estimateMessageTokens,
  });
  const taskText = lastUserText(coldMessages) || lastUserText(mutable);
  const scorer = await buildBiodColdZoneScorer(groups, taskText);
  const plan = planColdZone(groups, {
    contextWindowTokens,
    estimateTokens: estimateTextTokens,
    ...(scorer ? { scorer } : {}),
  });
  const summary = await summariseColdZone({
    llm,
    plan,
    programState: {},
    priorCheckpoint: priorCheckpoint || null,
    abortSignal,
  });
  if (!summary.ok) return { messages, compacted: false, degraded: { reason: summary.reason } };

  const checkpoint: ChatCompletionMessageParam = {
    role: 'assistant',
    content: formatRuntimeSummary(summary.summary, plan.archiveIndex),
  };
  return {
    messages: [
      ...pinned,
      checkpoint,
      ...renderKeptGroups(plan),
      ...(preserved as unknown as ChatCompletionMessageParam[]),
      ...(tail as unknown as ChatCompletionMessageParam[]),
    ],
    compacted: true,
    summary: withArchiveIndex(summary.summary, plan.archiveIndex),
    archiveIndex: plan.archiveIndex,
  };
}

/** Opening tags of the blocks `buildPinnedTail` injects before the user message. */
export const PINNED_RUNTIME_MARKERS = ['<runtime_context_snapshot>', '<recent_project_artifacts>'] as const;

/**
 * Splits the pinned runtime blocks out of a message segment.
 *
 * Only the last copy of each marker survives: a run injects one of each, and repeated
 * compactions must not accumulate copies. Order is preserved so the model still reads the
 * snapshot before the artifact map.
 */
export function extractPinnedRuntimeBlocks<T>(
  messages: readonly T[],
): { rest: T[]; preserved: T[] } {
  const rest: T[] = [];
  // Keyed by marker so a second compaction cannot stack another copy of the same block.
  const latestByMarker = new Map<string, T>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    const text = typeof content === 'string' ? content : '';
    const marker = PINNED_RUNTIME_MARKERS.find((candidate) => text.includes(candidate));
    if (marker) latestByMarker.set(marker, message);
    else rest.push(message);
  }
  const preserved = PINNED_RUNTIME_MARKERS
    .map((marker) => latestByMarker.get(marker))
    .filter((message): message is T => Boolean(message));
  return { rest, preserved };
}

/**
 * Write the kept groups back into the request, in their original order.
 *
 * `evidence` groups become one synthetic message carrying only the exact lines; a synthetic
 * block is honest about what it is, and the alternative — keeping an assistant message whose
 * tool results were removed — is a structurally invalid request.
 */
function renderKeptGroups(plan: ColdZonePlan<unknown>): ChatCompletionMessageParam[] {
  const rendered: ChatCompletionMessageParam[] = [];
  for (const group of plan.kept as ColdZoneGroup<ChatLikeMessage>[]) {
    if (group.render === 'first-line') {
      rendered.push({ role: 'user', content: `[#${group.seq}] ${firstSentence(group.text)}` } as ChatCompletionMessageParam);
      continue;
    }
    if (group.render === 'evidence') {
      if (!group.evidenceLines.length) continue;
      rendered.push({
        role: 'assistant',
        content: [
          `<kept_evidence group="${group.seq}">`,
          ...group.evidenceLines.map((line) => `- ${line}`),
          '</kept_evidence>',
        ].join('\n'),
      } as ChatCompletionMessageParam);
      continue;
    }
    rendered.push(...(group.messages as unknown as ChatCompletionMessageParam[]));
  }
  return rendered;
}

/**
 * Summarise whatever the plan handed to the summariser.
 *
 * Coverage is the whole zone, but a single call does not need to see all of it: the source
 * is split into chunks that fit one prompt, and each call refines the previous summary. That
 * keeps the cost linear in the zone size instead of quadratic, and it means a zone twice the
 * chunk size is still represented completely rather than truncated to the newest part.
 */
async function summariseColdZone({
  llm,
  plan,
  programState,
  priorCheckpoint,
  abortSignal,
}: {
  llm: LLMConfig;
  plan: ColdZonePlan<unknown>;
  programState: Record<string, unknown>;
  priorCheckpoint: Pick<contextStore.ContextCheckpoint, 'programState' | 'modelSummary'> | null;
  abortSignal?: AbortSignal;
}): Promise<{ ok: true; summary: Record<string, unknown> } | { ok: false; reason: string }> {
  const chunks = buildSummaryChunks(plan.summarised);
  let previous: Record<string, unknown> | null = (priorCheckpoint?.modelSummary as Record<string, unknown> | undefined) ?? null;
  if (!chunks.length) {
    // Everything was kept or archived: no paraphrase is needed, but the checkpoint still
    // carries the program state and the archive index, and it costs no model call.
    return { ok: true, summary: previous ?? fallbackSummary(programState) };
  }
  for (const chunk of chunks) {
    const result = await callSummariser({ llm, chunk, programState, previous, abortSignal });
    if (!result.ok) return result;
    previous = result.summary;
  }
  return { ok: true, summary: previous ?? fallbackSummary(programState) };
}

function buildSummaryChunks(groups: ColdZoneGroup<unknown>[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const group of groups) {
    const serialized = JSON.stringify({ seq: group.seq, kind: group.kind, text: group.summaryText });
    const size = MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(serialized);
    if (current.length && used + size > SUMMARY_SOURCE_CHUNK_TOKENS) {
      chunks.push(current.join('\n'));
      current = [];
      used = 0;
    }
    current.push(serialized);
    used += size;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * One summariser call: the shared JSON schema, the prior summary, and one chunk of the zone.
 *
 * A reply that is not the requested JSON is a failure, not a degraded success: the object is
 * reused as the run's checkpoint, so a free-text reply would have to be re-summarised later
 * anyway. Keeping the cold segment verbatim costs one oversized turn and loses nothing.
 */
async function callSummariser({
  llm,
  chunk,
  programState,
  previous,
  abortSignal,
}: {
  llm: LLMConfig;
  chunk: string;
  programState: Record<string, unknown>;
  previous: Record<string, unknown> | null;
  abortSignal?: AbortSignal;
}): Promise<{ ok: true; summary: Record<string, unknown> } | { ok: false; reason: string }> {
  const prompt = [
    'Summarize only the current conversation for context compaction.',
    'Preserve the user goal, completed work, decisions, exact file paths, tool outcomes, remaining work, and blockers.',
    'Carry forward still-valid facts from previousCheckpoint and remove only what the newer messages supersede.',
    'The messages below are already condensed: tool output bodies live in an archive and are described, not quoted.',
    'Never invent file contents. Mention that exact details require a workspace file reload.',
    'Return strict JSON only. Do not include markdown.',
    '',
    'Required JSON schema:',
    JSON.stringify(SUMMARY_JSON_SCHEMA),
    '',
    '<programState>',
    JSON.stringify(programState),
    '</programState>',
    '<previousCheckpoint>',
    previous ? JSON.stringify(previous) : 'none',
    '</previousCheckpoint>',
    '<conversationMessages>',
    chunk,
    '</conversationMessages>',
  ].join('\n');
  try {
    const text = await getLLMClient(llm).completeText([
      { role: 'system', content: 'You summarize conversation state for safe context compaction.' },
      { role: 'user', content: prompt },
    ], 1_800, abortSignal, { ignoreThinking: true });
    if (!text.trim()) return { ok: false, reason: 'the summariser returned empty text' };
    const summary = parseModelJson(text);
    if ('raw' in summary) return { ok: false, reason: 'the summariser replied with non-JSON text' };
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Merge the archive index into the summary under `discardedContext`.
 *
 * The archive holds everything that left the context. Without a line naming it, the model
 * cannot know that it exists.
 */
function withArchiveIndex(summary: Record<string, unknown>, archiveIndex: string[]): Record<string, unknown> {
  if (!archiveIndex.length) return summary;
  const discarded = summary.discardedContext && typeof summary.discardedContext === 'object' && !Array.isArray(summary.discardedContext)
    ? summary.discardedContext as Record<string, unknown>
    : {};
  return { ...summary, discardedContext: { ...discarded, archivedGroups: archiveIndex } };
}

/** Structural fallback: no paraphrase, but the fields a reader still needs. */
function fallbackSummary(programState: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskState: {
      userGoal: String(programState.latestUserPrompt || ''),
      currentStatus: 'in_progress',
      latestUserInstruction: String(programState.latestUserPrompt || ''),
      openQuestions: [],
    },
    decisions: [],
    stableFacts: [],
    completedActions: [],
    pendingActions: [],
    discardedContext: programState.loadedCapabilitiesRemovedFromContext || {},
    continuationPrompt: 'Compression fallback: the summariser did not return a usable summary. Reopen details from the workspace files.',
  };
}

function estimateMessageTokens(message: { role?: unknown; content?: unknown; tool_calls?: unknown }): number {
  const stripped = stripImageParts([message], '[image]')[0];
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(stripped);
}

/**
 * Render the shared summary object as the compact text injected mid-run.
 *
 * The checkpoint path keeps the object (JSON); the runtime path only needs a short,
 * readable block. Rendering from the same fields is what keeps the two consistent.
 */
function formatRuntimeSummary(summary: Record<string, unknown>, archiveIndex: string[] = []): string {
  const lines: string[] = ['<runtime_context_checkpoint>'];
  const task = isPlainRecord(summary.taskState) ? summary.taskState : {};
  const push = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) lines.push(`${label}: ${text}`);
  };
  const bullets = (label: string, value: unknown, format: (item: unknown) => string) => {
    const list = Array.isArray(value) ? value : [];
    const rendered = list.map((item) => format(item).trim()).filter(Boolean);
    if (rendered.length) lines.push(`${label}:`, ...rendered.map((line) => `- ${line}`));
  };
  push('Goal', task.userGoal);
  push('Status', task.currentStatus);
  push('Latest instruction', task.latestUserInstruction);
  bullets('Decisions', summary.decisions, (item) => {
    if (!isPlainRecord(item)) return String(item ?? '');
    const decision = String(item.decision ?? '');
    const reason = String(item.reason ?? '');
    return reason ? `${decision} (${reason})` : decision;
  });
  bullets('Facts', summary.stableFacts, (item) => (isPlainRecord(item) ? String(item.fact ?? '') : String(item ?? '')));
  bullets('Completed', summary.completedActions, (item) => String(item ?? ''));
  bullets('Pending', summary.pendingActions, (item) => String(item ?? ''));
  bullets('Open questions', task.openQuestions, (item) => String(item ?? ''));
  push('Next', summary.continuationPrompt);
  if (archiveIndex.length) {
    // Named, not silent: the model cannot know what left the context unless something
    // says so. Each line is a pointer, not a paraphrase.
    lines.push('Archived (no longer in context; only workspace files written earlier remain readable):');
    for (const line of archiveIndex.slice(0, 40)) lines.push(`- ${line}`);
  }
  lines.push('Earlier details are no longer in the context; re-read the workspace when their exact text matters.');
  lines.push('</runtime_context_checkpoint>');
  return lines.join('\n');
}

/**
 * How much of the window to hold back for the answer.
 *
 * The reserve is proportional, not a flat floor. A flat 8,000-token reserve is fine on a
 * 1M window and destroys a small one: at `window <= 8_000` it left `contextLimit = 1`, so
 * every request was instantly over the hard watermark and lost its tools. The 20% cap and
 * the half-window ceiling keep the input budget usable at any accepted window size, while
 * the configured/default request still wins on large windows.
 *
 * `maxOutputTokens` itself is unchanged; this only decides how much the *budget* reserves.
 */
function resolveReservedOutputTokens(contextWindowTokens: number, maxOutputTokens?: number): number {
  const configured = Number(maxOutputTokens);
  const requested = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : MIN_RESERVED_OUTPUT_TOKENS;
  const proportional = Math.max(MIN_OUTPUT_RESERVE_TOKENS, Math.floor(contextWindowTokens * OUTPUT_RESERVE_RATIO));
  return Math.max(1, Math.min(requested, proportional, Math.floor(contextWindowTokens / 2)));
}

export function formatBudgetStatus(status: ContextBudgetStatus): string {
  const parts = [
    `estimated=${status.tokenEstimate}`,
    `heuristic=${status.heuristicTokenEstimate}`,
    `calibration=${status.calibrationMultiplier.toFixed(3)}`,
    `limit=${status.contextLimit}`,
    `window=${status.contextWindowTokens}`,
    `window_source=${status.contextWindowSource}`,
    `window_reason=${status.contextWindowReason}`,
    `tools_scope=${status.toolsScope || 'request'}`,
    `reserved_output=${status.breakdown.reservedOutput}`,
    `ratio=${Math.round(status.ratio * 100)}%`,
    `system=${status.breakdown.system}`,
    `messages=${status.breakdown.messages}`,
    `user=${status.breakdown.user}`,
    `tools=${status.breakdown.tools}`,
    `overhead=${status.breakdown.overhead}`,
  ];
  return `context_budget: ${parts.join(', ')}`;
}

/**
 * Records a provider-reported prompt-token count and returns the conservative
 * multiplier to apply to later estimates for the same endpoint and model.
 */
export function recordObservedPromptTokens(llm: LLMConfig, heuristicTokens: number, observedPromptTokens: number): number {
  if (!Number.isFinite(heuristicTokens) || heuristicTokens <= 0 || !Number.isFinite(observedPromptTokens) || observedPromptTokens <= 0) {
    return getTokenUsageCalibration(llm);
  }
  const key = tokenUsageKey(llm);
  const ratio = Math.min(4, Math.max(0.25, observedPromptTokens / heuristicTokens));
  const history = tokenUsageRatios.get(key) || [];
  history.push(ratio);
  if (history.length > TOKEN_USAGE_OBSERVATION_LIMIT) history.splice(0, history.length - TOKEN_USAGE_OBSERVATION_LIMIT);
  tokenUsageRatios.set(key, history);
  return getTokenUsageCalibration(llm);
}

/** Returns the P90 observed/heuristic ratio, never reducing the safety estimate. */
export function getTokenUsageCalibration(llm: LLMConfig): number {
  const history = tokenUsageRatios.get(tokenUsageKey(llm)) || [];
  if (!history.length) return 1;
  const ordered = [...history].sort((left, right) => left - right);
  const p90 = ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.9) - 1)];
  return Math.max(1, p90);
}

function tokenUsageKey(llm: LLMConfig): string {
  return `${String(llm.baseUrl || '').replace(/\/+$/, '').toLowerCase()}\n${String(llm.model || '')}`;
}

function estimateToolsTokens(tools: unknown[]): number {
  if (!tools.length) return 0;
  const serialized = JSON.stringify(tools);
  return estimateTextTokens(serialized) + tools.length * TOOL_OVERHEAD_TOKENS;
}

function estimateTextTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return 0;

  let cjk = 0;
  let latinOrDigit = 0;
  let whitespace = 0;
  let other = 0;

  for (const char of text) {
    if (/\s/u.test(char)) {
      whitespace += 1;
    } else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) {
      cjk += 1;
    } else if (/[A-Za-z0-9_]/u.test(char)) {
      latinOrDigit += 1;
    } else {
      other += 1;
    }
  }

  return Math.ceil(
    cjk * 1.15
    + latinOrDigit / 3.8
    + whitespace / 8
    + other / 2.2
  );
}

function buildProgramState(context: AgentRuntimeContext, messages: Message[]): Record<string, unknown> {
  const userPrompts = messages.filter((message) => message.role === 'user').map((message) => message.content);
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const runEvents = assistantMessages.flatMap((message) => Array.isArray(message.toolCalls?.run?.events) ? message.toolCalls.run.events : []);
  const loadedTools = new Set<string>();
  const loadedSkills = new Set<string>();
  const fileHints: Array<Record<string, unknown>> = [];

  for (const event of runEvents) {
    if (event?.type === 'tool_call_result') {
      const loadedCapability = readLoadedCapability(event.observation);
      if ((loadedCapability?.kind === 'coretool' || loadedCapability?.kind === 'mcp') && loadedCapability.id) loadedTools.add(loadedCapability.id);
      if (loadedCapability?.kind === 'skill' && loadedCapability.id) loadedSkills.add(loadedCapability.id);
    }
    if (event?.type === 'workspace_artifact' && event.artifact) {
      fileHints.push({
        path: event.artifact.path,
        type: event.artifact.type,
        title: event.artifact.title,
      });
    }
  }

  return {
    agent: { id: context.agent.id, name: context.agent.name },
    latestUserPrompt: userPrompts[userPrompts.length - 1] || '',
    recentUserPrompts: userPrompts.slice(-8),
    loadedCapabilitiesRemovedFromContext: {
      coretoolsAndMcp: [...loadedTools].sort(),
      skills: [...loadedSkills].sort(),
    },
    workspaceMap: [
      ...context.workspace?.artifacts.slice(0, 30).map((artifact) => ({
        path: artifact.path,
        type: artifact.type,
        title: artifact.title,
        brief: artifact.summary || '',
        whenToReload: 'Reload this file when exact content or values are needed.',
      })) || [],
      ...fileHints,
    ],
  };
}

function readLoadedCapability(observation: unknown): { kind?: string; id?: string } | null {
  if (!isPlainRecord(observation) || !isPlainRecord(observation.loadedCapability)) return null;
  const { kind, id } = observation.loadedCapability;
  return {
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof id === 'string' ? { id } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a stored checkpoint still describes the context it was written under.
 *
 * The fingerprint covers everything the summary's meaning depends on: agent, system
 * prompt, and the capability catalog. It deliberately omits the workspace artifact map
 * and the current date, which are rebuilt per request for cache reasons and must not
 * invalidate a durable summary.
 *
 * A checkpoint without a fingerprint cannot be verified — it may predate this check or
 * have been written by another build — so it is treated as stale rather than trusted.
 */
function checkpointMatchesContext(
  checkpoint: contextStore.ContextCheckpoint,
  context: AgentRuntimeContext,
): boolean {
  if (!checkpoint.pinnedFingerprint) return false;
  return checkpoint.pinnedFingerprint === fingerprintPinnedContext(context);
}

export function fingerprintPinnedContext(context: AgentRuntimeContext): string {
  const pinned = {
    agentId: context.agent.id,
    systemPrompt: context.systemPrompt,
    coreTools: context.coreTools.map((tool) => [tool.id, tool.name, tool.description]),
    mcpServers: context.mcpServers.map((server) => [server.id, server.name, server.description]),
    skills: context.skills.map((skill) => [skill.id, skill.name, skill.description]),
  };
  return crypto.createHash('sha1').update(JSON.stringify(pinned)).digest('hex');
}

function parseModelJson(content: string): Record<string, unknown> {
  const cleaned = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { raw: content };
  } catch {
    return { raw: content };
  }
}

function previewText(value: unknown, maxLength = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated]` : text;
}

export const runtimeContextManager = new RuntimeContextManager();

/** Most recent user prompt in a message list, as plain text. */
function lastUserText(messages: readonly { role?: string; content?: unknown }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const text = messageText(messages[index]?.content).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}
