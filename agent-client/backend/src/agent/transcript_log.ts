/**
 * Pure, storage-free rules for the transcript log.
 *
 * Both sides of the log depend on these: the writer (`transcript_store.ts`) uses
 * `inspectLogText` to decide what it may append after, and the reader
 * (`transcript_reader.ts`) uses the same parsers to hand records back. Keeping one
 * implementation is the point — a second copy of the recovery policy is how a log
 * ends up with two different ideas of what is valid.
 *
 * Nothing here touches the filesystem, so every crash shape is unit-testable.
 */

/**
 * A stored record, read back. `type` is widened to `string` because a log written by
 * a newer build must stay readable here — the reader must not pretend the writer's
 * union is the whole vocabulary.
 */
export interface TranscriptRecord {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  createdAt: string;
  conversationId: string;
  runId: string;
  requestId?: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ParsedTranscript {
  events: TranscriptRecord[];
  /**
   * True when the final line could not be used and was dropped. Callers decide what
   * to do about it; parsing never rewrites anything.
   */
  tornTail: boolean;
}

export type TranscriptRunStatus = 'completed' | 'failed' | 'cancelled' | 'open';

/**
 * Run id used for state documents that no run owns (see the doc comment in
 * `transcript_store.appendConversationStateEvent`). It lives in this pure module because
 * `foldRuns` must recognize it without depending on the storage layer.
 */
export const STATE_RUN_ID = 'state';

export interface TranscriptRunSummary {
  runId: string;
  status: TranscriptRunStatus;
  startedAt: string;
  /** Null while the run is open — either still live, or interrupted by a crash. */
  endedAt: string | null;
  eventCount: number;
}

export interface LogTailInspection {
  /** Sequence of the last usable record, or -1 when the log holds nothing usable. */
  lastSequence: number;
  /** Length of the prefix that must be kept. Everything past it is unusable. */
  goodBytes: number;
  /** True when the kept prefix lacks a terminating newline and must get one before appending. */
  needsNewline: boolean;
  /** True when an unusable final record was dropped. */
  tornTail: boolean;
}

/** Thrown for a log that cannot be read faithfully. Never thrown for a torn tail. */
export class TranscriptLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptLogError';
  }
}

/**
 * Parse the log text.
 *
 * A record is only ever appended as `line + '\n'` in a single write, so a file whose
 * last line has no terminating newline was interrupted mid-write. We still try to
 * parse that last segment: if it happens to be a complete record we keep it (maximising
 * recovery), and only drop it when it is genuinely unusable. Every other line must
 * parse — a malformed interior line means the committed prefix is damaged, which is
 * corruption and must not be silently skipped.
 */
export function parseTranscriptText(text: string): ParsedTranscript {
  if (!text) return { events: [], tornTail: false };

  const hasFinalNewline = text.endsWith('\n');
  const segments = text.split('\n');
  // A trailing newline produces one empty segment; a missing one produces none, and
  // in that case the final segment is the record that was still being written.
  if (hasFinalNewline) segments.pop();

  let tornTail = false;
  if (!hasFinalNewline) {
    const tail = segments.pop() ?? '';
    if (tryParseRecord(tail)) {
      segments.push(tail);
    } else if (tail.trim()) {
      tornTail = true;
    }
  }

  const events: TranscriptRecord[] = [];
  for (const segment of segments) {
    if (!segment.trim()) continue;
    const record = tryParseRecord(segment);
    if (!record) {
      throw new TranscriptLogError('Transcript event log is damaged: a committed record could not be parsed.');
    }
    events.push(record);
  }
  return { events, tornTail };
}

/**
 * Sequences must start at 0 and increase by exactly one. A gap means lost records;
 * a repeat means two writers disagreed about the log length. Both are corruption,
 * and neither may be smoothed over — an earlier build silently restarted numbering
 * at 0 when it could not read the last sequence, producing duplicate numbers that
 * nothing downstream could detect.
 */
export function assertContiguousSequences(events: readonly TranscriptRecord[]): void {
  let expected = 0;
  for (const event of events) {
    if (event.sequence !== expected) {
      throw new TranscriptLogError(
        `Transcript sequence is not contiguous: expected ${expected} but found ${event.sequence}.`,
      );
    }
    expected += 1;
  }
}

/**
 * Group records by run, in first-appearance order.
 *
 * A run without `run_end` is reported as `open`: the reader cannot tell a live run
 * from one killed by a crash, and guessing "interrupted" would be wrong for the
 * former. Consumers label an open run as unfinished; they must not infer an outcome.
 */
export function foldRuns(events: readonly TranscriptRecord[]): TranscriptRunSummary[] {
  const runs = new Map<string, TranscriptRunSummary>();
  for (const event of events) {
    const runId = event.runId;
    if (!runId || runId === STATE_RUN_ID) continue;
    const summary = runs.get(runId) ?? {
      runId,
      status: 'open' as TranscriptRunStatus,
      startedAt: event.createdAt,
      endedAt: null,
      eventCount: 0,
    };
    summary.eventCount += 1;
    if (event.type === 'run_end') {
      const data = (event.data ?? {}) as { status?: unknown };
      summary.status = isRunStatus(data.status) ? data.status : 'failed';
      summary.endedAt = event.createdAt;
    }
    runs.set(runId, summary);
  }
  return [...runs.values()];
}

/**
 * Decide what a writer may append after, and what it must discard first.
 *
 * This is the single place that answers "where does the committed prefix end?".
 * It refuses to guess: a log whose committed prefix is internally inconsistent
 * throws rather than silently renumbering, because renumbering is what produced
 * duplicate sequence numbers that nothing downstream could detect.
 */
export function inspectLogText(text: string): LogTailInspection {
  if (!text) return { lastSequence: -1, goodBytes: 0, needsNewline: false, tornTail: false };

  const parsed = parseTranscriptText(text);
  assertContiguousSequences(parsed.events);
  const lastSequence = parsed.events.length ? parsed.events[parsed.events.length - 1]!.sequence : -1;

  if (parsed.tornTail) {
    // Drop only the unusable tail. The kept prefix ends at the last newline, so it is
    // already terminated.
    return { lastSequence, goodBytes: text.lastIndexOf('\n') + 1, needsNewline: false, tornTail: true };
  }
  return {
    lastSequence,
    goodBytes: text.length,
    // A complete record that lost its newline must be terminated before the next
    // append, or the next record would be concatenated onto it.
    needsNewline: !text.endsWith('\n'),
    tornTail: false,
  };
}

function tryParseRecord(segment: string): TranscriptRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(segment);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { sequence?: unknown; type?: unknown };
  if (!Number.isInteger(record.sequence) || Number(record.sequence) < 0) return null;
  if (typeof record.type !== 'string' || !record.type) return null;
  return value as TranscriptRecord;
}

function isRunStatus(value: unknown): value is TranscriptRunStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'open';
}
