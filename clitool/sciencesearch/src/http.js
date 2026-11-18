import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = { maxConcurrent: 2, minIntervalMs: 350 };

export class HttpError extends Error {
  constructor({ url, status, retryable = false, message }) {
    super(message || (status ? `HTTP ${status} from ${url}` : `Request failed: ${url}`));
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
    this.retryable = retryable;
  }
}

export function createHttp({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  userAgent = 'science-search-cli/0.2',
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  defaultRetries = DEFAULT_RETRIES,
  defaultCacheTtlMs = DEFAULT_CACHE_TTL_MS,
  defaultMaxBytes = DEFAULT_MAX_BYTES,
  defaultRateLimit = DEFAULT_RATE_LIMIT,
  cacheDir = process.env.SCIENCE_SEARCH_CACHE_DIR || path.join(os.tmpdir(), 'science-search-http-cache-v1'),
} = {}) {
  const cache = new Map();
  const hostQueues = new Map();

  async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const retries = options.retries ?? defaultRetries;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const cacheTtlMs = options.cacheTtlMs ?? (method === 'GET' ? defaultCacheTtlMs : 0);
    const maxBytes = options.maxBytes ?? defaultMaxBytes;
    const cacheKey = cacheTtlMs > 0 ? `${method} ${url}` : null;
    const cached = cacheKey ? cache.get(cacheKey) : null;
    if (cached?.expiresAt > now()) return cached.response.clone();
    if (cached) cache.delete(cacheKey);

    const persisted = cacheKey ? await readPersistentCache(cacheDir, cacheKey, now) : null;
    if (persisted) {
      cache.set(cacheKey, persisted);
      return persisted.response.clone();
    }

    const release = await acquireHost(url, options.rateLimit === false ? false : (options.rateLimit ?? defaultRateLimit));
    try {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
        const signal = combineSignals(controller.signal, options.signal);
        try {
          const response = await fetchImpl(url, {
            method,
            body: options.body,
            signal,
            headers: { 'User-Agent': userAgent, Accept: '*/*', ...(options.headers || {}) },
          });
          clearTimeout(timeout);
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!response.ok && retryable && attempt < retries) {
            await sleep(backoffMs(response, attempt));
            continue;
          }
          if (!response.ok) {
            throw new HttpError({
              url,
              status: response.status,
              retryable,
              message: `HTTP ${response.status} from ${url}`,
            });
          }
          const contentLength = Number(response.headers?.get?.('content-length'));
          if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new HttpError({ url, status: response.status, message: `Response exceeds the ${maxBytes}-byte safety limit for ${url}.` });
          }
          const body = await response.text();
          if (Buffer.byteLength(body) > maxBytes) {
            throw new HttpError({ url, status: response.status, message: `Response exceeds the ${maxBytes}-byte safety limit for ${url}.` });
          }
          const normalized = responseFrom(body, response.status, response.headers);
          if (cacheKey && body.trim() && (options.looksValid?.(body) ?? true)) {
            const entry = { expiresAt: now() + cacheTtlMs, response: normalized.clone() };
            cache.set(cacheKey, entry);
            await writePersistentCache(cacheDir, cacheKey, entry);
          }
          return normalized;
        } catch (error) {
          clearTimeout(timeout);
          lastError = error;
          if (options.signal?.aborted) throw error;
          const retryable = !(error instanceof HttpError) || error.retryable;
          if (attempt < retries && retryable) {
            await sleep(backoffMs(undefined, attempt));
            continue;
          }
        }
      }
      if (lastError instanceof HttpError) throw lastError;
      throw new HttpError({ url, retryable: true, message: lastError instanceof Error ? lastError.message : String(lastError) });
    } finally {
      release();
    }
  }

  async function json(url, options = {}) {
    const response = await request(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    try {
      return JSON.parse(response.body);
    } catch {
      throw new HttpError({ url, message: `Expected JSON from ${url}` });
    }
  }

  async function text(url, options = {}) {
    return (await request(url, options)).body;
  }

  async function acquireHost(url, rateLimit) {
    if (!rateLimit) return () => {};
    const host = new URL(url).host;
    const state = hostQueues.get(host) || { active: 0, nextStart: 0, waiters: [] };
    hostQueues.set(host, state);
    const maxConcurrent = rateLimit.maxConcurrent ?? 1;
    const minIntervalMs = rateLimit.minIntervalMs ?? 0;
    await new Promise((resolve) => {
      const start = () => {
        const delay = Math.max(0, state.nextStart - now());
        state.active += 1;
        state.nextStart = Math.max(state.nextStart, now()) + minIntervalMs;
        if (delay) setTimeout(resolve, delay);
        else resolve();
      };
      if (state.active < maxConcurrent) start();
      else state.waiters.push(start);
    });
    return () => {
      state.active -= 1;
      const next = state.waiters.shift();
      if (next) next();
    };
  }

  return { request, json, text, clearCache: () => cache.clear() };
}

function responseFrom(body, status, headers) {
  const values = Object.fromEntries(headers?.entries?.() || Object.entries(headers || {}));
  return {
    body,
    status,
    headers: { get: (name) => values[String(name).toLowerCase()] ?? values[name] ?? null },
    clone: () => responseFrom(body, status, headers),
  };
}

function cachePath(cacheDir, key) {
  return path.join(cacheDir, `${createHash('sha256').update(key).digest('hex')}.json`);
}

async function readPersistentCache(cacheDir, key, now) {
  if (!cacheDir) return null;
  try {
    const entry = JSON.parse(await fs.readFile(cachePath(cacheDir, key), 'utf8'));
    if (!entry || entry.expiresAt <= now() || typeof entry.body !== 'string') return null;
    return { expiresAt: entry.expiresAt, response: responseFrom(entry.body, entry.status, entry.headers) };
  } catch {
    return null;
  }
}

async function writePersistentCache(cacheDir, key, entry) {
  if (!cacheDir) return;
  try {
    const target = cachePath(cacheDir, key);
    await fs.mkdir(cacheDir, { recursive: true });
    const headers = Object.fromEntries(['content-type', 'etag', 'last-modified'].map((name) => [name, entry.response.headers.get(name)]).filter(([, value]) => value != null));
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ expiresAt: entry.expiresAt, status: entry.response.status, headers, body: entry.response.body }), { flag: 'w' });
    await fs.rename(temporary, target);
  } catch {
    // Cache storage is an optimization. A read-only or unavailable cache must not fail a request.
  }
}

function combineSignals(internal, external) {
  if (!external) return internal;
  if (AbortSignal.any) return AbortSignal.any([internal, external]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  internal.addEventListener('abort', abort, { once: true });
  external.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function backoffMs(response, attempt) {
  const retryAfter = response?.headers?.get?.('retry-after');
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  return Math.min(1_000 * (2 ** attempt), 15_000);
}
