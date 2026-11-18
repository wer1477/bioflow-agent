import OpenAI from 'openai';
import crypto from 'node:crypto';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { LLMConfig } from './types.js';
import { sanitizeMessagesForTextOnly } from './core_tools/image_payload.js';
import { applyExplicitCacheBreakpoints, readCachedPromptTokens, thinkingOptions } from './llm_wire.js';
import {
  completeAnthropicText,
  streamAnthropicMessages,
  testAnthropicConnection,
  type AnthropicConfig,
} from './llm_anthropic.js';
import {
  completeResponsesText,
  streamResponses,
  testResponsesConnection,
  type ResponsesConfig,
} from './llm_responses.js';

// Re-exported for the callers and tests that import them from the transport module.
export { applyExplicitCacheBreakpoints, readCachedPromptTokens } from './llm_wire.js';

const LLM_REQUEST_TIMEOUT_MS = 60_000;
const LLM_MAX_RETRIES = 2;
const MAX_POOLED_LLM_CLIENTS = 32;
const clientPool = new Map<string, LLMClient>();

/** Carries a rejected response body past the SDK's error mapping; never sent to a provider. */
const PROVIDER_ERROR_BODY_HEADER = 'x-bioflow-provider-error-body';
const PROVIDER_ERROR_BODY_LIMIT = 2_000;
const PROVIDER_ERROR_MESSAGE_LIMIT = 500;

export type StreamEvent =
  | { type: 'content'; content: string }
  /**
   * Reasoning the provider streamed alongside the answer (`reasoning_content`, or the
   * plain `reasoning` alias some OpenAI-compatible servers use). It is normalized here
   * because this is the only place the provider payload is read; the runtime forwards it
   * to the UI and the transcript keeps the raw chunk it came from. It must never be fed
   * back as assistant content — see `agent_runtime.ts`'s stream loop.
   */
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; tool_calls: any[] }
  | { type: 'truncated'; finishReason: 'length' }
  /**
   * Provider-reported prefix-cache hit, when the endpoint reports one at all. Three
   * spellings exist in the wild for the same idea (OpenAI/vLLM `prompt_tokens_details.
   * cached_tokens`, DeepSeek `prompt_cache_hit_tokens`), so both are normalized here and
   * anything else stays absent rather than being guessed at.
   */
  | { type: 'usage'; promptTokens: number; completionTokens?: number; totalTokens?: number; cachedPromptTokens?: number }
  | { type: 'done' };

/**
 * All configured endpoints use the OpenAI Chat Completions contract. The
 * application performs no provider or model detection; `thinkingLevel` is
 * forwarded verbatim as `reasoning_effort` when the user supplies it.
 */
export class LLMClient {
  private readonly client: OpenAI;
  /**
   * Set to false after the endpoint rejects image content parts once. Every later
   * request for this client is sent text-only instead of failing the whole run: a
   * text-only model can still read the textual part of an image tool result, and the
   * model is told that the image was omitted.
   */
  private readonly state = { supportsImages: true };

  constructor(private readonly config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: LLM_REQUEST_TIMEOUT_MS,
      maxRetries: LLM_MAX_RETRIES,
      fetch: captureFailedResponseBodies(globalThis.fetch),
      // Some OpenAI-compatible gateways require a routing header on every request
      // (OpenCode: x-opencode-session). The SDK merges these below per-call headers.
      ...(config.headers && Object.keys(config.headers).length ? { defaultHeaders: config.headers } : {}),
    });
  }

  async *chatStream(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
    abortSignal?: AbortSignal,
    maxTokens = 4096,
    onRawChunk?: (chunk: unknown) => void,
  ): AsyncGenerator<StreamEvent> {
    if (this.config.protocol === 'anthropic-messages') {
      yield* streamAnthropicMessages(this.anthropicConfig(), messages, tools, abortSignal, maxTokens, onRawChunk);
      return;
    }
    if (this.config.protocol === 'openai-responses') {
      yield* streamResponses(this.client, this.responsesConfig(), messages, tools, abortSignal, maxTokens, onRawChunk);
      return;
    }
    const stream = await this.createStreamingCompletion(messages, tools, abortSignal, maxTokens);

    const toolCalls = new Map<number, any>();
    let finishReason: string | null = null;
    for await (const chunk of stream) {
      // The transcript recorder observes provider payloads without changing
      // the public normalized stream contract consumed by the runtime/UI.
      onRawChunk?.(JSON.parse(JSON.stringify(chunk)));
      const usage = chunk.usage;
      if (Number.isFinite(usage?.prompt_tokens) && usage.prompt_tokens > 0) {
        const cachedPromptTokens = readCachedPromptTokens(usage, this.config.cacheReport);
        yield {
          type: 'usage',
          promptTokens: usage.prompt_tokens,
          ...(Number.isFinite(usage.completion_tokens) ? { completionTokens: usage.completion_tokens } : {}),
          ...(Number.isFinite(usage.total_tokens) ? { totalTokens: usage.total_tokens } : {}),
          ...(cachedPromptTokens !== null ? { cachedPromptTokens } : {}),
        };
      }
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      // Reasoning arrives as its own delta field, never inside `content`. Only these two
      // spellings are recognized; anything else is left alone rather than guessed at.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', content: reasoning };
      if (delta.content) yield { type: 'content', content: delta.content };
      for (const toolCall of delta.tool_calls || []) {
        const current = toolCalls.get(toolCall.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (toolCall.id) current.id = toolCall.id;
        if (toolCall.function?.name) current.function.name += toolCall.function.name;
        if (toolCall.function?.arguments) current.function.arguments += toolCall.function.arguments;
        toolCalls.set(toolCall.index, current);
      }
    }
    // A length-capped response can contain only a prefix of a tool call. Never
    // treat that prefix as an instruction to execute.
    if (finishReason === 'length') {
      yield { type: 'truncated', finishReason: 'length' };
    } else if (toolCalls.size) {
      yield { type: 'tool_calls', tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) };
    }
    yield { type: 'done' };
  }

  private async createStreamingCompletion(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[] | undefined,
    abortSignal: AbortSignal | undefined,
    maxTokens: number,
  ): Promise<AsyncIterable<any>> {
    const effectiveMessages = this.state.supportsImages ? messages : sanitizeMessagesForTextOnly(messages);
    const cacheBody = this.config.cacheMode === 'explicit'
      ? applyExplicitCacheBreakpoints(effectiveMessages, tools)
      : { messages: effectiveMessages, tools };
    const create = (includeUsage: boolean, requestMessages: ChatCompletionMessageParam[] = cacheBody.messages) => this.client.chat.completions.create({
      model: this.config.model,
      messages: requestMessages,
      max_tokens: maxTokens,
      stream: true,
      ...thinkingOptions(this.config),
      ...(cacheBody.tools?.length ? { tools: cacheBody.tools, tool_choice: 'auto' as const } : {}),
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    } as any, abortSignal ? { signal: abortSignal } : undefined) as unknown as Promise<AsyncIterable<any>>;

    try {
      return await create(true);
    } catch (error) {
      const normalized = describeProviderError(error);
      if (this.state.supportsImages && isImageUnsupportedError(normalized)) {
        // Disable images for this client and retry the same turn text-only. The
        // alternative is failing a run whose only problem is an unsupported input
        // modality, even though the tool result still carries all of its text.
        this.state.supportsImages = false;
        try {
          return await create(true, sanitizeMessagesForTextOnly(messages));
        } catch (retryError) {
          throw describeProviderError(retryError);
        }
      }
      if (!isUnsupportedUsageOption(normalized)) throw normalized;
      try {
        return await create(false);
      } catch (retryError) {
        throw describeProviderError(retryError);
      }
    }
  }

  async testConnection(): Promise<boolean> {
    if (this.config.protocol === 'anthropic-messages') return testAnthropicConnection(this.anthropicConfig());
    if (this.config.protocol === 'openai-responses') return testResponsesConnection(this.client, this.responsesConfig());
    const response = await this.request(() => this.client.chat.completions.create({
      model: this.config.model,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 5,
      ...thinkingOptions(this.config),
    } as any));
    return response.choices.length > 0;
  }

  /**
   * One non-streaming completion, used for summarisation and other internal calls.
   *
   * `ignoreThinking` exists because context compaction spends a fixed 1,800-token
   * budget: a reasoning model at a high level can consume all of it on reasoning and
   * return empty content, which surfaces as a silently degraded checkpoint. Extraction
   * work therefore opts out of the interaction's thinking level.
   */
  async completeText(
    messages: ChatCompletionMessageParam[],
    maxTokens = 512,
    abortSignal?: AbortSignal,
    options: { ignoreThinking?: boolean } = {},
  ): Promise<string> {
    if (this.config.protocol === 'anthropic-messages') {
      return completeAnthropicText(this.anthropicConfig(), messages, maxTokens, abortSignal, options);
    }
    if (this.config.protocol === 'openai-responses') {
      return completeResponsesText(this.client, this.responsesConfig(), messages, maxTokens, abortSignal);
    }
    const response = await this.request(() => this.client.chat.completions.create({
      model: this.config.model,
      messages,
      max_tokens: maxTokens,
      ...(options.ignoreThinking ? {} : thinkingOptions(this.config)),
    } as any, abortSignal ? { signal: abortSignal } : undefined));
    return response.choices[0]?.message?.content || '';
  }

  private responsesConfig(): ResponsesConfig {
    return { model: this.config.model, state: this.state };
  }

  private anthropicConfig(): AnthropicConfig {
    return {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      headers: this.config.headers,
      model: this.config.model,
      thinking: this.config.thinking,
      thinkingLevel: this.config.thinkingLevel,
      cacheMode: this.config.cacheMode,
      cacheReport: this.config.cacheReport,
      state: this.state,
    };
  }

  /** Providers reject requests with a body the SDK may drop; normalize before it leaves this module. */
  private async request<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw describeProviderError(error);
    }
  }
}

/**
 * The OpenAI SDK formats an HTTP failure as `${status} status code (no body)` whenever the
 * provider's error payload does not use the SDK's expected `{"error": {...}}` envelope.
 * vLLM returns the error object at the top level, so a clear cause such as
 * "System message must be at the beginning." was reported as a bare 400 and cost a long
 * time to trace. This wrapper stashes the rejected body in a response header so
 * `describeProviderError` can rehydrate it after the SDK has thrown.
 */
export function captureFailedResponseBodies(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.ok) return response;

    let body = '';
    try {
      // The clone leaves the original stream readable for the SDK.
      body = await response.clone().text();
    } catch {
      return response;
    }
    if (!body) return response;

    const headers = new Headers(response.headers);
    headers.set(PROVIDER_ERROR_BODY_HEADER, encodeURIComponent(body.slice(0, PROVIDER_ERROR_BODY_LIMIT)));
    // The original stream is passed through unchanged, so these must not claim an
    // encoding or length that no longer describes the bytes the SDK will read.
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Restores the rejected response body the SDK dropped, keeping `status` intact for retry checks. */
export function describeProviderError(error: unknown): Error {
  const status = Number((error as { status?: unknown })?.status);
  const headers = (error as { headers?: { get?: (name: string) => string | null } })?.headers;
  const captured = headers?.get?.(PROVIDER_ERROR_BODY_HEADER);
  if (!captured) return toError(error);

  const detail = providerErrorMessage(decodeURIComponent(captured));
  if (!detail) return toError(error);

  const message = Number.isFinite(status) && status > 0 ? `${status} status code: ${detail}` : detail;
  const normalized = new Error(message) as Error & { status?: number; cause?: unknown };
  if (Number.isFinite(status)) normalized.status = status;
  normalized.cause = error;
  return normalized;
}

/** Providers either nest the message under `error` or use a flat `{object: "error", message}` body. */
function providerErrorMessage(rawBody: string): string {
  const text = rawBody.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const nested = parsed.error as Record<string, unknown> | undefined;
    const candidate = nested?.message ?? parsed.message ?? nested?.type ?? parsed.type;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, PROVIDER_ERROR_MESSAGE_LIMIT);
    }
  } catch {
    // A non-JSON body is still more useful than an opaque status code.
  }
  return text.slice(0, PROVIDER_ERROR_MESSAGE_LIMIT);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Returns a bounded, reusable SDK client for an identical provider/model
 * configuration. The pool key uses a credential digest so secrets are never
 * retained in map keys or diagnostic output.
 */
export function getLLMClient(config: LLMConfig): LLMClient {
  const key = clientPoolKey(config);
  const existing = clientPool.get(key);
  if (existing) {
    // Refresh recency for the small LRU cache.
    clientPool.delete(key);
    clientPool.set(key, existing);
    return existing;
  }

  const client = new LLMClient(config);
  clientPool.set(key, client);
  if (clientPool.size > MAX_POOLED_LLM_CLIENTS) {
    const oldest = clientPool.keys().next().value;
    if (oldest) clientPool.delete(oldest);
  }
  return client;
}

function clientPoolKey(config: LLMConfig): string {
  const credentialDigest = crypto.createHash('sha256').update(config.apiKey).digest('hex');
  // Two providers can share a URL and key but differ only by a routing header, so the
  // cache key must include the header set (sorted for a stable digest).
  const headerDigest = config.headers && Object.keys(config.headers).length
    ? crypto.createHash('sha256')
      .update(JSON.stringify(Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex')
    : '';
  return [
    config.protocol || 'openai-completions',
    config.baseUrl.replace(/\/+$/, '').toLowerCase(),
    credentialDigest,
    headerDigest,
    config.model,
    config.thinking ? `${config.thinking.format}:${config.thinking.wire}` : (config.thinkingLevel?.trim() || ''),
  ].join('\n');
}

/**
 * Detects a provider rejection caused by image content parts. Several OpenAI-compatible
 * servers phrase this differently ("image", "vision", "multimodal", "image_url"), so the
 * check is deliberately narrow: HTTP 400/422 plus one modality keyword.
 */
function isImageUnsupportedError(error: Error & { status?: number }): boolean {
  const status = Number(error.status);
  if (Number.isFinite(status) && status !== 400 && status !== 422) return false;
  return /image|vision|multimodal/i.test(error.message);
}

function isUnsupportedUsageOption(error: unknown): boolean {
  const status = Number((error as { status?: unknown })?.status);
  if (![400, 404, 422].includes(status)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /stream_options|include_usage|unknown (?:parameter|field)|unsupported (?:parameter|field|option)/i.test(message);
}
