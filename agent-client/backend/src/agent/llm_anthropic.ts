import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { CacheMode, CacheReportMode } from './config/llm_config_store.js';
import type { LLMThinking } from './types.js';
import type { StreamEvent } from './llm_client.js';
import { applyExplicitCacheBreakpoints, readCachedPromptTokens } from './llm_wire.js';
import { sanitizeMessagesForTextOnly } from './core_tools/image_payload.js';

/**
 * Anthropic Messages transport.
 *
 * The runtime keeps one OpenAI-shaped message model (`ChatCompletionMessageParam`) and every
 * adapter translates at this boundary, so `agent_runtime.ts`, `context_manager.ts` and the
 * eleven tests that fake an OpenAI SSE provider do not change when a protocol is added.
 *
 * Why this exists at all: the OpenAI-compatible shim on api.anthropic.com ignores
 * `cache_control`, so an `explicit`-cache provider cached nothing. The native endpoint is the
 * only place the breakpoints and the `cache_read_input_tokens` counter are real.
 */

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: string;
  thinking?: LLMThinking;
  thinkingLevel?: string;
  cacheMode?: CacheMode;
  cacheReport?: CacheReportMode;
  /** Shared with the OpenAI path: one image rejection turns images off for this client. */
  state: { supportsImages: boolean };
}

type AnthropicBlock = Record<string, unknown>;
interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

/** `…/v1` and `…` both resolve to one endpoint; the record stores whatever the operator pasted. */
function apiRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function messagesEndpoint(baseUrl: string): string {
  const root = apiRoot(baseUrl);
  return /\/v1$/.test(root) ? `${root}/messages` : `${root}/v1/messages`;
}

export function anthropicModelsEndpoint(baseUrl: string): string {
  const root = apiRoot(baseUrl);
  return /\/v1$/.test(root) ? `${root}/models` : `${root}/v1/models`;
}

/**
 * Credentials for the Messages API: `x-api-key`, never a bearer token. A configured
 * `authorization` header is dropped so it cannot shadow the credential, and the operator may
 * still override `anthropic-version` or add beta headers.
 */
export function anthropicHeaders(apiKey: string, headers?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key') continue;
    merged[name] = value;
  }
  const hasVersion = Object.keys(merged).some((name) => name.toLowerCase() === 'anthropic-version');
  const key = apiKey.trim();
  return {
    ...merged,
    ...(hasVersion ? {} : { 'anthropic-version': ANTHROPIC_VERSION }),
    ...(key ? { 'x-api-key': key } : {}),
  };
}

/**
 * A reasoning budget below the protocol minimum (1024) is not sendable, and `max_tokens`
 * must exceed the budget. Both are adjusted here instead of failing the run: the level was
 * a user's choice, the endpoint's arithmetic is not.
 */
function anthropicThinking(config: AnthropicConfig, maxTokens: number): { maxTokens: number; thinking?: AnthropicBlock } {
  if (config.thinking?.format !== 'anthropic-budget') return { maxTokens };
  const budget = Math.floor(Number(config.thinking.wire));
  if (!Number.isFinite(budget) || budget < 1024) return { maxTokens };
  return { maxTokens: Math.max(maxTokens, budget + 1), thinking: { type: 'enabled', budget_tokens: budget } };
}

function imageBlock(part: Record<string, unknown>): AnthropicBlock | undefined {
  const url = (part.image_url as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string' || !url) return undefined;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  return undefined;
}

/** OpenAI content parts -> Anthropic text/image blocks, carrying any cache breakpoint. */
function toBlocks(content: unknown): AnthropicBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      blocks.push({ type: 'text', text: record.text, ...(record.cache_control ? { cache_control: record.cache_control } : {}) });
    } else if (record.type === 'image_url') {
      const image = imageBlock(record);
      if (image) blocks.push(image);
    }
  }
  return blocks;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * `ChatCompletionMessageParam[]` -> Messages body pieces.
 *
 * - every `system` message becomes the top-level `system` array (Anthropic has no system role);
 * - an assistant `tool_calls` array becomes `tool_use` blocks;
 * - consecutive `tool` messages become one user message of `tool_result` blocks, because the
 *   protocol answers a whole tool batch in a single turn.
 */
export function translateMessages(messages: ChatCompletionMessageParam[]): { system?: AnthropicBlock[]; messages: AnthropicMessage[] } {
  const system: AnthropicBlock[] = [];
  const out: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicBlock[] = [];

  const flushToolResults = () => {
    if (!pendingToolResults.length) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages as unknown as Array<Record<string, unknown>>) {
    const role = String(message.role || '');
    if (role === 'system') {
      system.push(...toBlocks(message.content));
      continue;
    }
    if (role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: String(message.tool_call_id || ''),
        content: toBlocks(message.content),
      });
      continue;
    }
    flushToolResults();
    if (role === 'assistant') {
      const blocks = toBlocks(message.content);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
      for (const call of toolCalls) {
        const fn = call.function as Record<string, unknown> | undefined;
        blocks.push({
          type: 'tool_use',
          id: String(call.id || ''),
          name: String(fn?.name || ''),
          input: parseArguments(fn?.arguments),
        });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    const blocks = toBlocks(message.content);
    if (blocks.length) out.push({ role: 'user', content: blocks });
  }
  flushToolResults();
  return { ...(system.length ? { system } : {}), messages: out };
}

export function translateTools(tools: ChatCompletionTool[] | undefined): AnthropicBlock[] | undefined {
  if (!tools?.length) return undefined;
  return (tools as unknown as Array<Record<string, unknown>>).map((tool) => {
    const fn = (tool.function || {}) as Record<string, unknown>;
    return {
      name: String(fn.name || ''),
      ...(typeof fn.description === 'string' && fn.description ? { description: fn.description } : {}),
      input_schema: fn.parameters || { type: 'object', properties: {} },
      ...(tool.cache_control ? { cache_control: tool.cache_control } : {}),
    };
  });
}

interface MessagesBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: AnthropicBlock[];
  tools?: AnthropicBlock[];
  thinking?: AnthropicBlock;
  stream: boolean;
}

function buildBody(config: AnthropicConfig, messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[] | undefined, maxTokens: number): MessagesBody {
  const effective = config.state.supportsImages ? messages : sanitizeMessagesForTextOnly(messages);
  const cacheBody = config.cacheMode === 'explicit'
    ? applyExplicitCacheBreakpoints(effective, tools)
    : { messages: effective, tools };
  const translated = translateMessages(cacheBody.messages);
  const budget = anthropicThinking(config, maxTokens);
  const toolsBody = translateTools(cacheBody.tools);
  return {
    model: config.model,
    max_tokens: budget.maxTokens,
    messages: translated.messages,
    ...(translated.system ? { system: translated.system } : {}),
    ...(toolsBody ? { tools: toolsBody } : {}),
    ...(budget.thinking ? { thinking: budget.thinking } : {}),
    stream: true,
  };
}

function requestSignal(abortSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
}

async function readErrorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  const text = raw.trim();
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const nested = typeof parsed.error === 'object' && parsed.error ? parsed.error.message : parsed.error;
    const message = typeof nested === 'string' ? nested : typeof parsed.message === 'string' ? parsed.message : '';
    if (message) return message;
  } catch {
    // A non-JSON body is still better than a bare status code.
  }
  return text.slice(0, 500);
}

async function httpError(response: Response): Promise<Error & { status?: number }> {
  const message = await readErrorMessage(response);
  const error = new Error(`${response.status} status code: ${message}`) as Error & { status?: number };
  error.status = response.status;
  return error;
}

function isImageUnsupported(error: Error & { status?: number }): boolean {
  const status = Number(error.status);
  if (Number.isFinite(status) && status !== 400 && status !== 422) return false;
  return /image|vision|multimodal/i.test(error.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One POST with the SDK-equivalent retry policy: 2 retries on 408/409/429/5xx. */
async function postMessages(config: AnthropicConfig, body: MessagesBody, abortSignal?: AbortSignal): Promise<Response> {
  const url = messagesEndpoint(config.baseUrl);
  const headers = { ...anthropicHeaders(config.apiKey, config.headers), 'content-type': 'application/json' };
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal(abortSignal), redirect: 'error' });
    } catch (error) {
      if (abortSignal?.aborted || attempt >= MAX_RETRIES) throw error;
      await sleep(500 * 2 ** attempt);
      attempt += 1;
      continue;
    }
    if (response.ok) return response;
    const error = await httpError(response);
    if (!RETRY_STATUSES.has(response.status) || attempt >= MAX_RETRIES) throw error;
    await sleep(500 * 2 ** attempt);
    attempt += 1;
  }
}

/** A malformed data line is skipped, not fatal: one bad frame must not abort a run. */
function parseEvent(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function* streamAnthropicMessages(
  config: AnthropicConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[] | undefined,
  abortSignal: AbortSignal | undefined,
  maxTokens: number,
  onRawChunk?: (chunk: unknown) => void,
): AsyncGenerator<StreamEvent> {
  let response: Response;
  try {
    response = await postMessages(config, buildBody(config, messages, tools, maxTokens), abortSignal);
  } catch (error) {
    const normalized = error as Error & { status?: number };
    if (config.state.supportsImages && isImageUnsupported(normalized)) {
      // Same contract as the OpenAI path: a text-only endpoint still gets the text part of
      // the tool result, and later requests for this client never send images again.
      config.state.supportsImages = false;
      response = await postMessages(config, buildBody(config, messages, tools, maxTokens), abortSignal);
    } else {
      throw normalized;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Anthropic Messages response has no body.');

  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  let buffer = '';
  let stopReason = '';
  let inputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens = 0;
  let outputTokens = 0;

  const handle = (payload: Record<string, unknown>): StreamEvent[] => {
    const events: StreamEvent[] = [];
    switch (payload.type) {
      case 'message_start': {
        const usage = (payload.message as { usage?: Record<string, unknown> } | undefined)?.usage || {};
        inputTokens = Number(usage.input_tokens ?? 0) || 0;
        cacheReadTokens = Number.isFinite(Number(usage.cache_read_input_tokens)) ? Number(usage.cache_read_input_tokens) : undefined;
        cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0) || 0;
        outputTokens = Number(usage.output_tokens ?? 0) || 0;
        break;
      }
      case 'content_block_start': {
        const index = Number(payload.index ?? 0);
        const block = (payload.content_block || {}) as Record<string, unknown>;
        if (block.type === 'tool_use') {
          toolCalls.set(index, {
            id: String(block.id || ''),
            type: 'function',
            function: { name: String(block.name || ''), arguments: '' },
          });
        }
        break;
      }
      case 'content_block_delta': {
        const index = Number(payload.index ?? 0);
        const delta = (payload.delta || {}) as Record<string, unknown>;
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          events.push({ type: 'content', content: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          events.push({ type: 'thinking', content: delta.thinking });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const current = toolCalls.get(index);
          if (current) current.function.arguments += delta.partial_json;
        }
        break;
      }
      case 'message_delta': {
        const delta = (payload.delta || {}) as Record<string, unknown>;
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        const usage = (payload.usage || {}) as Record<string, unknown>;
        if (Number.isFinite(Number(usage.output_tokens))) outputTokens = Number(usage.output_tokens);
        break;
      }
      default:
        break;
    }
    return events;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data && data !== '[DONE]') {
          const payload = parseEvent(data);
          if (payload) {
            onRawChunk?.(JSON.parse(JSON.stringify(payload)));
            if (payload.type === 'error') {
              const message = String((payload.error as { message?: unknown } | undefined)?.message || 'Anthropic stream error');
              throw new Error(message);
            }
            for (const event of handle(payload)) yield event;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  const promptTokens = inputTokens + (cacheReadTokens || 0) + cacheCreationTokens;
  if (promptTokens > 0) {
    const cached = cacheReadTokens === undefined
      ? readCachedPromptTokens({}, config.cacheReport)
      : readCachedPromptTokens({ cache_read_input_tokens: cacheReadTokens }, config.cacheReport);
    yield {
      type: 'usage',
      promptTokens,
      ...(outputTokens > 0 ? { completionTokens: outputTokens, totalTokens: promptTokens + outputTokens } : {}),
      ...(cached !== null ? { cachedPromptTokens: cached } : {}),
    };
  }

  if (stopReason === 'max_tokens') {
    yield { type: 'truncated', finishReason: 'length' };
  } else if (toolCalls.size) {
    yield { type: 'tool_calls', tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) };
  }
  yield { type: 'done' };
}

/** Non-streaming Messages call for summarisation and the connection test. */
export async function completeAnthropicText(
  config: AnthropicConfig,
  messages: ChatCompletionMessageParam[],
  maxTokens = 512,
  abortSignal?: AbortSignal,
  options: { ignoreThinking?: boolean } = {},
): Promise<string> {
  const effective: AnthropicConfig = options.ignoreThinking ? { ...config, thinking: undefined, thinkingLevel: undefined } : config;
  const body = { ...buildBody(effective, messages, undefined, maxTokens), stream: false };
  const response = await postMessages(effective, body, abortSignal);
  const payload = await response.json().catch(() => ({})) as { content?: Array<Record<string, unknown>> };
  return (payload.content || [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('');
}

export async function testAnthropicConnection(config: AnthropicConfig): Promise<boolean> {
  const body = {
    ...buildBody({ ...config, thinking: undefined, thinkingLevel: undefined, cacheMode: undefined }, [{ role: 'user', content: 'Hello' }], undefined, 16),
    stream: false,
  };
  const response = await postMessages(config, body);
  const payload = await response.json().catch(() => ({})) as { content?: unknown[] };
  return Array.isArray(payload.content) && payload.content.length > 0;
}
