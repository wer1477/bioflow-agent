import type { LLMThinkingFormat } from './types.js';
import type { LLMProtocol } from './config/llm_config_store.js';
import { anthropicHeaders, anthropicModelsEndpoint, messagesEndpoint } from './llm_anthropic.js';

/**
 * Outbound probes for the LLM settings page.
 *
 * Everything here is a question, never a decision: a probe reports what an endpoint said,
 * and nothing is stored. Discovery that writes is how a config ends up describing a state
 * no file contains.
 */

const PROBE_TIMEOUT_MS = 8_000;

export type ProbeErrorKind = 'auth' | 'not-found' | 'network' | 'timeout' | 'unsupported' | 'http';

export interface ProbeError {
  kind: ProbeErrorKind;
  message: string;
  status?: number;
}

export interface ProbedModel {
  id: string;
  /** sglang/vLLM expose the context window on the model object; nothing else needs asking. */
  maxModelLen?: number;
}

export interface ProbeResult {
  ok: boolean;
  models: ProbedModel[];
  /** Only filled when the caller asked for it and the endpoint named its levels. */
  thinkingLevels?: string[];
  thinkingLevelsSource?: 'endpoint-error' | 'unknown';
  error?: ProbeError;
}

/** A verify failure can also be the thinking encoding, which probe never asks about. */
export type VerifyErrorKind = ProbeErrorKind | 'bad-thinking-format';

export interface VerifyResult {
  ok: boolean;
  latencyMs: number;
  modelEcho?: string;
  error?: Omit<ProbeError, 'kind'> & { kind: VerifyErrorKind };
}

export interface EndpointInput {
  baseUrl: string;
  apiKey: string;
  /** Static headers the endpoint requires (OpenCode's routing header, for example). */
  headers?: Record<string, string>;
  /** Wire protocol; omitted means `openai-completions`, the only one probes shipped with. */
  protocol?: LLMProtocol;
}

/** Strips a trailing slash so `…/v1` and `…/v1/` hit the same route. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export async function probeModels(input: EndpointInput, options: { model?: string; probeThinkingLevels?: boolean } = {}): Promise<ProbeResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) return { ok: false, models: [], error: { kind: 'unsupported', message: '缺少 Base URL。' } };

  const anthropic = input.protocol === 'anthropic-messages';
  let response: Response;
  try {
    response = await fetch(anthropic ? anthropicModelsEndpoint(baseUrl) : `${baseUrl}/models`, {
      headers: requestHeaders(input.apiKey, input.headers, input.protocol),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, models: [], error: describeTransportError(error) };
  }

  if (!response.ok) {
    return { ok: false, models: [], error: await describeHttpError(response) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 200 that is not JSON is an endpoint speaking something else, not a broken config.
    return { ok: false, models: [], error: { kind: 'unsupported', message: '端点返回的不是模型列表（不是 JSON），请手动填写模型 ID。' } };
  }

  const rows = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray(payload) ? payload as unknown[] : [];
  const models: ProbedModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String((row as { id?: unknown }).id ?? '').trim();
    if (!id) continue;
    // Three shapes in the wild: sglang/vLLM put `max_model_len` at the top level,
    // models.dev (and OpenCode) nest it under `limit.context`, and a few gateways use
    // `context_window`. Read all of them so an imported row is runnable, not empty.
    const limit = (row as { limit?: { context?: unknown } }).limit;
    const maxModelLen = positiveInteger(
      (row as { max_model_len?: unknown }).max_model_len
      ?? (row as { max_model_length?: unknown }).max_model_length
      ?? (limit && typeof limit === 'object' ? limit.context : undefined)
      ?? (row as { context_window?: unknown }).context_window
      ?? (row as { contextWindow?: unknown }).contextWindow,
    );
    models.push({ id, ...(maxModelLen ? { maxModelLen } : {}) });
  }

  if (!models.length) {
    return { ok: false, models: [], error: { kind: 'unsupported', message: '端点未返回任何模型。' } };
  }

  const result: ProbeResult = { ok: true, models };
  if (options.probeThinkingLevels && options.model && !anthropic) {
    const levels = await probeThinkingLevels(baseUrl, input.apiKey, options.model, input.headers);
    result.thinkingLevels = levels.values;
    result.thinkingLevelsSource = levels.source;
  }
  return result;
}

/**
 * Asks the endpoint which levels it accepts by sending one it will refuse.
 *
 * This is observation, not inference: the values come from the endpoint's own error text
 * ("Supported types are xhigh (default), medium, and low"). When the endpoint says nothing
 * useful, the caller gets an empty list and the UI falls back to free text.
 */
export async function probeThinkingLevels(baseUrl: string, apiKey: string, model: string, headers?: Record<string, string>): Promise<{ values: string[]; source: 'endpoint-error' | 'unknown' }> {
  const sentinel = '__probe__';
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { ...requestHeaders(apiKey, headers), 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        reasoning_effort: sentinel,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) return { values: [], source: 'unknown' };
    const message = await readErrorMessage(response);
    const values = parseThinkingLevels(message);
    return values.length ? { values, source: 'endpoint-error' } : { values: [], source: 'unknown' };
  } catch {
    return { values: [], source: 'unknown' };
  }
}

/** One 1-token completion: proves the URL, the credential and the model reach the same place. */
export async function verifyConnection(input: EndpointInput & { model: string; thinking?: { format: LLMThinkingFormat; wire: string | number } }): Promise<VerifyResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const anthropic = input.protocol === 'anthropic-messages';
  const responses = input.protocol === 'openai-responses';
  const startedAt = Date.now();
  try {
    const response = await fetch(anthropic ? messagesEndpoint(baseUrl) : `${baseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
      method: 'POST',
      headers: { ...requestHeaders(input.apiKey, input.headers, input.protocol), 'content-type': 'application/json' },
      body: JSON.stringify(anthropic
        // The Messages API has no model echo and requires `system` at the top level, but a
        // one-token user turn is the same question: do URL, credential and model agree?
        ? { model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }], ...thinkingFragment(input.thinking) }
        : responses
          ? { model: input.model, input: 'ping', max_output_tokens: 1 }
          : {
            model: input.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            ...thinkingFragment(input.thinking),
          }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const message = await readErrorMessage(response);
      return { ok: false, latencyMs, error: classifyCompletionError(response.status, message) };
    }
    const payload = await response.json().catch(() => ({} as Record<string, unknown>));
    const echoed = String((payload as { model?: unknown }).model ?? '').trim();
    return { ok: true, latencyMs, ...(echoed ? { modelEcho: echoed } : {}) };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: describeTransportError(error) };
  }
}

/** `Supported types are xhigh (default), medium, and low.` and its siblings. */
export function parseThinkingLevels(message: string): string[] {
  const patterns = [
    /supported (?:types|values) (?:are|is)\s*:?\s*([^.\n]+)/i,
    /must be one of\s*:?\s*([^.\n]+)/i,
    /(?:allowed|valid) values (?:are|is)\s*:?\s*([^.\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const values = match[1]
      .replace(/\([^)]*\)/g, ' ')
      .split(/,|\band\b|\bor\b/i)
      .map((value) => value.replace(/[`'"]/g, '').trim())
      .filter((value) => value && value.length <= 32);
    if (values.length) return [...new Set(values)];
  }
  return [];
}

function thinkingFragment(thinking?: { format: LLMThinkingFormat; wire: string | number }): Record<string, unknown> {
  if (!thinking || thinking.format === 'none') return {};
  if (thinking.format === 'anthropic-budget') {
    const budget = Number(thinking.wire);
    return Number.isFinite(budget) && budget > 0 ? { thinking: { type: 'enabled', budget_tokens: Math.floor(budget) } } : {};
  }
  const effort = String(thinking.wire).trim();
  return effort ? { reasoning_effort: effort } : {};
}

function authHeaders(apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * Static provider headers plus the bearer credential. Authorization always wins, so a
 * configured header can never shadow or duplicate the credential.
 */
function requestHeaders(apiKey: string, headers?: Record<string, string>, protocol?: LLMProtocol): Record<string, string> {
  if (protocol === 'anthropic-messages') return anthropicHeaders(apiKey, headers);
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() !== 'authorization') merged[name] = value;
  }
  return { ...merged, ...authHeaders(apiKey) };
}

function classifyCompletionError(status: number, message: string): VerifyResult['error'] {
  if (/reasoning_effort|thinking|reasoning effort/i.test(message) && [400, 422].includes(status)) {
    return { kind: 'bad-thinking-format', message, status };
  }
  return { kind: status === 401 || status === 403 ? 'auth' : 'http', message, status };
}

async function describeHttpError(response: Response): Promise<ProbeError> {
  const message = await readErrorMessage(response);
  if (response.status === 401 || response.status === 403) return { kind: 'auth', message, status: response.status };
  if (response.status === 404) {
    return { kind: 'unsupported', message: '端点没有 /models 接口，请手动填写模型 ID 与上下文。', status: 404 };
  }
  return { kind: 'http', message, status: response.status };
}

function describeTransportError(error: unknown): ProbeError {
  const name = (error as { name?: string })?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'timeout', message: `端点 ${PROBE_TIMEOUT_MS / 1000}s 内没有响应。` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'network', message };
}

async function readErrorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  const trimmed = raw.trim();
  if (!trimmed) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const nested = typeof parsed.error === 'object' && parsed.error
      ? (parsed.error as { message?: unknown }).message
      : parsed.error;
    const message = typeof nested === 'string' ? nested : typeof parsed.message === 'string' ? parsed.message : '';
    if (message) return `${message} (HTTP ${response.status})`;
  } catch {
    // Fall through to the raw body.
  }
  return `${trimmed.slice(0, 300)} (HTTP ${response.status})`;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
