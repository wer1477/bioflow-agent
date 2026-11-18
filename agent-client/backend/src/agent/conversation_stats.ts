import {
  readTranscriptRecords,
  TranscriptLogError,
  type TranscriptRecord,
} from './transcript_reader.js';

/**
 * Whole-conversation statistics folded from the transcript.
 *
 * The runtime event stream the Web already receives carries token counters and tool
 * durations, but it deliberately has no request/first-token timing (those live on the
 * raw transcript records). This module is the one place that turns the durable log into
 * display totals, so the composer pills and any later consumer share one definition.
 */

export interface ConversationActivityStats {
  /** User turns. One run is started per submitted message. */
  turns: number;
  /** Model requests. Each tool-loop iteration is one step. */
  steps: number;
  /** Sum of request→response wall time. */
  llmMs: number;
  /** Sum of tool execution time, excluding approval waits. */
  toolMs: number;
  /** Sum of request→first-output-delta time; divide by `ttftSteps` for the average. */
  ttftMs: number;
  ttftSteps: number;
  /** Time from first output delta to response completion, for steps that measured both. */
  decodeMs: number;
  /** Completion tokens belonging to the steps counted in `decodeMs`. */
  decodeTokens: number;
  /** Decode speed in output tokens per second, or null when it was never measured. */
  tokensPerSecond: number | null;
  /** Prompt tokens belonging to the steps counted in `ttftMs`. */
  ttftPromptTokens: number;
  /**
   * Prefill cost proxy: milliseconds of first-token latency per 1k prompt tokens.
   *
   * The one cache signal that does not need provider cooperation. A warm prefix cache
   * makes this collapse by roughly an order of magnitude (measured ~0.32 ms/token cold
   * vs ~0.02 ms/token warm on the DGX SGLang endpoint), so it stands in when the
   * endpoint never reports `cached_tokens`. It is an upper bound on pure prefill —
   * first-token latency also carries scheduling and one decode step — which is why it is
   * only meaningful as a ratio across requests, never as an absolute.
   */
  prefillMsPerKTok: number | null;
}

export interface ConversationTokenUsageStats {
  /** Provider-reported prompt tokens across every request. */
  promptTokens: number;
  /** Prompt tokens excluding provider-reported prefix-cache reads. */
  uncachedInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens belonging to the requests that reported a cache counter.
   *
   * `cacheHitPercent`'s denominator. Kept because merging conversations has to recombine
   * the ratio from its two halves: a session that never reported a cache counter must not
   * pull the ratio down.
   */
  cachePromptTokens: number;
  /**
   * Cache-hit share of the requests that reported a cache counter. Null when no
   * request reported one — unknown is not zero.
   *
   * Meaningful only together with the coverage fields below: a conversation where three
   * of sixty-four requests reported a counter still yields a percentage here, and a
   * percentage computed from 5% of the evidence reads exactly like one computed from all
   * of it. Consumers must show the coverage or withhold the number.
   */
  cacheHitPercent: number | null;
  /** Model requests (plus unattributed usage frames) that reported a cache counter. */
  cacheReportedSteps: number;
  /**
   * Every attempt whose cache status could be judged: all model requests, including the
   * ones that produced no usage frame at all (their cache status is unknown, not zero).
   */
  cacheTotalSteps: number;
}

/** Totals for one model that produced output in this conversation. */
export interface ConversationModelUsage {
  model: string;
  provider: string;
  requests: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ConversationTranscriptStats {
  activity: ConversationActivityStats;
  tokenUsage: ConversationTokenUsageStats;
  /**
   * Usage split by the model that served each request. A role can change models between
   * runs, so a single total cannot say what a conversation actually cost or which model
   * answered which part of it.
   */
  byModel: ConversationModelUsage[];
}

interface TranscriptUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number | null;
}

interface RequestTiming {
  requestAt: number;
  firstChunkAt: number | null;
  firstOutputAt: number | null;
  responseAt: number | null;
  usage: TranscriptUsage | null;
  /** The endpoint and model this request was sent to, as the transcript recorded them. */
  provider: string;
  model: string;
}

const EMPTY_STATS: ConversationTranscriptStats = {
  activity: {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    tokensPerSecond: null,
    ttftPromptTokens: 0,
    prefillMsPerKTok: null,
  },
  tokenUsage: {
    promptTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachePromptTokens: 0,
    cacheHitPercent: null,
    cacheReportedSteps: 0,
    cacheTotalSteps: 0,
  },
  byModel: [],
};

export function emptyConversationStats(): ConversationTranscriptStats {
  return structuredClone(EMPTY_STATS);
}

/**
 * Fold a run-ordered transcript into session totals.
 *
 * Usage readings are emitted as `loop_health{reason:'token_usage_observed'}` engine
 * events during the request they belong to, so they are attached to the most recent
 * `model_request`. Repeated usage frames for one request collapse to the newest reading
 * (some providers repeat the same counters per chunk); a reading with no request still
 * contributes to the token totals.
 */
export function summariseTranscript(records: readonly TranscriptRecord[]): ConversationTranscriptStats {
  const turnRuns = new Set<string>();
  const requestRuns = new Set<string>();
  const requests = new Map<string, RequestTiming>();
  const orphanUsages: TranscriptUsage[] = [];
  let activeRequestId = '';
  let toolMs = 0;

  for (const record of records) {
    const at = Date.parse(record.createdAt);
    if (record.type === 'run_start') {
      turnRuns.add(record.runId);
      continue;
    }
    if (record.type === 'model_request') {
      requestRuns.add(record.runId);
      const requestId = record.requestId || record.eventId;
      activeRequestId = requestId;
      const llm = readRequestLlm(record.data);
      requests.set(requestId, {
        requestAt: Number.isFinite(at) ? at : 0,
        firstChunkAt: null,
        firstOutputAt: null,
        responseAt: null,
        usage: null,
        model: llm.model,
        provider: llm.provider,
      });
      continue;
    }
    if (record.type === 'model_chunk') {
      const timing = requests.get(record.requestId || activeRequestId);
      if (!timing || !Number.isFinite(at)) continue;
      if (timing.firstChunkAt === null) timing.firstChunkAt = at;
      if (timing.firstOutputAt === null && chunkHasOutput(record.data)) timing.firstOutputAt = at;
      continue;
    }
    if (record.type === 'model_response') {
      const timing = requests.get(record.requestId || activeRequestId);
      if (timing && Number.isFinite(at)) timing.responseAt = at;
      continue;
    }
    if (record.type === 'engine_event') {
      const event = readEngineEvent(record.data);
      if (event?.type !== 'loop_health' || event.reason !== 'token_usage_observed') continue;
      const usage = readTokenUsage(event.tokenUsage);
      if (!usage) continue;
      const timing = requests.get(activeRequestId);
      // One request may deliver more than one usage frame (some providers repeat it
      // per chunk); keep the newest reading per request instead of summing duplicates.
      if (timing) timing.usage = usage;
      else orphanUsages.push(usage);
      continue;
    }
    if (record.type === 'tool_result') {
      const duration = Number((record.data as { durationMs?: unknown })?.durationMs);
      if (Number.isFinite(duration) && duration > 0) toolMs += duration;
    }
  }

  let llmMs = 0;
  let ttftMs = 0;
  let ttftSteps = 0;
  let ttftPromptTokens = 0;
  let decodeMs = 0;
  let decodeTokens = 0;
  for (const timing of requests.values()) {
    if (timing.responseAt !== null) {
      llmMs += Math.max(0, timing.responseAt - timing.requestAt);
    }
    if (timing.firstOutputAt !== null) {
      ttftMs += Math.max(0, timing.firstOutputAt - timing.requestAt);
      ttftSteps += 1;
      // Pair the latency with the prompt it paid for; a step without usage still counts
      // toward the step total but cannot contribute tokens to the prefill ratio.
      ttftPromptTokens += timing.usage?.promptTokens ?? 0;
    }
    const completionTokens = timing.usage?.completionTokens ?? 0;
    // Prefer the first output delta; the first stream chunk is the closest fallback.
    // Request→response would fold the whole TTFT into the decode window and understate
    // the speed. Steps with neither boundary still contribute to the token totals below.
    const decodeStart = timing.firstOutputAt ?? timing.firstChunkAt;
    if (timing.responseAt !== null && decodeStart !== null && completionTokens > 0) {
      decodeMs += Math.max(0, timing.responseAt - decodeStart);
      decodeTokens += completionTokens;
    }
  }

  const usageReadings = [...orphanUsages];
  for (const timing of requests.values()) {
    if (timing.usage) usageReadings.push(timing.usage);
  }

  let promptTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cachePromptTokens = 0;
  let cacheReportedSteps = 0;
  let cacheTotalSteps = 0;
  for (const usage of usageReadings) {
    promptTokens += usage.promptTokens;
    outputTokens += usage.completionTokens;
    cacheTotalSteps += 1;
    if (usage.cachedPromptTokens !== null) {
      cacheReportedSteps += 1;
      cacheReadTokens += usage.cachedPromptTokens;
      cachePromptTokens += usage.promptTokens;
    }
  }
  // A request that produced no usage frame is still an attempt whose cache status is
  // unknown. Leaving it out of the denominator would let a mostly-uninstrumented
  // conversation report a confident ratio from a handful of steps.
  cacheTotalSteps += Math.max(0, requests.size - (usageReadings.length - orphanUsages.length));

  const byModel = foldUsageByModel(requests, orphanUsages);
  const turns = turnRuns.size > 0 ? turnRuns.size : requestRuns.size;
  return {
    activity: {
      turns,
      steps: requests.size,
      llmMs,
      toolMs,
      ttftMs,
      ttftSteps,
      decodeMs,
      decodeTokens,
      tokensPerSecond: tokensPerSecondOf(decodeMs, decodeTokens),
      ttftPromptTokens,
      prefillMsPerKTok: prefillMsPerKTokOf(ttftMs, ttftPromptTokens),
    },
    tokenUsage: {
      promptTokens,
      uncachedInputTokens: Math.max(0, promptTokens - cacheReadTokens),
      cacheReadTokens,
      outputTokens,
      totalTokens: promptTokens + outputTokens,
      cachePromptTokens,
      cacheHitPercent: cacheReportedSteps > 0 ? percentOf(cacheReadTokens, cachePromptTokens) : null,
      cacheReportedSteps,
      cacheTotalSteps,
    },
    byModel,
  };
}

/**
 * Fold several conversations' totals into one.
 *
 * A team root is a container rather than a transcript: the user reads the merged timeline
 * of its role sessions (`GET /:id/team/messages`) while the root itself never records a
 * request, so its footer has to add up the same conversations or it reports zeros for a
 * conversation full of visible work.
 *
 * Derived figures are recomputed from the summed windows instead of being averaged, so a
 * fast session cannot be hidden behind a slow one, and a session that never reported a
 * cache counter cannot dilute the hit ratio.
 */
export function mergeConversationStats(parts: readonly ConversationTranscriptStats[]): ConversationTranscriptStats {
  const merged = emptyConversationStats();
  for (const part of parts) {
    merged.activity.turns += part.activity.turns;
    merged.activity.steps += part.activity.steps;
    merged.activity.llmMs += part.activity.llmMs;
    merged.activity.toolMs += part.activity.toolMs;
    merged.activity.ttftMs += part.activity.ttftMs;
    merged.activity.ttftSteps += part.activity.ttftSteps;
    merged.activity.decodeMs += part.activity.decodeMs;
    merged.activity.decodeTokens += part.activity.decodeTokens;
    merged.activity.ttftPromptTokens += part.activity.ttftPromptTokens;
    merged.tokenUsage.promptTokens += part.tokenUsage.promptTokens;
    merged.tokenUsage.cacheReadTokens += part.tokenUsage.cacheReadTokens;
    merged.tokenUsage.outputTokens += part.tokenUsage.outputTokens;
    merged.tokenUsage.cachePromptTokens += part.tokenUsage.cachePromptTokens;
    merged.tokenUsage.cacheReportedSteps += part.tokenUsage.cacheReportedSteps;
    merged.tokenUsage.cacheTotalSteps += part.tokenUsage.cacheTotalSteps;
  }

  const { promptTokens, cacheReadTokens, cachePromptTokens, outputTokens } = merged.tokenUsage;
  merged.activity.tokensPerSecond = tokensPerSecondOf(merged.activity.decodeMs, merged.activity.decodeTokens);
  merged.activity.prefillMsPerKTok = prefillMsPerKTokOf(merged.activity.ttftMs, merged.activity.ttftPromptTokens);
  merged.tokenUsage.uncachedInputTokens = Math.max(0, promptTokens - cacheReadTokens);
  merged.tokenUsage.totalTokens = promptTokens + outputTokens;
  merged.tokenUsage.cacheHitPercent =
    merged.tokenUsage.cacheReportedSteps > 0 ? percentOf(cacheReadTokens, cachePromptTokens) : null;
  merged.byModel = mergeUsageByModel(parts);
  return merged;
}

/** Decode speed, or null when the window was never measured. Shared by the fold and the merge. */
function tokensPerSecondOf(decodeMs: number, decodeTokens: number): number | null {
  return decodeMs > 0 && decodeTokens > 0 ? decodeTokens / (decodeMs / 1000) : null;
}

/** First-token latency per 1k prompt tokens, or null when no timed step carried usage. */
function prefillMsPerKTokOf(ttftMs: number, ttftPromptTokens: number): number | null {
  return ttftMs > 0 && ttftPromptTokens > 0 ? ttftMs / (ttftPromptTokens / 1000) : null;
}

/** Same buckets as `foldUsageByModel`, added up across conversations. */
function mergeUsageByModel(parts: readonly ConversationTranscriptStats[]): ConversationModelUsage[] {
  const buckets = new Map<string, ConversationModelUsage>();
  for (const part of parts) {
    for (const row of part.byModel) {
      const key = `${row.provider}\u0000${row.model}`;
      const bucket = buckets.get(key);
      if (!bucket) {
        buckets.set(key, { ...row });
        continue;
      }
      bucket.requests += row.requests;
      bucket.promptTokens += row.promptTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.totalTokens = bucket.promptTokens + bucket.outputTokens;
    }
  }
  return [...buckets.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
}

/**
 * Attributes each request's usage to the model that served it. Requests whose model was not
 * recorded — a transcript from before `model_request` carried one — land under a single
 * "unknown" bucket rather than being dropped or misattributed.
 */
function foldUsageByModel(requests: Map<string, RequestTiming>, orphans: TranscriptUsage[]): ConversationModelUsage[] {
  const buckets = new Map<string, ConversationModelUsage>();
  const add = (model: string, provider: string, usage: TranscriptUsage | null) => {
    const key = `${provider}\u0000${model}`;
    const bucket = buckets.get(key) || { model: model || 'unknown', provider: provider || 'unknown', requests: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0 };
    bucket.requests += 1;
    if (usage) {
      bucket.promptTokens += usage.promptTokens;
      bucket.outputTokens += usage.completionTokens;
      bucket.totalTokens = bucket.promptTokens + bucket.outputTokens;
    }
    buckets.set(key, bucket);
  };
  for (const timing of requests.values()) add(timing.model, timing.provider, timing.usage);
  for (const usage of orphans) add('unknown', 'unknown', usage);
  return [...buckets.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
}

/** `model_request.data.llm` as recorded by the runtime; absent fields stay empty. */
function readRequestLlm(data: unknown): { model: string; provider: string } {
  if (!data || typeof data !== 'object') return { model: '', provider: '' };
  const llm = (data as { llm?: unknown }).llm;
  if (!llm || typeof llm !== 'object') return { model: '', provider: '' };
  const model = String((llm as { model?: unknown }).model ?? '');
  // The transcript records the base URL rather than a provider id, so this is what the
  // fold can honestly group by; an id would be a guess whenever the provider was renamed.
  const provider = String((llm as { baseUrl?: unknown }).baseUrl ?? '');
  return { model, provider };
}

/**
 * Read a conversation's transcript and fold it into session totals.
 *
 * A damaged log degrades to empty statistics instead of failing the endpoint: the
 * conversation view stays usable, and the transcript route already reports damage
 * loudly to whoever is inspecting the audit trail.
 */
export function loadConversationStats(conversationId: string): ConversationTranscriptStats {
  try {
    return summariseTranscript(readTranscriptRecords(conversationId).records);
  } catch (err) {
    if (err instanceof TranscriptLogError) return emptyConversationStats();
    throw err;
  }
}

function readEngineEvent(data: Record<string, unknown>): Record<string, unknown> | null {
  const event = data?.event;
  return event && typeof event === 'object' ? event as Record<string, unknown> : null;
}

function readTokenUsage(value: unknown): TranscriptUsage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const promptTokens = Number(record.promptTokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  const completionTokens = Number(record.completionTokens);
  const cachedRaw = record.cachedPromptTokens;
  const cachedNumber = cachedRaw === null || cachedRaw === undefined ? NaN : Number(cachedRaw);
  return {
    promptTokens,
    completionTokens: Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0,
    cachedPromptTokens: Number.isFinite(cachedNumber) && cachedNumber >= 0 ? cachedNumber : null,
  };
}

/** Whether a raw provider stream chunk contains a first output token (text, reasoning or a tool call). */
function chunkHasOutput(data: Record<string, unknown>): boolean {
  const chunk = data?.chunk as { choices?: Array<{ delta?: Record<string, unknown> }> } | undefined;
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta) return false;
  if (typeof delta.content === 'string' && delta.content.length > 0) return true;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string' && reasoning.length > 0) return true;
  return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
}

/**
 * Ratio in percent, rounded to one decimal.
 *
 * A full hit returns exactly 100; a partial hit never rounds up to 100 (that would
 * claim a perfect cache when one byte was still uncached).
 */
function percentOf(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  if (part >= whole) return 100;
  return Math.round((part / whole) * 1000) / 10;
}
