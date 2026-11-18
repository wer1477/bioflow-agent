import { ApiError, apiJson, uploadChunk } from './api.js';
import { projectUploadPath } from './domain/workspace.js';
import {
  UPLOAD_CHUNK_CONCURRENCY,
  averageUploadSpeed,
  fingerprintMatches,
  nextUploadChunks,
  uploadChunkLength,
  uploadPercent,
  uploadReceivedBytes,
  uploadRetryDelay,
} from './domain/upload.js';

/**
 * 大文件上传任务队列（模块级单例）。
 *
 * - 同一时刻只跑一个大文件，块并发 2；任务不挂在 React state 上，切会话/标签页不中断。
 * - 每块独立重试（1s/2s/4s），失败可手动重试；刷新后任务留在 localStorage，
 *   标记为 needs-file，用户重选同一文件后从服务端已收的 offset 继续。
 * - 完成事件交给 useWorkspace 刷新文件树，管理器不持有任何 React 依赖。
 */

const STORAGE_KEY = 'bioflow-uploads-v1';
const MAX_RETRIES = 3;
const MAX_SAMPLES = 20;
const PERSIST_DELAY_MS = 150;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

let tasks = [];
let snapshot = [];
let activeTaskId = '';
let restored = false;
let persistTimer = null;
const stateListeners = new Set();
const eventListeners = new Set();

function nextId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // 非安全上下文没有 randomUUID；退回时间戳即可，本地 id 不需要密码学随机。
  }
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function uploadsUrl(projectKey, suffix = '') {
  return `/api/projects/${encodeURIComponent(projectKey)}/uploads${suffix}`;
}

function sessionQuery(sessionId) {
  return sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitState() {
  // 任务对象是原地更新的；换一个新数组引用，useSyncExternalStore 才会通知重渲染。
  snapshot = tasks.slice();
  for (const listener of stateListeners) {
    try {
      listener();
    } catch {
      // 一个坏掉的订阅者不能阻断上传。
    }
  }
}

function emitEvent(event) {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch {
      // 同上。
    }
  }
}

function removeTask(id) {
  tasks = tasks.filter((task) => task.id !== id);
}

function findTask(id) {
  return tasks.find((task) => task.id === id) || null;
}

function isTaskAttached(task) {
  return tasks.includes(task);
}

function abortTaskControllers(task) {
  for (const controller of task.controllers) {
    try {
      controller.abort();
    } catch {
      // 已经结束的请求会忽略 abort。
    }
  }
  task.controllers.clear();
}

function uploadErrorMessage(error) {
  if (error instanceof ApiError) {
    const code = error.payload?.code;
    if (code === 'FILE_TOO_LARGE') return '文件超过 10GB 上限';
    if (code === 'INSUFFICIENT_STORAGE') return '服务器可用磁盘空间不足';
    if (code === 'TOO_MANY_UPLOADS') return '同时进行的上传过多，请先完成或取消一个';
    if (code === 'UPLOAD_NOT_FOUND') return '上传会话已过期，请重新上传';
    if (code === 'UPLOAD_INCOMPLETE') return '还有分块没有传完';
    if (code === 'TARGET_IS_DIRECTORY') return '目标路径是一个目录，不能覆盖';
    if (code === 'CHUNK_SIZE_MISMATCH' || code === 'INVALID_CHUNK_INDEX') return '分块状态与服务器不一致，请重试';
    return error.message || `上传失败（HTTP ${error.status}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isRetryableError(error) {
  if (error instanceof ApiError) {
    const status = Number(error.status) || 0;
    if (status === 408 || status === 429) return true;
    return status >= 500;
  }
  // fetch 的网络错误（TypeError）和断开连接都可以重试。
  return true;
}

function createTask(file, { projectKey, directory = '', sessionId = '' }) {
  return {
    id: nextId(),
    projectKey,
    sessionId,
    name: file.name || 'upload.bin',
    // 与直传使用同一个目标路径规则：落在文件树当前浏览的目录。
    path: projectUploadPath(file, directory),
    size: Number(file.size) || 0,
    lastModified: Number(file.lastModified) || 0,
    file,
    uploadId: '',
    chunkSize: 0,
    chunkCount: 0,
    received: new Set(),
    inFlight: new Set(),
    controllers: new Set(),
    samples: [],
    receivedCount: 0,
    receivedBytes: 0,
    percent: 0,
    speed: 0,
    etaSeconds: 0,
    status: 'preparing',
    error: '',
    completing: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 入队一批大文件；返回新任务，便于调用方聚焦。 */
export function enqueueUploads(files, context) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [files].filter(Boolean);
  if (!list.length || !context?.projectKey) return [];
  const created = list.map((file) => createTask(file, context));
  tasks = [...created, ...tasks];
  emitState();
  persist();
  for (const task of created) void prepareTask(task);
  return created;
}

async function prepareTask(task) {
  try {
    const data = await apiJson(uploadsUrl(task.projectKey), {
      method: 'POST',
      body: JSON.stringify({ path: task.path, size: task.size }),
    });
    const upload = data.upload;
    if (!isTaskAttached(task)) {
      // 初始化的几毫秒里被取消了：把服务器刚建好的会话也删掉，别留孤儿。
      void apiJson(uploadsUrl(task.projectKey, `/${upload.id}`), { method: 'DELETE' }).catch(() => {});
      return;
    }
    task.uploadId = upload.id;
    task.chunkSize = upload.chunkSize;
    task.chunkCount = upload.chunkCount;
    task.received = new Set(upload.received || []);
    task.receivedCount = task.received.size;
    task.receivedBytes = upload.receivedBytes || 0;
    task.percent = uploadPercent(task.receivedBytes, task.size);
    task.status = task.status === 'paused' ? 'paused' : 'queued';
    task.error = '';
    task.updatedAt = Date.now();
  } catch (error) {
    if (!isTaskAttached(task)) return;
    task.status = 'failed';
    task.error = uploadErrorMessage(error);
  }
  emitState();
  persist();
  runNext();
}

function runNext() {
  if (activeTaskId) return;
  const next = tasks.find((task) => task.status === 'queued' && task.file);
  if (!next) return;
  activeTaskId = next.id;
  next.status = 'uploading';
  next.completing = false;
  next.samples = [{ at: Date.now(), bytes: next.receivedBytes }];
  next.speed = 0;
  next.etaSeconds = 0;
  next.updatedAt = Date.now();
  emitState();
  pump(next);
}

function pump(task) {
  if (task.status !== 'uploading' || !task.file) return;
  if (task.completing) return;
  const slots = Math.max(0, UPLOAD_CHUNK_CONCURRENCY - task.inFlight.size);
  const indexes = nextUploadChunks(task.received, task.inFlight, task.chunkCount, slots);
  for (const index of indexes) {
    task.inFlight.add(index);
    sendChunk(task, index)
      .catch(() => {})
      .finally(() => {
        task.inFlight.delete(index);
        if (task.status !== 'uploading') return;
        emitState();
        if (task.received.size >= task.chunkCount && task.inFlight.size === 0) {
          void finishTask(task);
          return;
        }
        pump(task);
      });
  }
  if (!indexes.length && task.inFlight.size === 0 && task.received.size >= task.chunkCount) {
    void finishTask(task);
  }
}

async function sendChunk(task, index) {
  if (!task.file) return;
  const start = index * task.chunkSize;
  const end = Math.min(task.size, start + task.chunkSize);
  const blob = task.file.slice(start, end);
  let attempt = 1;
  for (;;) {
    const controller = new AbortController();
    task.controllers.add(controller);
    try {
      await uploadChunk(uploadsUrl(task.projectKey, `/${task.uploadId}/chunks/${index}`), blob, { signal: controller.signal });
      task.controllers.delete(controller);
      task.received.add(index);
      task.receivedCount = task.received.size;
      task.receivedBytes = uploadReceivedBytes(task.received, task.size, task.chunkSize);
      task.percent = uploadPercent(task.receivedBytes, task.size);
      task.samples.push({ at: Date.now(), bytes: task.receivedBytes });
      if (task.samples.length > MAX_SAMPLES) task.samples.shift();
      task.speed = averageUploadSpeed(task.samples, Date.now());
      task.etaSeconds = task.speed > 0 ? Math.round((task.size - task.receivedBytes) / task.speed) : 0;
      task.updatedAt = Date.now();
      emitState();
      persist();
      return;
    } catch (error) {
      task.controllers.delete(controller);
      if (task.status !== 'uploading') return;
      if (error?.name === 'AbortError') return;
      if (!isRetryableError(error) || attempt >= MAX_RETRIES) {
        failTask(task, uploadErrorMessage(error));
        return;
      }
      await sleep(uploadRetryDelay(attempt));
      attempt += 1;
    }
  }
}

function failTask(task, message) {
  task.status = 'failed';
  task.error = message || '上传失败';
  task.completing = false;
  task.updatedAt = Date.now();
  abortTaskControllers(task);
  task.inFlight.clear();
  if (activeTaskId === task.id) activeTaskId = '';
  emitState();
  persist();
  runNext();
}

async function syncTaskStatus(task) {
  if (!task.uploadId) return;
  const data = await apiJson(uploadsUrl(task.projectKey, `/${task.uploadId}`));
  const upload = data.upload;
  task.chunkSize = upload.chunkSize;
  task.chunkCount = upload.chunkCount;
  task.received = new Set(upload.received || []);
  task.receivedCount = task.received.size;
  task.receivedBytes = upload.receivedBytes || 0;
  task.percent = uploadPercent(task.receivedBytes, task.size);
  emitState();
}

async function finishTask(task) {
  if (task.completing || task.status !== 'uploading') return;
  task.completing = true;
  task.status = 'completing';
  emitState();
  try {
    const data = await apiJson(
      uploadsUrl(task.projectKey, `/${task.uploadId}/complete${sessionQuery(task.sessionId)}`),
      { method: 'POST' },
    );
    task.status = 'completed';
    task.file = null;
    task.completing = false;
    task.updatedAt = Date.now();
    emitEvent({ type: 'completed', projectKey: task.projectKey, taskId: task.id, payload: data });
  } catch (error) {
    if (error instanceof ApiError && error.payload?.code === 'UPLOAD_INCOMPLETE') {
      // 服务器有本地没有的块（例如另一个标签页传过）：同步后继续补缺口。
      task.completing = false;
      task.status = 'uploading';
      emitState();
      try {
        await syncTaskStatus(task);
      } catch {
        // 同步失败就按本地状态继续；重复块是幂等的。
      }
      pump(task);
      return;
    }
    task.completing = false;
    failTask(task, uploadErrorMessage(error));
    return;
  }
  if (activeTaskId === task.id) activeTaskId = '';
  emitState();
  persist();
  runNext();
}

export function pauseUpload(id) {
  const task = findTask(id);
  if (!task) return;
  if (!['preparing', 'queued', 'uploading'].includes(task.status)) return;
  task.status = 'paused';
  task.completing = false;
  task.updatedAt = Date.now();
  abortTaskControllers(task);
  task.inFlight.clear();
  if (activeTaskId === task.id) activeTaskId = '';
  emitState();
  persist();
  runNext();
}

export function resumeUpload(id) {
  const task = findTask(id);
  if (!task || !task.file) return;
  if (task.status !== 'paused') return;
  task.status = 'queued';
  task.error = '';
  task.updatedAt = Date.now();
  emitState();
  persist();
  runNext();
}

export function retryUpload(id) {
  const task = findTask(id);
  if (!task || task.status !== 'failed') return;
  task.error = '';
  task.updatedAt = Date.now();
  if (!task.uploadId) {
    task.status = 'preparing';
    emitState();
    persist();
    void prepareTask(task);
    return;
  }
  if (!task.file) {
    task.status = 'needs-file';
    emitState();
    persist();
    return;
  }
  task.status = 'queued';
  emitState();
  persist();
  syncTaskStatus(task)
    .catch(() => {})
    .finally(() => {
      if (task.status !== 'queued') return;
      emitState();
      runNext();
    });
}

export function cancelUpload(id) {
  const task = findTask(id);
  if (!task) return;
  abortTaskControllers(task);
  task.inFlight.clear();
  if (activeTaskId === task.id) activeTaskId = '';
  removeTask(id);
  emitState();
  persist();
  if (task.uploadId) {
    void apiJson(uploadsUrl(task.projectKey, `/${task.uploadId}`), { method: 'DELETE' }).catch(() => {});
  }
  runNext();
}

export function dismissUpload(id) {
  const task = findTask(id);
  if (!task) return;
  if (TERMINAL_STATUSES.has(task.status)) {
    removeTask(id);
    emitState();
    persist();
    return;
  }
  cancelUpload(id);
}

/**
 * 刷新后把任务接回来。File 无法持久化，所以只能先标记 needs-file，
 * 用户重选同一个文件（指纹匹配）再继续。
 */
export function restoreUploads() {
  if (restored) return;
  restored = true;
  const stored = readStored();
  if (!stored.length) return;
  const restoredTasks = stored.map((row) => {
    const received = new Set(Array.isArray(row.received) ? row.received : []);
    const task = {
      id: row.id || nextId(),
      projectKey: String(row.projectKey || ''),
      sessionId: String(row.sessionId || ''),
      name: String(row.name || ''),
      path: String(row.path || ''),
      size: Number(row.size) || 0,
      lastModified: Number(row.lastModified) || 0,
      file: null,
      uploadId: String(row.uploadId || ''),
      chunkSize: Number(row.chunkSize) || 0,
      chunkCount: Number(row.chunkCount) || 0,
      received,
      inFlight: new Set(),
      controllers: new Set(),
      samples: [],
      receivedCount: received.size,
      receivedBytes: 0,
      percent: 0,
      speed: 0,
      etaSeconds: 0,
      status: 'needs-file',
      error: '',
      completing: false,
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };
    if (task.chunkSize > 0) task.receivedBytes = uploadReceivedBytes(received, task.size, task.chunkSize);
    task.percent = uploadPercent(task.receivedBytes, task.size);
    return task;
  });
  tasks = [...restoredTasks, ...tasks];
  emitState();
  for (const task of restoredTasks) {
    if (!task.uploadId) continue;
    syncTaskStatus(task).catch((error) => {
      if (error instanceof ApiError && error.status === 404) {
        removeTask(task.id);
        emitState();
        persist();
      }
    });
  }
}

/** 刷新后重选文件：指纹一致才允许续传。 */
export async function attachUploadFile(id, file) {
  const task = findTask(id);
  if (!task || !file) return { ok: false, error: '没有可用的文件' };
  if (!fingerprintMatches(task, file)) {
    return { ok: false, error: '选择的文件与原来不一致（文件名/大小/修改时间不同）' };
  }
  task.file = file;
  task.lastModified = Number(file.lastModified) || task.lastModified;
  task.error = '';
  try {
    await syncTaskStatus(task);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      task.status = 'failed';
      task.error = '上传会话已过期，请重新上传';
      emitState();
      persist();
      return { ok: false, error: task.error };
    }
    // 网络暂时不可用：先用本地已收块入队，服务端会拒绝重复块之外的不一致。
  }
  task.status = 'queued';
  task.updatedAt = Date.now();
  emitState();
  persist();
  runNext();
  return { ok: true };
}

export function subscribeUploads(listener) {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function getUploadSnapshot() {
  return snapshot;
}

export function onUploadEvent(listener) {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeStored();
  }, PERSIST_DELAY_MS);
}

function writeStored() {
  try {
    const rows = tasks
      .filter((task) => task.uploadId && !['completed', 'cancelled'].includes(task.status))
      .map((task) => ({
        id: task.id,
        uploadId: task.uploadId,
        projectKey: task.projectKey,
        sessionId: task.sessionId,
        name: task.name,
        path: task.path,
        size: task.size,
        lastModified: task.lastModified,
        chunkSize: task.chunkSize,
        chunkCount: task.chunkCount,
        received: [...task.received].sort((a, b) => a - b),
        createdAt: task.createdAt,
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks: rows }));
  } catch {
    // localStorage 可能被禁用；上传本身不受影响。
  }
}

function readStored() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}
