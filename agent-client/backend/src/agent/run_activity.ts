import { randomUUID } from 'node:crypto';

/**
 * In-process record of the runs that are executing right now.
 *
 * Persisted run records are the durable history, but they cannot answer "is this happening
 * *now*": a process that died mid-run leaves a record whose status still reads as running,
 * and one process cannot see another's records changing. So liveness lives here, in memory,
 * for the life of the process — a restart simply means nothing is running.
 *
 * The registry is deliberately free of any conversation or agent import: it is a leaf that
 * the run state writes to and the HTTP layer reads, never the other way around.
 *
 * `seq` is the reason this is more than a set of ids. The Web shows a completion dot until
 * the user opens that conversation, and it must be able to tell a finish it has already
 * acknowledged from a new one without comparing clocks (the browser and the backend are not
 * guaranteed to share a wall clock). Every terminal transition bumps a monotonic counter
 * instead, and `epoch` invalidates comparisons across restarts.
 */

export type RunActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunActivityRecord {
  conversationId: string;
  /** The run this record describes; the newest run of that conversation. */
  runId: string;
  status: RunActivityStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Monotonic completion counter; see the module comment. */
  seq: number;
}

export interface RunActivitySnapshot {
  /** Changes on every process start, so counters from a previous process are not compared. */
  epoch: string;
  generatedAt: string;
  records: RunActivityRecord[];
}

/** Finished conversations are kept for the dot lifecycle, not forever. */
const MAX_SETTLED_RECORDS = 200;

const epoch = randomUUID();
const records = new Map<string, RunActivityRecord>();
let sequence = 0;

function pruneSettled(): void {
  if (records.size <= MAX_SETTLED_RECORDS) return;
  const settled = [...records.values()]
    .filter((record) => record.status !== 'running')
    .sort((a, b) => (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  for (const record of settled) {
    if (records.size <= MAX_SETTLED_RECORDS) return;
    records.delete(record.conversationId);
  }
}

/**
 * Register a run that just started.
 *
 * Called from the run state the moment its record is created, so a caller that watches the
 * conversation sees it busy before the first model request.
 */
export function beginRunActivity(conversationId: string | null | undefined, runId: string | null | undefined): void {
  const id = String(conversationId || '').trim();
  const run = String(runId || '').trim();
  if (!id || !run) return;
  const previous = records.get(id);
  // Re-entering the same run (a retried begin) must not reset the counter it already owns.
  if (previous?.runId === run && previous.status === 'running') return;
  records.set(id, {
    conversationId: id,
    runId: run,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    seq: previous?.runId === run ? previous.seq : sequence,
  });
  pruneSettled();
}

/**
 * Mark a run as finished.
 *
 * A status correction for a run that already settled (a cancellation recorded after the
 * error that caused it) keeps the same `seq`: the user has one thing to look at, not two.
 */
export function settleRunActivity(
  conversationId: string | null | undefined,
  runId: string | null | undefined,
  status: Exclude<RunActivityStatus, 'running'>,
): void {
  const id = String(conversationId || '').trim();
  const run = String(runId || '').trim();
  if (!id || !run) return;
  const record = records.get(id);
  if (!record || record.runId !== run) return;
  if (record.status !== 'running') {
    if (record.status !== status) records.set(id, { ...record, status });
    return;
  }
  sequence += 1;
  records.set(id, { ...record, status, finishedAt: new Date().toISOString(), seq: sequence });
}

/**
 * Safety net for a run whose completion path never ran (an exception thrown outside the
 * branches that persist a terminal status). A settled record is left untouched.
 */
export function endRunActivity(conversationId: string | null | undefined, runId: string | null | undefined): void {
  const record = records.get(String(conversationId || '').trim());
  if (!record || record.runId !== String(runId || '').trim() || record.status !== 'running') return;
  settleRunActivity(conversationId, runId, 'failed');
}

export function snapshotRunActivity(now = new Date()): RunActivitySnapshot {
  return {
    epoch,
    generatedAt: now.toISOString(),
    records: [...records.values()].map((record) => ({ ...record })),
  };
}

/** Test seam: the registry is process-wide by design, so tests have to be able to clear it. */
export function resetRunActivityForTests(): void {
  records.clear();
  sequence = 0;
}
