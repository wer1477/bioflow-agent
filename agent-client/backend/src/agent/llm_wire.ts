import type { LLMThinking } from './types.js';
import type { CacheReportMode } from './config/llm_config_store.js';

/**
 * Request-body helpers shared by every protocol adapter.
 *
 * These used to live inside `llm_client.ts`, but two transports now need the same answers to
 * "which thinking fragment do I send" and "does an absent cache counter mean a miss". Keeping
 * them here is what lets `llm_anthropic.ts` import them without importing the OpenAI client.
 */

/**
 * The thinking fragment for one request.
 *
 * Two encodings exist because the same intent has no shared wire representation:
 * OpenAI-compatible endpoints take a level name in `reasoning_effort`, while
 * Anthropic-compatible ones take a token budget in `thinking.budget_tokens`.
 * Which one an endpoint speaks is declared per provider (`thinkingFormat`) and
 * never inferred from the model name.
 */
export function thinkingOptions(config: { thinking?: LLMThinking; thinkingLevel?: string }): Record<string, unknown> {
  if (config.thinking) return encodeThinking(config.thinking);
  // Legacy path: before providers declared a format, the level was forwarded verbatim.
  const level = config.thinkingLevel?.trim();
  return level ? { reasoning_effort: level } : {};
}

export function encodeThinking(thinking: LLMThinking): Record<string, unknown> {
  if (thinking.format === 'none') return {};
  if (thinking.format === 'anthropic-budget') {
    const budget = Number(thinking.wire);
    if (!Number.isFinite(budget) || budget <= 0) return {};
    return { thinking: { type: 'enabled', budget_tokens: Math.floor(budget) } };
  }
  const effort = String(thinking.wire).trim();
  return effort ? { reasoning_effort: effort } : {};
}

/** The Anthropic-style breakpoint every explicit-cache provider understands. */
export const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' as const } as const;

/**
 * Rewrite the request so an endpoint that only caches what the request marks will cache it.
 *
 * Anthropic Messages and Anthropic-compatible gateways (DashScope) cache nothing unless a
 * content block carries `cache_control`; automatic-caching servers (SGLang, OpenAI,
 * DeepSeek) ignore the field. That is why this runs only when the provider declares
 * `cacheMode: "explicit"` — adding it everywhere would change the wire body for servers
 * that were never verified to accept block content.
 *
 * Three breakpoints, never four (the protocol allows 4; keeping one spare is pi's rule):
 *
 * 1. the system message — the part that must be byte-stable across runs;
 * 2. the **last** tool declaration — tools serialize ahead of every message, so this is the
 *    only way to cache the tool block while the message prefix is still growing;
 * 3. the last content block of the last message — the moving edge of the conversation.
 *
 * The text is wrapped, never rewritten: a provider that dislikes block content fails the
 * request loudly at the first HTTP call instead of silently caching nothing.
 */
export function applyExplicitCacheBreakpoints<M, T>(
  messages: M[],
  tools: T[] | undefined,
): { messages: M[]; tools?: T[] } {
  const nextMessages = (messages as unknown[]).map((message) => ({ ...(message as Record<string, unknown>) })) as Array<Record<string, unknown>>;
  const system = nextMessages[0];
  if (system && system.role === 'system') {
    system.content = withCacheBreakpoint(system.content);
  }
  // Never mark the same block twice: marking the system head as "the last message" would
  // spend a breakpoint on a block that is already cached.
  const last = nextMessages[nextMessages.length - 1];
  if (last && last !== system) {
    last.content = withCacheBreakpoint(last.content);
  }
  const nextTools = tools?.length
    ? (tools as unknown[]).map((tool, index) => (index === (tools as unknown[]).length - 1
      ? { ...(tool as Record<string, unknown>), cache_control: EPHEMERAL_CACHE_CONTROL }
      : tool))
    : tools;
  return {
    messages: nextMessages as unknown as M[],
    tools: nextTools as unknown as T[] | undefined,
  };
}

function withCacheBreakpoint(content: unknown): unknown {
  if (typeof content === 'string') {
    if (!content) return content;
    return [{ type: 'text', text: content, cache_control: EPHEMERAL_CACHE_CONTROL }];
  }
  if (Array.isArray(content)) {
    return content.map((block, index) => (
      index === content.length - 1 && block && typeof block === 'object'
        ? { ...(block as Record<string, unknown>), cache_control: EPHEMERAL_CACHE_CONTROL }
        : block
    ));
  }
  return content;
}

/**
 * Prefix-cache hit count from a provider usage block.
 *
 * Three spellings exist in the wild for the same idea (OpenAI `prompt_tokens_details.
 * cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, Anthropic `cache_read_input_tokens`)
 * and they are normalized here. After that the *absence* of a counter still means two
 * different things depending on the endpoint, so the caller declares which:
 *
 * - `none` — nothing was reported, so the value is unknown (`null`). Never inferred as
 *   zero, or every non-caching endpoint would look like a permanent cache miss.
 * - `hits-only` — the endpoint only emits the field when the count is positive (SGLang
 *   behaves this way even with `--enable-cache-report`). Absence is therefore a *miss*;
 *   reporting it as unknown would silently drop every miss and show a 100% hit rate.
 * - `full` — the endpoint always reports, including an explicit zero, so absence is still
 *   treated as unknown and the explicit zero stands on its own.
 */
export function readCachedPromptTokens(usage: unknown, mode: CacheReportMode = 'none'): number | null {
  if (!usage || typeof usage !== 'object') return mode === 'hits-only' ? 0 : null;
  const record = usage as Record<string, unknown>;
  const details = record.prompt_tokens_details;
  const candidates = [
    details && typeof details === 'object' ? (details as Record<string, unknown>).cached_tokens : undefined,
    record.prompt_cache_hit_tokens,
    record.cache_read_input_tokens,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  // HITS-ONLY endpoints omit the counter on a miss; that omission is the miss.
  return mode === 'hits-only' ? 0 : null;
}
