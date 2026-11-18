import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { uploadsRoot } from '../paths.js';
import { getProjectFileInfo, resolveProjectPath } from '../agent/config/project_files.js';
import type { ProjectFileInfo } from '../agent/config/project_files.js';

/**
 * Resumable chunked uploads for project files.
 *
 * The browser never sends a whole large file: it opens a session, sends fixed
 * size chunks (possibly out of order and retried), and asks the server to
 * complete the upload. Chunks are written at their final offset inside a
 * sparse temp file, so completing an upload is a single `rename` on the same
 * filesystem — no second copy, no full-file buffer in memory.
 *
 * Sessions live under `WORKSPACE_ROOT/.runtime/uploads/<uuid>/` and expire
 * after `UPLOAD_TTL_MS`; the project tree never shows a half-written file.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Keep a safety margin so completing an upload cannot fill the data volume. */
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 8;
const MAX_PROJECT_UPLOADS = 4;
/**
 * A directory without a readable meta.json is either left over from a crash
 * or an `initUpload` that has not written its meta yet; only reclaim it after
 * this grace period so a concurrent init cannot be deleted underneath itself.
 */
const ORPHAN_DIR_GRACE_MS = 60 * 60 * 1000;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Client-facing state of one upload session. */
export interface UploadView {
  id: string;
  name: string;
  path: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  received: number[];
  receivedBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** Expected request failures; the route turns them into status + JSON code. */
export class UploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.code = code;
  }
}

interface UploadMeta {
  id: string;
  projectKey: string;
  targetPath: string;
  size: number;
  chunkSize: number;
  createdAt: string;
  updatedAt: string;
  received: number[];
}

interface UploadRecord {
  /** The user workspace this session belongs to; the cache key includes it. */
  root: string;
  meta: UploadMeta;
  dir: string;
  dataPath: string;
  received: Set<number>;
  /** Serializes meta.json writes so two concurrent chunks cannot clobber each other. */
  persistChain: Promise<void>;
}

interface ScannedUpload {
  dir: string;
  meta: UploadMeta | null;
  mtimeMs: number;
}

export interface InitUploadInput {
  projectKey: string;
  targetPath: string;
  size: unknown;
}

const records = new Map<string, UploadRecord>();

function recordCacheKey(root: string, id: string): string {
  return `${root}\u0000${id}`;
}

function chunkCountOf(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize);
}

function chunkLengthOf(index: number, size: number, chunkSize: number): number {
  return Math.max(0, Math.min(chunkSize, size - index * chunkSize));
}

function receivedBytesOf(meta: UploadMeta, received: Set<number>): number {
  let total = 0;
  for (const index of received) total += chunkLengthOf(index, meta.size, meta.chunkSize);
  return total;
}

function isExpired(meta: UploadMeta, now = Date.now()): boolean {
  const updated = Date.parse(meta.updatedAt);
  return !Number.isFinite(updated) || updated + UPLOAD_TTL_MS < now;
}

function uploadNotFound(message = 'Upload session not found.'): UploadError {
  return new UploadError(404, 'UPLOAD_NOT_FOUND', message);
}

async function ensureUploadsRoot(): Promise<void> {
  await fsp.mkdir(uploadsRoot(), { recursive: true });
}

function parseMeta(raw: string, id: string): UploadMeta | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.id !== id) return null;
    const projectKey = typeof candidate.projectKey === 'string' ? candidate.projectKey : '';
    const targetPath = typeof candidate.targetPath === 'string' ? candidate.targetPath : '';
    const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : '';
    const updatedAt = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '';
    const size = Number(candidate.size);
    const chunkSize = Number(candidate.chunkSize);
    if (!projectKey || !targetPath || !createdAt || !updatedAt) return null;
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) return null;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) return null;
    if (!Array.isArray(candidate.received)) return null;
    const total = chunkCountOf(size, chunkSize);
    const received = candidate.received
      .map((item) => Number(item))
      .filter((item) => Number.isSafeInteger(item) && item >= 0 && item < total);
    return { id, projectKey, targetPath, size, chunkSize, createdAt, updatedAt, received };
  } catch {
    return null;
  }
}

async function readMeta(dir: string, id: string): Promise<UploadMeta | null> {
  try {
    return parseMeta(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'), id);
  } catch {
    return null;
  }
}

async function writeMeta(dir: string, meta: UploadMeta): Promise<void> {
  const file = path.join(dir, 'meta.json');
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(meta), 'utf8');
  await fsp.rename(temporary, file);
}

function persistRecord(record: UploadRecord): Promise<void> {
  const snapshot: UploadMeta = { ...record.meta, received: [...record.received].sort((a, b) => a - b) };
  const write = (): Promise<void> => writeMeta(record.dir, snapshot);
  // Run the write whether or not the previous one failed: one transient disk
  // error must not stop every later checkpoint.
  record.persistChain = record.persistChain.then(write, write);
  return record.persistChain;
}

async function dropRecord(record: UploadRecord): Promise<void> {
  records.delete(recordCacheKey(record.root, record.meta.id));
  await fsp.rm(record.dir, { recursive: true, force: true });
}

function toView(record: UploadRecord): UploadView {
  const { meta } = record;
  return {
    id: meta.id,
    name: path.basename(meta.targetPath),
    path: meta.targetPath,
    size: meta.size,
    chunkSize: meta.chunkSize,
    chunkCount: chunkCountOf(meta.size, meta.chunkSize),
    received: [...record.received].sort((a, b) => a - b),
    receivedBytes: receivedBytesOf(meta, record.received),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

async function loadRecord(projectKey: string, id: string): Promise<UploadRecord> {
  if (!SESSION_ID_PATTERN.test(id)) throw uploadNotFound();
  const root = uploadsRoot();
  const cacheKey = recordCacheKey(root, id);
  const cached = records.get(cacheKey);
  if (cached) {
    if (cached.meta.projectKey !== projectKey) throw uploadNotFound();
    if (isExpired(cached.meta)) {
      await dropRecord(cached);
      throw uploadNotFound('Upload session expired.');
    }
    return cached;
  }
  await ensureUploadsRoot();
  const dir = path.join(root, id);
  const meta = await readMeta(dir, id);
  if (!meta || meta.projectKey !== projectKey) throw uploadNotFound();
  if (isExpired(meta)) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw uploadNotFound('Upload session expired.');
  }
  const record: UploadRecord = {
    root,
    meta,
    dir,
    dataPath: path.join(dir, 'data'),
    received: new Set(meta.received),
    persistChain: Promise.resolve(),
  };
  records.set(cacheKey, record);
  return record;
}

async function scanUploadDirs(): Promise<ScannedUpload[]> {
  await ensureUploadsRoot();
  const root = uploadsRoot();
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const scanned: ScannedUpload[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const info = await fsp.stat(dir).catch(() => null);
    if (!info) continue;
    scanned.push({ dir, meta: await readMeta(dir, entry.name), mtimeMs: info.mtimeMs });
  }
  return scanned;
}

/** Removes expired sessions and old metadata-less directories. */
export async function sweepExpiredUploads(now = Date.now()): Promise<void> {
  const root = uploadsRoot();
  const scanned = await scanUploadDirs();
  for (const item of scanned) {
    if (item.meta) {
      if (!isExpired(item.meta, now)) continue;
      records.delete(recordCacheKey(root, item.meta.id));
      await fsp.rm(item.dir, { recursive: true, force: true });
      continue;
    }
    if (now - item.mtimeMs > ORPHAN_DIR_GRACE_MS) {
      await fsp.rm(item.dir, { recursive: true, force: true });
    }
  }
}

async function freeBytes(): Promise<number | null> {
  try {
    const stats = await fsp.statfs(uploadsRoot());
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return null;
  }
}

/** Opens a session; the caller has already validated the target path. */
export async function initUpload(input: InitUploadInput): Promise<UploadView> {
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new UploadError(400, 'INVALID_UPLOAD', 'Upload size must be a positive integer.');
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, 'FILE_TOO_LARGE', `Files larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 ** 3)} GB are not supported.`);
  }
  const projectKey = String(input.projectKey || '').trim();
  const targetPath = String(input.targetPath || '').trim();
  if (!projectKey || !targetPath) {
    throw new UploadError(400, 'INVALID_UPLOAD', 'A project and a target path are required.');
  }
  if (path.isAbsolute(targetPath) || targetPath.split(/[\\/]/).includes('..')) {
    throw new UploadError(400, 'INVALID_UPLOAD', 'Upload path escapes the project directory.');
  }

  await sweepExpiredUploads().catch(() => {});
  const existing = await scanUploadDirs();
  const active = existing.filter((item) => item.meta && !isExpired(item.meta));
  if (active.length >= MAX_ACTIVE_UPLOADS) {
    throw new UploadError(429, 'TOO_MANY_UPLOADS', 'Too many uploads are in progress. Finish or cancel one first.');
  }
  if (active.filter((item) => item.meta?.projectKey === projectKey).length >= MAX_PROJECT_UPLOADS) {
    throw new UploadError(429, 'TOO_MANY_UPLOADS', 'Too many uploads are in progress for this project.');
  }
  const free = await freeBytes();
  if (free !== null && free < size + MIN_FREE_BYTES) {
    throw new UploadError(507, 'INSUFFICIENT_STORAGE', 'Not enough free disk space for this upload.');
  }

  const id = crypto.randomUUID();
  const root = uploadsRoot();
  const dir = path.join(root, id);
  const now = new Date().toISOString();
  const meta: UploadMeta = {
    id,
    projectKey,
    targetPath,
    size,
    chunkSize: UPLOAD_CHUNK_BYTES,
    createdAt: now,
    updatedAt: now,
    received: [],
  };
  const record: UploadRecord = {
    root,
    meta,
    dir,
    dataPath: path.join(dir, 'data'),
    received: new Set(),
    persistChain: Promise.resolve(),
  };
  try {
    await fsp.mkdir(dir, { recursive: true });
    const handle = await fsp.open(record.dataPath, 'w');
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
    await writeMeta(dir, meta);
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  records.set(recordCacheKey(root, id), record);
  return toView(record);
}

export async function getUpload(projectKey: string, id: string): Promise<UploadView> {
  return toView(await loadRecord(projectKey, id));
}

export async function listUploads(projectKey: string): Promise<UploadView[]> {
  await sweepExpiredUploads().catch(() => {});
  const root = uploadsRoot();
  const scanned = await scanUploadDirs();
  const views: UploadView[] = [];
  for (const item of scanned) {
    if (!item.meta || item.meta.projectKey !== projectKey || isExpired(item.meta)) continue;
    const cached = records.get(recordCacheKey(root, item.meta.id));
    if (cached) {
      // The in-memory record is ahead of meta.json while a write is pending.
      views.push(toView(cached));
      continue;
    }
    const record: UploadRecord = {
      root,
      meta: item.meta,
      dir: item.dir,
      dataPath: path.join(item.dir, 'data'),
      received: new Set(item.meta.received),
      persistChain: Promise.resolve(),
    };
    records.set(recordCacheKey(root, item.meta.id), record);
    views.push(toView(record));
  }
  return views.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface UploadChunkProgress {
  index: number;
  receivedCount: number;
  receivedBytes: number;
}

/** Writes one chunk at its final offset; duplicate chunks are idempotent. */
export async function writeUploadChunk(
  projectKey: string,
  id: string,
  index: number,
  data: Buffer,
): Promise<UploadChunkProgress> {
  const record = await loadRecord(projectKey, id);
  const { meta } = record;
  const total = chunkCountOf(meta.size, meta.chunkSize);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new UploadError(400, 'INVALID_CHUNK_INDEX', `Chunk index must be an integer between 0 and ${total - 1}.`);
  }
  const expected = chunkLengthOf(index, meta.size, meta.chunkSize);
  if (data.length !== expected) {
    throw new UploadError(400, 'CHUNK_SIZE_MISMATCH', `Chunk ${index} must be ${expected} bytes, received ${data.length}.`);
  }
  if (data.length) {
    const handle = await fsp.open(record.dataPath, 'r+');
    try {
      await handle.write(data, 0, data.length, index * meta.chunkSize);
    } finally {
      await handle.close();
    }
  }
  record.received.add(index);
  meta.updatedAt = new Date().toISOString();
  await persistRecord(record);
  return { index, receivedCount: record.received.size, receivedBytes: receivedBytesOf(meta, record.received) };
}

/** Verifies all chunks are present and renames the temp file into the project. */
export async function completeUpload(
  projectKey: string,
  id: string,
  projectPath: string,
): Promise<{ relativePath: string; file: ProjectFileInfo }> {
  const record = await loadRecord(projectKey, id);
  const { meta } = record;
  const total = chunkCountOf(meta.size, meta.chunkSize);
  if (record.received.size < total) {
    throw new UploadError(409, 'UPLOAD_INCOMPLETE', `Upload is missing ${total - record.received.size} of ${total} chunks.`);
  }
  const stat = await fsp.stat(record.dataPath).catch(() => null);
  if (!stat || stat.size !== meta.size) {
    throw new UploadError(409, 'UPLOAD_INCOMPLETE', 'Uploaded data does not match the declared size.');
  }
  const handle = await fsp.open(record.dataPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Re-validates containment at completion: the project root may have moved
  // or the target may now be a directory.
  const target = resolveProjectPath(projectPath, meta.targetPath, true);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const existing = await fsp.stat(target).catch(() => null);
  if (existing?.isDirectory()) {
    throw new UploadError(409, 'TARGET_IS_DIRECTORY', 'The upload target is a directory.');
  }
  await fsp.rename(record.dataPath, target);
  await dropRecord(record);
  return { relativePath: meta.targetPath, file: getProjectFileInfo(projectPath, meta.targetPath) };
}

/** Cancels a session; cancelling an unknown/expired session is a no-op. */
export async function cancelUpload(projectKey: string, id: string): Promise<void> {
  let record: UploadRecord;
  try {
    record = await loadRecord(projectKey, id);
  } catch (error) {
    if (error instanceof UploadError && error.status === 404) return;
    throw error;
  }
  await dropRecord(record);
}
