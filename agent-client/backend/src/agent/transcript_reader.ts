import fs from 'node:fs';
import path from 'node:path';
import type { RecordedSystemPrompt, SystemPromptProvenance } from './types.js';
import { assertPathSegment } from './config/path_segments.js';
import { getTranscriptEventsPath, getTranscriptRoot } from './transcript_store.js';
import {
  assertContiguousSequences,
  foldRuns,
  parseTranscriptText,
  TranscriptLogError,
  type ParsedTranscript,
  type TranscriptRecord,
  type TranscriptRunSummary,
} from './transcript_log.js';

/**
 * Read side of the transcript log.
 *
 * `transcript_store.ts` owns writing; this module owns reading. The rules that decide
 * what a record is and where the committed prefix ends live in `transcript_log.ts`
 * and are shared with the writer, so both sides agree on what is valid.
 *
 * Recovery policy: a log is repaired by *discarding an unusable tail* and *refusing
 * to guess*, never by rewriting committed records.
 */

export {
  assertContiguousSequences,
  foldRuns,
  parseTranscriptText,
  TranscriptLogError,
  type ParsedTranscript,
  type TranscriptRecord,
  type TranscriptRunStatus,
  type TranscriptRunSummary,
} from './transcript_log.js';

export interface TranscriptReadResult {
  conversationId: string;
  runs: TranscriptRunSummary[];
  events: TranscriptRecord[];
  /** True when `limit` cut the result short. */
  truncated: boolean;
  /**
   * True when the stored log ended in an unusable record that was ignored. The file
   * on disk is left untouched — surfacing this is how a reader learns the log was
   * interrupted, without the read path ever repairing storage.
   */
  tornTail: boolean;
}

export interface TranscriptReadOptions {
  runId?: string;
  afterSequence?: number;
  limit?: number;
  /**
   * Read every matching record instead of one page. Needed when projecting a whole
   * run: stream chunks dominate the record count but project away, so a page limit
   * sized for raw events would silently cut a run's engine events off the end.
   */
  unlimited?: boolean;
}

export const TRANSCRIPT_DEFAULT_LIMIT = 500;
export const TRANSCRIPT_MAX_LIMIT = 5000;

/**
 * Read every committed record of a conversation's transcript, without paging or
 * grouping.
 *
 * Whole-log aggregations (session statistics) need `createdAt` timing on records that
 * never reach the runtime event stream — `model_chunk` and `model_request` are the only
 * place first-token and request timing exist. A missing log is an empty transcript, not
 * an error; a damaged log throws `TranscriptLogError` like the paged reader so callers
 * can degrade deliberately.
 */
export function readTranscriptRecords(conversationId: string): { records: TranscriptRecord[]; tornTail: boolean } {
  const eventsPath = getTranscriptEventsPath(conversationId);
  const parsed = fs.existsSync(eventsPath)
    ? parseTranscriptText(fs.readFileSync(eventsPath, 'utf8'))
    : { events: [], tornTail: false };
  assertContiguousSequences(parsed.events);
  return { records: parsed.events, tornTail: parsed.tornTail };
}

/** Read a conversation's transcript. A missing log is an empty transcript, not an error. */
export function readTranscript(conversationId: string, options: TranscriptReadOptions = {}): TranscriptReadResult {
  const { records: all, tornTail } = readTranscriptRecords(conversationId);
  const runs = foldRuns(all);

  let events = all;
  if (options.runId) events = events.filter((event) => event.runId === options.runId);
  if (typeof options.afterSequence === 'number') {
    events = events.filter((event) => event.sequence > options.afterSequence!);
  }

  const limit = options.unlimited ? Number.POSITIVE_INFINITY : normaliseLimit(options.limit);
  const truncated = events.length > limit;
  if (truncated) events = events.slice(0, limit);

  return {
    conversationId,
    runs: options.runId ? runs.filter((run) => run.runId === options.runId) : runs,
    events,
    truncated,
    tornTail,
  };
}

/**
 * Resolve a stored blob reference to an absolute path inside this conversation's
 * transcript directory.
 *
 * The reference comes from a request parameter, so it is validated against the exact
 * shape the writer produces and then re-checked for containment: a `..` segment or an
 * absolute path must never escape the conversation's own storage.
 */
export function resolveTranscriptBlobPath(conversationId: string, ref: string): string {
  assertPathSegment(conversationId, 'conversation id for transcript storage');
  const match = /^blobs\/sha256-([0-9a-f]{64})\.txt$/.exec(ref);
  if (!match) throw new TranscriptLogError('Transcript blob reference is not a valid blob path.');
  const blobRoot = path.join(getTranscriptRoot(conversationId), 'blobs');
  const resolved = path.join(blobRoot, `sha256-${match[1]}.txt`);
  if (path.dirname(resolved) !== blobRoot) {
    throw new TranscriptLogError('Transcript blob reference escapes the transcript directory.');
  }
  return resolved;
}

function normaliseLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return TRANSCRIPT_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), TRANSCRIPT_MAX_LIMIT);
}

export interface ReconstructedAgentEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * The reasoning text a raw provider chunk carried, if any.
 *
 * `reasoning_content` is what vLLM/Qwen-style OpenAI-compatible servers stream; `reasoning`
 * is the plain alias. Only these two spellings are recognized — a provider that names it
 * something else contributes nothing here rather than a guess.
 */
function reasoningTextOf(data: unknown): string {
  const chunk = (data as { chunk?: { choices?: Array<{ delta?: Record<string, unknown> }> } }).chunk;
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta) return '';
  const value = delta.reasoning_content ?? delta.reasoning;
  return typeof value === 'string' ? value : '';
}

/**
 * Rebuild the runtime event stream a stored run produced.
 *
 * This is what lets the transcript be the single source for the trace view: engine
 * events are stored verbatim and unwrapped, while tool rows are rebuilt from the
 * first-class `tool_call` / `tool_result` records — which is exactly why those are
 * not mirrored as engine events. The runtime records a tool call before yielding its
 * start event and its result before yielding the result event, so rebuilding in
 * sequence order reproduces the original stream order.
 *
 * Assistant narration is rebuilt the same way, from `model_response`: that record
 * already carries each turn's text at the sequence position that precedes the turn's
 * tool calls, so projecting it reproduces the order the live stream had. Without this
 * the rebuilt stream held tool rows only, and the message's single concatenated
 * `content` string was rendered as one block after every tool row — which is how
 * narration interleaved between tool calls ended up at the end of the message.
 *
 * Reasoning is rebuilt from the raw `model_chunk` records: those are the only place it
 * was ever stored, so deriving it here is what makes reasoning visible for runs recorded
 * before it was a first-class stream event. The cost of that choice is explicit — the
 * reasoning's durability is the raw chunks' durability.
 */
export function toAgentEvents(records: readonly TranscriptRecord[]): ReconstructedAgentEvent[] {  const events: ReconstructedAgentEvent[] = [];
  // Provider chunks arrive one per streamed delta; they are concatenated per request so a
  // turn's reasoning becomes a single event, which is what the live stream produces too
  // once the client merges its deltas.
  let thinkingRequestId = '';
  let thinkingText = '';
  const flushThinking = () => {
    if (thinkingText.trim()) events.push({ type: 'thinking', content: thinkingText });
    thinkingRequestId = '';
    thinkingText = '';
  };
  for (const record of records) {
    if (record.type === 'model_chunk') {
      const requestId = record.requestId || '';
      if (thinkingRequestId && requestId && requestId !== thinkingRequestId) flushThinking();
      if (requestId) thinkingRequestId = requestId;
      thinkingText += reasoningTextOf(record.data);
      continue;
    }
    // Anything that is not a stream chunk ends the reasoning run, so the reasoning lands
    // ahead of the `model_response` and tool rows of the same turn.
    flushThinking();
    if (record.type === 'engine_event') {
      const payload = (record.data as { event?: unknown }).event;
      if (payload && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string') {
        events.push(payload as ReconstructedAgentEvent);
      }
      continue;
    }
    if (record.type === 'model_response') {
      const data = record.data as { content?: unknown; finishReason?: unknown };
      // A length-capped turn was discarded by the runtime and subtracted from the
      // message content as well, so replaying it here would surface text the run
      // deliberately threw away.
      if (data.finishReason === 'length') continue;
      const content = typeof data.content === 'string' ? data.content : '';
      // A tool-calling turn commonly narrates nothing but whitespace; emitting that
      // would add an empty text part per turn. The text is kept verbatim rather than
      // trimmed so concatenating the projected parts reproduces the message content.
      if (content.trim()) events.push({ type: 'info', content });
      continue;
    }
    if (record.type === 'tool_call') {
      const data = record.data as { toolName?: unknown; parsedArguments?: unknown; turnIndex?: unknown };
      events.push({
        type: 'tool_call_start',
        tool_name: String(data.toolName ?? ''),
        arguments: data.parsedArguments ?? {},
        turnIndex: data.turnIndex,
        planStepIndex: null,
      });
      continue;
    }
    if (record.type === 'tool_result') {
      const data = record.data as {
        toolName?: unknown;
        modelVisibleResult?: unknown;
        observation?: unknown;
        rawResult?: unknown;
        turnIndex?: unknown;
      };
      const blobRef = blobRefOf(data.rawResult);
      events.push({
        type: 'tool_call_result',
        tool_name: String(data.toolName ?? ''),
        // The model-visible text, not the blob: the full result stays retrievable
        // through the blob route instead of being inlined into every trace read.
        result: data.modelVisibleResult ?? '',
        ...(data.observation ? { observation: data.observation } : {}),
        // The blob *reference*, for the same reason: a trace read stays small, while
        // readers can still recover the exact bytes from the content-addressed store.
        ...(blobRef ? { rawResult: blobRef } : {}),
        turnIndex: data.turnIndex,
        planStepIndex: null,
      });
    }
  }
  // A run whose last turn streamed reasoning but never produced a `model_response`
  // (killed mid-turn) still gets its reasoning, matching the live stream.
  flushThinking();
  return events;
}

/**
 * Rebuild every run's runtime event stream for a conversation.
 *
 * The transcript is read once and grouped by run, so a caller needing events for many
 * messages does not re-read the log per message.
 *
 * A damaged log yields no events instead of an error: the conversation view must not
 * become unavailable because the audit trail is unreadable, and the transcript route
 * still reports that damage loudly to anyone looking at the log itself.
 */
export function agentEventsByRun(conversationId: string): Map<string, ReconstructedAgentEvent[]> {
  const byRun = new Map<string, ReconstructedAgentEvent[]>();
  for (const [runId, projection] of runProjectionsByConversation(conversationId)) {
    byRun.set(runId, projection.events);
  }
  return byRun;
}

/**
 * The stored path of a tool result's raw blob, or null when the record has none.
 *
 * Validated here rather than at read time so a malformed or hostile value never enters the
 * projected event in the first place; `resolveTranscriptBlobPath` re-checks containment
 * against the conversation directory when the bytes are actually read.
 */
function blobRefOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { path?: unknown; sha256?: unknown };
  if (typeof candidate.path !== 'string' || typeof candidate.sha256 !== 'string') return null;
  return /^blobs\/sha256-[0-9a-f]{64}\.txt$/.test(candidate.path) ? candidate.path : null;
}

export interface ReconstructedRunProjection {
  events: ReconstructedAgentEvent[];
  /**
   * The prompt this run's first request actually sent, with the provenance recorded
   * alongside it. Null when the run predates provenance recording, or when the log could
   * not be read.
   */
  systemPrompt: RecordedSystemPrompt | null;
}

/**
 * The system prompt of a run, taken from its first recorded request.
 *
 * The prompt is assembled once per run, so every request in the run carries the same text
 * and the same section offsets; reading the first one is enough. The text is sliced out of
 * the recorded `messages[0]` rather than stored separately, which is why the offsets have
 * to be trusted to reproduce it byte for byte.
 */
function systemPromptOf(records: readonly TranscriptRecord[]): RecordedSystemPrompt | null {
  for (const record of records) {
    if (record.type !== 'model_request') continue;
    const data = record.data as { systemPrompt?: SystemPromptProvenance; messages?: unknown };
    const provenance = data.systemPrompt;
    if (!provenance || typeof provenance.sha256 !== 'string' || !Array.isArray(provenance.sections)) continue;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
    if (first?.role !== 'system' || typeof first.content !== 'string') continue;
    return { text: first.content, sha256: provenance.sha256, sections: provenance.sections };
  }
  return null;
}

/**
 * Rebuild every run's projection for a conversation: its runtime event stream plus the
 * system prompt that shaped it.
 *
 * The transcript is read once and grouped by run, so a caller needing both for many
 * messages does not re-read the log per message.
 *
 * A damaged log yields nothing instead of an error: the conversation view must not become
 * unavailable because the audit trail is unreadable, and the transcript route still reports
 * that damage loudly to anyone looking at the log itself.
 */
export function runProjectionsByConversation(conversationId: string): Map<string, ReconstructedRunProjection> {
  const byRun = new Map<string, ReconstructedRunProjection>();
  const eventsPath = getTranscriptEventsPath(conversationId);
  if (!fs.existsSync(eventsPath)) return byRun;

  let parsed: ParsedTranscript;
  try {
    parsed = parseTranscriptText(fs.readFileSync(eventsPath, 'utf8'));
    assertContiguousSequences(parsed.events);
  } catch {
    return byRun;
  }

  const grouped = new Map<string, TranscriptRecord[]>();
  for (const record of parsed.events) {
    const list = grouped.get(record.runId);
    if (list) list.push(record);
    else grouped.set(record.runId, [record]);
  }
  for (const [runId, records] of grouped) {
    byRun.set(runId, { events: toAgentEvents(records), systemPrompt: systemPromptOf(records) });
  }
  return byRun;
}
