/**
 * HTTP 错误：保留状态码与响应体，调用方才能区分"版本冲突（409）"和普通失败。
 */
export class ApiError extends Error {
  constructor(message, { status, payload } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || null;
  }
}

/**
 * 会话过期时任何 API 都会返回 401。统一广播一个事件，由 Root 切回登录页；
 * 各调用方仍然照常拿到 ApiError，不影响它们自己的错误处理。
 */
export function notifyAuthExpired(status) {
  if (status !== 401 || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('bioflow:auth-expired'));
}

export async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const error = await readApiError(response);
    notifyAuthExpired(response.status);
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function uploadBinaryFile(url, file, { fileName, path }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Workspace-File-Name': encodeURIComponent(fileName),
      'X-Workspace-Path': encodeURIComponent(path),
    },
    body: file,
  });
  if (!response.ok) {
    const error = await readApiError(response);
    notifyAuthExpired(response.status);
    throw error;
  }
  return response.json();
}

/** 分块上传：一块一个请求，body 是文件的 slice，可被 AbortController 取消。 */
export async function uploadChunk(url, chunk, { signal } = {}) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: chunk,
    signal,
  });
  if (!response.ok) {
    const error = await readApiError(response);
    notifyAuthExpired(response.status);
    throw error;
  }
  return response.json();
}

async function readApiError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    if (data?.error) return new ApiError(data.error, { status: response.status, payload: data });
  } catch {
    // Non-JSON errors (such as request-size rejections) should not expose HTML to users.
  }
  return new ApiError(`请求失败（HTTP ${response.status}）`, { status: response.status });
}

export async function readNdjson(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onEvent(JSON.parse(line));
      index = buffer.indexOf('\n');
    }
  }
}

export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
