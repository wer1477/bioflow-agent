import { formatWorkspaceByteSize } from './workspace.js';

/**
 * 大文件上传的纯逻辑：阈值分流、分块算术、续传索引、速率/ETA 估算。
 * 这里不碰 DOM、fetch 或 localStorage，便于用 node --test 直接验证。
 */

/** 超过这个大小的文件走分块；更小的继续用原来的单请求直传。 */
export const CHUNK_UPLOAD_THRESHOLD = 64 * 1024 * 1024;

/** 同时在途的分块请求数（服务端协议允许乱序）。 */
export const UPLOAD_CHUNK_CONCURRENCY = 2;

export function shouldChunkUpload(size) {
  const bytes = Number(size);
  return Number.isFinite(bytes) && bytes > CHUNK_UPLOAD_THRESHOLD;
}

export function uploadChunkCount(size, chunkSize) {
  const total = Number(size);
  const chunk = Number(chunkSize);
  if (!Number.isFinite(total) || !Number.isFinite(chunk) || total <= 0 || chunk <= 0) return 0;
  return Math.ceil(total / chunk);
}

export function uploadChunkLength(index, size, chunkSize) {
  const start = Number(index) * Number(chunkSize);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.min(Number(chunkSize), Number(size) - start));
}

export function uploadReceivedBytes(received, size, chunkSize) {
  let bytes = 0;
  for (const index of received || []) bytes += uploadChunkLength(index, size, chunkSize);
  return bytes;
}

/** 当前并发槽位能立即发送的块，优先最靠前的缺口。 */
export function nextUploadChunks(received, inFlight, chunkCount, limit) {
  const taken = inFlight instanceof Set ? inFlight : new Set(inFlight || []);
  const count = Number(chunkCount) || 0;
  const slots = Number(limit) || 0;
  const indexes = [];
  for (let index = 0; index < count && indexes.length < slots; index += 1) {
    if (received?.has?.(index) || taken.has(index)) continue;
    indexes.push(index);
  }
  return indexes;
}

export function uploadPercent(receivedBytes, size) {
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const done = Math.max(0, Math.min(total, Number(receivedBytes) || 0));
  return Math.min(100, Math.floor((done / total) * 100));
}

/** 任务指纹：文件名 + 大小 + 修改时间；刷新后用它判断重选的是不是同一个文件。 */
export function uploadFingerprint(file) {
  return `${file?.name || ''}|${Number(file?.size) || 0}|${Number(file?.lastModified) || 0}`;
}

export function fingerprintMatches(task, file) {
  if (!file || !task) return false;
  if (task.name !== file.name) return false;
  if (Number(task.size) !== Number(file.size)) return false;
  const expected = Number(task.lastModified) || 0;
  const actual = Number(file.lastModified) || 0;
  return expected === 0 || actual === 0 || expected === actual;
}

export function uploadRetryDelay(attempt) {
  const value = Math.max(1, Number(attempt) || 1);
  return Math.min(30000, 1000 * (2 ** (value - 1)));
}

/** 最近 windowMs 内的平均速率；样本不足时返回 0，避免用一次抖动算 ETA。 */
export function averageUploadSpeed(samples, now = Date.now(), windowMs = 5000) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const cutoff = now - Math.max(1, Number(windowMs) || 5000);
  let first = samples[0];
  for (const sample of samples) {
    if (Number(sample?.at) >= cutoff) {
      first = sample;
      break;
    }
  }
  const last = samples[samples.length - 1];
  const span = (Number(last?.at) - Number(first?.at)) / 1000;
  const bytes = Number(last?.bytes) - Number(first?.bytes);
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / span;
}

export function formatUploadSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value <= 0) return '0 B/s';
  return `${formatWorkspaceByteSize(Math.round(value))}/s`;
}

export function formatUploadEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}
