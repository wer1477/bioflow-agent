import { stripImageParts } from './core_tools/image_payload.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { LLMConfig, SystemPromptProvenance } from './types.js';
import type { ContextBudgetStatus } from './context_manager.js';
import { findSessionProjectKey } from './config/conversation_file_store.js';
import { assertPathSegment } from './config/path_segments.js';
import { transcriptDirectory } from './config/session_paths.js';
import { inspectLogText, STATE_RUN_ID } from './transcript_log.js';
import { runRegistry } from './run_registry.js';

const TRANSCRIPT_VERSION = 1;
const EVENTS_FILE = 'events.jsonl';

export interface TranscriptBlobRef {
  sha256: string;
  path: string;
  bytes: number;
  mimeType: string;
}

/**
 * Who and what produced a run, recorded once on `run_start`.
 *
 * Every field is optional and additive: logs written before this existed stay readable,
 * and a log copied out of the session store can still answer "which role, spawned by
 * whom, at what depth" without the conversation record beside it.
 */
export interface TranscriptRunIdentity {
  /** Agent profile that answered the run (a role id for team sessions). */
  agentId?: string | null;
  /** Team role of the conversation, when the conversation is a role session. */
  roleId?: string | null;
  /** Conversation that spawned this one; null for a user-started conversation. */
  parentConversationId?: string | null;
  /** Run that spawned this one; null for a user-started run. */
  parentRunId?: string | null;
  /** Delegation depth: 0 for a user-started run. */
  delegationDepth?: number | null;
}

export interface TranscriptEvent<T = Record<string, unknown>> {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  createdAt: string;
  conversationId: string;
  runId: string;
  requestId?: string;
  type: 'run_start' | 'model_request' | 'model_chunk' | 'model_response' | 'tool_call' | 'tool_result' | 'run_end' | 'engine_event';
  data: T;
}

/**
 * A way in which a request was made worse than it could have been.
 *
 * Recorded because the consequence is otherwise invisible: a request with `tools: null`
 * looks identical whether the turn deliberately had no tools or the budget forced them
 * out, and a reader trying to explain the model's behaviour needs to tell those apart.
 */
export interface TranscriptRequestDegradation {
  kind: 'tools_dropped';
  reason: string;
}

export interface TranscriptModelRequest {
  requestId: string;
  turnIndex: number;
  llm: Pick<LLMConfig, 'baseUrl' | 'model' | 'thinkingLevel'>;
  maxOutputTokens: number;
  messages: ChatCompletionMessageParam[];
  /** Null means the request omitted the tools field entirely. */
  tools: ChatCompletionTool[] | null;
  /** Tool choice actually sent, mirroring the transport; absent when no tools were sent. */
  toolChoice?: 'auto';
  degradations?: TranscriptRequestDegradation[];
  /** The budget state that shaped this request, including why tools may have been dropped. */
  budget?: ContextBudgetStatus;
  /**
   * Where each block of `messages[0]` came from.
   *
   * The prompt text itself is already stored verbatim in `messages`, so this carries only
   * provenance: a hash of the assembled string plus offsets into it. Storing the text a
   * second time here is exactly the duplication the transcript exists to avoid.
   */
  systemPrompt?: SystemPromptProvenance;
  /**
   * Segment fingerprints of the request prefix, recorded with every model request.
   *
   * A provider prefix cache only matches from token 0, so a stable hash here plus a
   * provider cache counter is what turns "why was this turn expensive" into a provable
   * answer instead of a guess.
   *
   * Four segments rather than one, because the segments fail for different reasons and
   * only `tools` sits ahead of the system message — a single hash over the leading
   * messages could never show that a tool-set change invalidated everything downstream:
   *
   * - `tools` changed → the assembly re-declared or reordered tool schemas, and since the
   *   chat template renders tools first, every later token is invalidated.
   * - `system` changed → the prompt body itself changed (config edit, catalog change).
   * - `head` changed → the leading history messages were rewritten.
   * - `full` changed while the others hold → an earlier append was rewritten deeper in
   *   the conversation, which only compaction is allowed to do.
   */
  prefixHash?: RequestPrefixHashes;
}

export interface RequestPrefixHashes {
  tools: string;
  system: string;
  head: string;
  full: string;
}

/**
 * Durable, append-only recording of the exact model-visible conversation.
 * Callers only submit events; sequence allocation, JSON validation, atomic
 * blob writes, and file layout remain local to this module.
 */
export class TranscriptRecorder {
  private sequence = 0;
  private ended = false;
  /**
   * Serialized records awaiting a durability boundary. Only diagnostic stream chunks
   * are buffered; every other record is written and fsynced as it is recorded, so the
   * buffer never outlives one model request.
   */
  private readonly pending: string[] = [];

  constructor(
    readonly conversationId: string,
    readonly runId: string,
    identity: TranscriptRunIdentity = {},
  ) {
    assertConversationId(conversationId);
    if (!runId) throw new Error('Transcript run id is required.');
    fs.mkdirSync(this.blobRoot, { recursive: true, mode: 0o700 });
    this.sequence = this.repairLogTail() + 1;
    this.writeManifest();
    this.append('run_start', {
      transcriptVersion: TRANSCRIPT_VERSION,
      ...compactIdentity(identity),
    });
  }

  /**
   * Bring the log to a state a writer may append to, and report where to continue.
   *
   * An interrupted write can leave an unusable final record. It is discarded here —
   * durably, before the first new append — because a half-written record must never
   * reach a reader. Committed records are never rewritten.
   *
   * When the committed prefix is internally inconsistent (a sequence gap or repeat)
   * this throws rather than renumbering: guessing the next sequence is exactly what
   * produced undetectable duplicate sequence numbers in an earlier build, and a run
   * that cannot be recorded faithfully must fail loudly instead of corrupting the log.
   */
  private repairLogTail(): number {
    if (!fs.existsSync(this.eventsPath)) return -1;
    const inspection = inspectLogText(fs.readFileSync(this.eventsPath, 'utf8'));
    if (inspection.tornTail) {
      fs.truncateSync(this.eventsPath, inspection.goodBytes);
    }
    if (inspection.needsNewline) {
      // A complete record that lost its terminating newline: restore it so the next
      // append starts a fresh line instead of being concatenated onto this one.
      fs.appendFileSync(this.eventsPath, '\n');
    }
    return inspection.lastSequence;
  }

  recordModelRequest(input: TranscriptModelRequest): void {
    this.append('model_request', {
      turnIndex: input.turnIndex,
      llm: cloneJson({
        baseUrl: input.llm.baseUrl,
        model: input.llm.model,
        ...(input.llm.thinkingLevel ? { thinkingLevel: input.llm.thinkingLevel } : {}),
      }),
      maxOutputTokens: input.maxOutputTokens,
      messages: cloneJson(stripImageParts(input.messages, '[image omitted from stored transcript]')),
      tools: input.tools === null ? null : cloneJson(input.tools),
      // Only present when the request really carried tools, matching the transport.
      ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
      ...(input.degradations?.length ? { degradations: cloneJson(input.degradations) } : {}),
      ...(input.budget ? { budget: cloneJson(input.budget) } : {}),
      ...(input.prefixHash ? { prefixHash: input.prefixHash } : {}),
      ...(input.systemPrompt ? { systemPrompt: cloneJson(input.systemPrompt) } : {}),
    }, input.requestId);
  }

  recordModelChunk(requestId: string, chunk: unknown): void {
    // Stream chunks are diagnostic detail, not the durable record of what the model
    // said — `model_response` is. Writing each one through its own open/fsync/close
    // cost one syscall round-trip per streamed token for no durability benefit, so
    // they ride the buffer and land with the next boundary.
    this.append('model_chunk', { chunk: cloneJson(chunk) }, requestId, { durable: false });
  }

  /**
   * Record a runtime event that has no first-class transcript record of its own —
   * loop health, MCP connection status, approval requests and results, planning
   * panels, run context, errors.
   *
   * Tool calls, model responses and stream chunks are deliberately *not* mirrored:
   * they already have their own records here, and storing them twice is what this
   * log was meant to stop doing. The read side rebuilds their runtime-event shape
   * from those records instead.
   */
  recordEngineEvent(event: { type: string }): void {
    this.append('engine_event', { event: cloneJson(event) });
  }

  recordModelResponse(input: {
    requestId: string;
    turnIndex: number;
    content: string;
    toolCalls: unknown[];
    finishReason: 'stop' | 'tool_calls' | 'length';
  }): void {
    this.append('model_response', {
      turnIndex: input.turnIndex,
      content: input.content,
      toolCalls: cloneJson(input.toolCalls),
      finishReason: input.finishReason,
    }, input.requestId);
  }

  recordToolCall(input: {
    requestId: string;
    turnIndex: number;
    callId: string;
    toolName: string;
    rawArguments: string;
    parsedArguments: Record<string, unknown>;
  }): void {
    this.append('tool_call', {
      turnIndex: input.turnIndex,
      callId: input.callId,
      toolName: input.toolName,
      rawArguments: input.rawArguments,
      parsedArguments: cloneJson(input.parsedArguments),
    }, input.requestId);
  }

  recordToolResult(input: {
    requestId: string;
    turnIndex: number;
    callId: string;
    toolName: string;
    rawResult: string;
    modelVisibleResult: string;
    /** Execution time only: measured around the tool body, excluding approval waits. */
    durationMs?: number;
    /** `true`/`false` when the tool reported `ok`; absent when the payload says nothing. */
    isError?: boolean;
    /** Files the tool reported producing, as absolute paths. */
    producedFiles?: string[];
    /**
     * The observation payload the runtime raised for this result (`observationId`,
     * `mode`, `sizeChars`, `artifact`, and `loadedCapability` when a capability was
     * loaded). It is small — the result text itself stays in the blob — and the read
     * side needs it to rebuild the tool row the UI renders.
     */
    observation?: Record<string, unknown>;
  }): void {
    const rawResult = this.writeTextBlob(input.rawResult, 'text/plain; charset=utf-8');
    this.append('tool_result', {
      turnIndex: input.turnIndex,
      callId: input.callId,
      toolName: input.toolName,
      rawResult,
      modelVisibleResult: input.modelVisibleResult,
      ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
      ...(typeof input.isError === 'boolean' ? { isError: input.isError } : {}),
      ...(input.producedFiles?.length ? { producedFiles: [...input.producedFiles] } : {}),
      ...(input.observation ? { observation: cloneJson(input.observation) } : {}),
    }, input.requestId);
  }

  end(status: 'completed' | 'failed' | 'cancelled', error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.append('run_end', { status, ...(error ? { error } : {}) });
  }

  private append(
    type: TranscriptEvent['type'],
    data: Record<string, unknown>,
    requestId?: string,
    options: { durable?: boolean } = {},
  ): void {
    const event: TranscriptEvent = {
      schemaVersion: TRANSCRIPT_VERSION,
      eventId: crypto.randomUUID(),
      sequence: this.sequence++,
      createdAt: new Date().toISOString(),
      conversationId: this.conversationId,
      runId: this.runId,
      ...(requestId ? { requestId } : {}),
      type,
      data: cloneJson(data),
    };
    const line = `${JSON.stringify(event)}\n`;
    if (options.durable === false) {
      this.pending.push(line);
      return;
    }
    // A durable record also settles everything buffered before it, so the log on disk
    // never contains a gap in sequence order.
    this.writeLines([...this.pending, line], true);
    this.pending.length = 0;
  }

  /**
   * Append whole lines and, when asked, make them durable.
   *
   * Buffered lines are concatenated into a single write: the log is a text file and
   * nothing downstream depends on one syscall per record.
   */
  private writeLines(lines: readonly string[], sync: boolean): void {
    if (lines.length === 0) return;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(this.eventsPath, 'a', 0o600);
    try {
      fs.writeSync(descriptor, lines.join(''), undefined, 'utf8');
      if (sync) fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private writeTextBlob(content: string, mimeType: string): TranscriptBlobRef {
    const buffer = Buffer.from(content, 'utf8');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileName = `sha256-${sha256}.txt`;
    const target = path.join(this.blobRoot, fileName);
    if (!fs.existsSync(target)) {
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temporary, buffer, { mode: 0o600 });
        fs.renameSync(temporary, target);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    return {
      sha256,
      path: `blobs/${fileName}`,
      bytes: buffer.byteLength,
      mimeType,
    };
  }

  private writeManifest(): void {
    const manifest = path.join(this.root, 'manifest.json');
    if (fs.existsSync(manifest)) return;
    const data = {
      schemaVersion: TRANSCRIPT_VERSION,
      conversationId: this.conversationId,
      createdAt: new Date().toISOString(),
      format: 'append-only-jsonl',
    };
    const temporary = `${manifest}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, manifest);
  }

  private get root(): string {
    return getTranscriptRoot(this.conversationId);
  }

  private get eventsPath(): string {
    return path.join(this.root, EVENTS_FILE);
  }

  private get blobRoot(): string {
    return path.join(this.root, 'blobs');
  }
}

export function createTranscriptRecorder(
  conversationId: string | undefined,
  runId: string | null | undefined,
  identity: TranscriptRunIdentity = {},
): TranscriptRecorder | null {
  return conversationId && runId ? new TranscriptRecorder(conversationId, runId, identity) : null;
}

export function getTranscriptRoot(conversationId: string): string {
  const projectKeyValue = findSessionProjectKey(conversationId);
  if (!projectKeyValue) throw new Error('Unknown conversation for transcript storage.');
  return transcriptDirectory(projectKeyValue, conversationId);
}

export function getTranscriptEventsPath(conversationId: string): string {
  return path.join(getTranscriptRoot(conversationId), EVENTS_FILE);
}

/**
 * Run id for state documents written outside a run.
 *
 * A user action that only changes durable panel state — pausing a goal from the Web UI,
 * for instance — is still a fact the log must own, but it is not a run: there is no model
 * request and no loop. Giving those records their own run id keeps `foldRuns` from
 * inventing an open run for them while letting the ordinary reader and fold see the
 * record in sequence order.
 */
export { STATE_RUN_ID } from './transcript_log.js';

/**
 * Append one state-document event to a conversation's transcript without a run.
 *
 * The caller must guarantee that no run is appending concurrently: the sequence is read
 * from the log tail here, while a live recorder computes its own sequence at construction,
 * so two writers racing would duplicate a sequence or lose an append. `runRegistry` is
 * that guarantee, and it is checked here rather than trusted to every caller: a second
 * writer appended while a run owns the log would corrupt it permanently.
 */
export function appendConversationStateEvent(
  conversationId: string,
  event: { type: string; [key: string]: unknown },
  now: string = new Date().toISOString(),
): void {
  assertConversationId(conversationId);
  if (runRegistry.isActive(conversationId)) {
    throw new Error(
      `Conversation ${conversationId} has an active run; state events must be recorded through that run's recorder.`,
    );
  }
  const eventsPath = getTranscriptEventsPath(conversationId);
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
  const inspection = fs.existsSync(eventsPath)
    ? inspectLogText(fs.readFileSync(eventsPath, 'utf8'))
    : { lastSequence: -1, goodBytes: 0, needsNewline: false, tornTail: false };
  if (inspection.tornTail) {
    // Drop the unusable tail before appending, exactly as the recorder does, so the new
    // record cannot be concatenated onto a half-written line.
    fs.truncateSync(eventsPath, inspection.goodBytes);
  } else if (inspection.needsNewline) {
    fs.appendFileSync(eventsPath, '\n');
  }
  const record: TranscriptEvent = {
    schemaVersion: TRANSCRIPT_VERSION,
    eventId: crypto.randomUUID(),
    sequence: inspection.lastSequence + 1,
    createdAt: now,
    conversationId,
    runId: STATE_RUN_ID,
    type: 'engine_event',
    data: cloneJson({ event }),
  };
  const descriptor = fs.openSync(eventsPath, 'a', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function compactIdentity(identity: TranscriptRunIdentity): Record<string, unknown> {
  const recorded: Record<string, unknown> = {};
  if (identity.agentId) recorded.agentId = identity.agentId;
  if (identity.roleId) recorded.roleId = identity.roleId;
  if (identity.parentConversationId) recorded.parentConversationId = identity.parentConversationId;
  if (identity.parentRunId) recorded.parentRunId = identity.parentRunId;
  if (typeof identity.delegationDepth === 'number') recorded.delegationDepth = identity.delegationDepth;
  return recorded;
}

function assertConversationId(conversationId: string): void {
  assertPathSegment(conversationId, 'conversation id for transcript storage');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
