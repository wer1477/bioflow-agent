import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read-before-write bookkeeping and safe file mutation primitives.
 *
 * The file tools used to overwrite and edit files blindly. That is dangerous for
 * an agent that reads a file in one tool call and writes it many turns later:
 * the user (or another process) may have changed it in between. This module
 * records the version observed by `read_file` per conversation and verifies it
 * immediately before a mutation.
 *
 * Observations are keyed by `conversationId + '\0' + path.resolve(target)`; a
 * conversation without an id (tests, direct dispatcher calls) is never
 * constrained. The table is LRU-bounded per conversation so long sessions
 * cannot leak memory.
 */
export interface FileObservation {
  path: string;
  mtimeMs: number;
  size: number;
  observedAt: number;
}

export type FileSafetyErrorCode = 'FS_NOT_OBSERVED' | 'FS_STALE_VERSION';

export interface FileSafetyFailure {
  ok: false;
  error: { code: FileSafetyErrorCode; message: string };
}

/** Maximum observations retained per conversation; oldest entries are evicted first. */
const MAX_OBSERVATIONS_PER_CONVERSATION = 2_000;

/** conversationId -> resolved path -> last observed version. */
const observationsByConversation = new Map<string, Map<string, FileObservation>>();

/** Serialized mutation tail per resolved path. */
const mutationQueues = new Map<string, Promise<void>>();

function resolveTargetPath(target: string): string | null {
  const raw = String(target ?? '').trim();
  return raw ? path.resolve(raw) : null;
}

function observationTable(conversationId: string): Map<string, FileObservation> {
  let table = observationsByConversation.get(conversationId);
  if (!table) {
    table = new Map<string, FileObservation>();
    observationsByConversation.set(conversationId, table);
  }
  return table;
}

/**
 * Current `stat` snapshot of `target`; `null` when the path does not exist or is
 * not a regular file. A missing file is deliberately not an observation: that
 * is what makes "create a new file" legal without a prior read.
 */
export function statSnapshot(target: string): FileObservation | null {
  const resolved = resolveTargetPath(target);
  if (!resolved) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    return { path: resolved, mtimeMs: stat.mtimeMs, size: stat.size, observedAt: Date.now() };
  } catch {
    return null;
  }
}

/** Records the current version of `target` after a successful read or write. No-op without a conversation. */
export function recordFileObservation(conversationId: string | undefined, target: string): void {
  if (!conversationId) return;
  const resolved = resolveTargetPath(target);
  if (!resolved) return;
  const table = observationTable(conversationId);
  const snapshot = statSnapshot(resolved);
  table.delete(resolved);
  if (!snapshot) return;
  table.set(resolved, snapshot);
  while (table.size > MAX_OBSERVATIONS_PER_CONVERSATION) {
    const oldest = table.keys().next();
    if (oldest.done) break;
    table.delete(oldest.value);
  }
}

/**
 * Verifies that the conversation may mutate `target`.
 *
 * `null` means the write may proceed. A missing file also returns `null`: the
 * operation is a creation, not an overwrite. Otherwise a missing observation is
 * `FS_NOT_OBSERVED` and a changed mtime/size is `FS_STALE_VERSION`; both
 * messages tell the model to call `read_file` again.
 */
export function verifyFileObservation(conversationId: string | undefined, target: string): FileSafetyFailure | null {
  if (!conversationId) return null;
  const resolved = resolveTargetPath(target);
  if (!resolved) return null;
  const current = statSnapshot(resolved);
  if (!current) return null;
  const table = observationsByConversation.get(conversationId);
  const observed = table?.get(resolved);
  if (!observed) {
    return failure(
      'FS_NOT_OBSERVED',
      `${resolved} has not been read in this conversation. Call read_file on it before writing or editing it so the write starts from a known version.`,
    );
  }
  // Refresh LRU position without changing the recorded version.
  table!.delete(resolved);
  table!.set(resolved, observed);
  if (observed.mtimeMs === current.mtimeMs && observed.size === current.size) return null;
  return failure(
    'FS_STALE_VERSION',
    `${resolved} changed since it was last read (read: size ${observed.size}, mtime ${observed.mtimeMs}; now: size ${current.size}, mtime ${current.mtimeMs}). Call read_file on it again before writing; the current content may differ from what you saw.`,
  );
}

/** Drops the observation for `target` (used after a delete or an out-of-band change). */
export function invalidateFileObservation(conversationId: string | undefined, target: string): void {
  if (!conversationId) return;
  const resolved = resolveTargetPath(target);
  if (!resolved) return;
  observationsByConversation.get(conversationId)?.delete(resolved);
}

/** Test hook: forget every recorded observation. */
export function resetFileObservationsForTest(): void {
  observationsByConversation.clear();
}

/**
 * Serializes mutations of the given paths; the returned promise resolves with
 * `fn`'s result. Multiple paths are locked in lexicographic order so concurrent
 * multi-file operations cannot deadlock on each other. `fn` runs while every
 * listed path is held.
 */
export async function withFileMutationQueue<T>(targets: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(targets.map((target) => resolveTargetPath(target)).filter((key): key is string => Boolean(key)))].sort();
  if (!keys.length) return fn();

  const previousTails: Promise<void>[] = [];
  for (const key of keys) {
    const tail = mutationQueues.get(key);
    if (tail) previousTails.push(tail);
  }

  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const key of keys) mutationQueues.set(key, tail);

  try {
    await Promise.all(previousTails);
    return await fn();
  } finally {
    release();
    for (const key of keys) {
      if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
    }
  }
}

/**
 * Writes `data` to `target` atomically: a sibling temp file is written first and
 * then renamed over the target, so readers never observe a half-written file.
 * The previous file mode is preserved, and missing parent directories are
 * created.
 */
export async function atomicWriteFile(target: string, data: string | Buffer, encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> {
  const resolved = resolveTargetPath(target);
  if (!resolved) throw new Error('atomicWriteFile requires a target path.');
  const directory = path.dirname(resolved);
  await fs.promises.mkdir(directory, { recursive: true });

  let previousMode: number | undefined;
  try {
    previousMode = (await fs.promises.stat(resolved)).mode & 0o777;
  } catch {
    previousMode = undefined;
  }

  const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : data;
  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, 'wx', previousMode ?? 0o666);
    await handle.writeFile(buffer);
    await handle.close();
    handle = null;
    if (previousMode !== undefined) await fs.promises.chmod(temporary, previousMode);
    try {
      await fs.promises.rename(temporary, resolved);
    } catch (err) {
      // On platforms where rename-over-existing is not allowed, replace it explicitly.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw err;
      await fs.promises.rm(resolved, { force: true });
      await fs.promises.rename(temporary, resolved);
    }
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
}

function failure(code: FileSafetyErrorCode, message: string): FileSafetyFailure {
  return { ok: false, error: { code, message } };
}
