import type { CatalogServerEntry } from '../types.js';

/**
 * Pure helpers behind the `web_search` CoreTool.
 *
 * The runtime does not talk to a search API directly: Tavily and Exa are
 * connected MCP servers whose search tools are discovered from the runtime
 * catalog. The dispatcher (which owns the MCP sessions) calls the provider
 * tools and feeds their raw text output through these helpers, so everything
 * here is synchronous and side-effect free.
 *
 * Contract: docs are in research/coretool-upgrade-contracts.md §3 (workflow C).
 */

/** One MCP tool that can answer a web search. */
export interface SearchProvider {
  /** Connected MCP server name, for example `tavily`. */
  server: string;
  /** Public tool name as the model/runtime sees it, for example `tavily_tavily_search`. */
  publicName: string;
  /** Raw MCP tool name sent on the wire, for example `tavily_search`. */
  toolName: string;
}

/** One normalized search hit, tagged with the provider that produced it. */
export interface SearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  score?: number;
  published?: string;
  provider: string;
}

/** Raw outcome of asking one provider; a failed provider keeps its error. */
export interface ProviderSearchOutcome {
  server: string;
  ok: boolean;
  error?: string;
  results: SearchResult[];
}

const SEARCH_TOOL_PATTERN = /search/i;
/** Tools that mention "search" but are a different operation (extract/crawl/research/...). */
const NON_SEARCH_TOOL_PATTERN = /extract|crawl|map|research|agent|fetch/i;
const QUERY_KEY_PREFERENCE = ['query', 'q', 'search_query'] as const;
const RESULT_COUNT_KEY_PREFERENCE = ['max_results', 'numResults', 'num_results', 'limit', 'num'] as const;
const DEFAULT_RESULT_COUNT = 5;

/**
 * Find one search tool per connected MCP server.
 *
 * Servers named tavily/exa are tried first (in that order); remaining servers
 * keep their catalog order. A tool qualifies when its raw MCP name contains
 * "search" but not extract/crawl/map/research/agent/fetch.
 */
export function discoverSearchProviders(servers: CatalogServerEntry[]): SearchProvider[] {
  if (!Array.isArray(servers)) return [];
  const ranked: Array<{ provider: SearchProvider; rank: number; order: number }> = [];
  let order = 0;
  for (const server of servers) {
    if (!isRecord(server) || typeof server.name !== 'string') continue;
    const tools = Array.isArray(server.tools) ? server.tools : [];
    const tool = tools.find((entry) => {
      if (!isRecord(entry) || typeof entry.toolName !== 'string') return false;
      return SEARCH_TOOL_PATTERN.test(entry.toolName) && !NON_SEARCH_TOOL_PATTERN.test(entry.toolName);
    });
    if (!tool || !isRecord(tool)) continue;
    ranked.push({
      provider: {
        server: typeof tool.server === 'string' && tool.server ? tool.server : server.name,
        publicName: typeof tool.id === 'string' && tool.id ? tool.id : tool.toolName,
        toolName: tool.toolName,
      },
      rank: serverRank(server.name),
      order: order++,
    });
  }
  ranked.sort((left, right) => left.rank - right.rank || left.order - right.order);
  return ranked.map((entry) => entry.provider);
}

/**
 * Map the generic `web_search` arguments onto one provider's input schema.
 *
 * Only the query key and the result-count key are filled in. Required fields
 * beyond those are intentionally left out: guessing them would silently change
 * the query semantics, and the provider error is recorded by the caller.
 * Schemas that cannot be read fall back to `{ query, max_results }`.
 */
export function buildSearchArguments(
  provider: SearchProvider,
  schema: unknown,
  query: string,
  maxResults: number,
): Record<string, unknown> {
  const queryText = String(query ?? '').trim();
  const resultCount = normalizeResultCount(maxResults);
  const properties = readSchemaProperties(schema);
  if (!properties) return { query: queryText, max_results: resultCount };

  const queryKey = QUERY_KEY_PREFERENCE.find((key) => key in properties) || 'query';
  const countKey = RESULT_COUNT_KEY_PREFERENCE.find((key) => key in properties);
  const args: Record<string, unknown> = { [queryKey]: queryText };
  if (countKey) args[countKey] = resultCount;
  return args;
}

/**
 * Parse one provider's raw MCP text result into normalized hits.
 *
 * Accepts JSON of the shapes used by Tavily/Exa (`{ results }` / `{ data }` /
 * `{ items }`), a bare array, and JSON nested inside MCP `content[].text`
 * blocks. Unparseable text yields an empty array: a malformed provider answer
 * is treated as "no results", never as a crash.
 */
export function parseSearchOutput(server: string, text: string): SearchResult[] {
  const provider = typeof server === 'string' ? server : String(server ?? '');
  const items = extractResultItems(text);
  const fallbackItems = items.length ? items : parseTitleUrlTextResults(text);
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of fallbackItems) {
    const result = toSearchResult(item, provider);
    if (!result) continue;
    if (result.url) {
      const key = normalizeUrlForKey(result.url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
    }
    results.push(result);
  }
  return results;
}

/**
 * Merge provider outcomes into one de-duplicated list.
 *
 * Results are interleaved round-robin so one provider cannot crowd out the
 * others; duplicates are removed by normalized URL. `truncated` means the
 * deduplicated candidate list was longer than `maxResults`.
 */
export function mergeSearchResults(
  outcomes: ProviderSearchOutcome[],
  maxResults: number,
): {
  results: SearchResult[];
  providers: Array<{ server: string; ok: boolean; error?: string }>;
  truncated: boolean;
} {
  const list = Array.isArray(outcomes) ? outcomes.filter(isRecord) : [];
  const limit = normalizeResultCount(maxResults);
  const providers = list.map((outcome) => {
    const status: { server: string; ok: boolean; error?: string } = {
      server: String(outcome.server ?? ''),
      ok: outcome.ok === true,
    };
    if (typeof outcome.error === 'string' && outcome.error) status.error = outcome.error;
    return status;
  });

  const ordered: SearchResult[] = [];
  const longest = list.reduce((max, outcome) => {
    const length = Array.isArray(outcome.results) ? outcome.results.length : 0;
    return Math.max(max, length);
  }, 0);
  for (let index = 0; index < longest; index += 1) {
    for (const outcome of list) {
      const results = Array.isArray(outcome.results) ? outcome.results : [];
      const candidate = results[index];
      if (!isRecord(candidate)) continue;
      ordered.push({
        ...candidate,
        provider: typeof candidate.provider === 'string' && candidate.provider
          ? candidate.provider
          : String(outcome.server ?? ''),
      });
    }
  }

  const unique: SearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const candidate of ordered) {
    if (typeof candidate.url === 'string' && candidate.url) {
      const key = normalizeUrlForKey(candidate.url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
    }
    unique.push(candidate);
  }

  return {
    results: unique.slice(0, limit),
    providers,
    truncated: unique.length > limit,
  };
}

function serverRank(name: string): number {
  const lower = name.toLowerCase();
  if (lower.includes('tavily')) return 0;
  if (lower.includes('exa')) return 1;
  return 2;
}

function normalizeResultCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RESULT_COUNT;
  return Math.max(1, Math.trunc(parsed));
}

/** Read `properties` from a JSON Schema, an MCP tool descriptor or a ChatCompletionTool. */
function readSchemaProperties(schema: unknown): Record<string, unknown> | null {
  if (!isRecord(schema)) return null;
  const direct = schema.properties;
  if (isRecord(direct)) return direct;

  const functionDescription = schema.function;
  if (isRecord(functionDescription) && isRecord(functionDescription.parameters)) {
    const parameters = functionDescription.parameters;
    if (isRecord(parameters.properties)) return parameters.properties;
  }

  const inputSchema = schema.inputSchema;
  if (isRecord(inputSchema) && isRecord(inputSchema.properties)) return inputSchema.properties;

  const parameters = schema.parameters;
  if (isRecord(parameters) && isRecord(parameters.properties)) return parameters.properties;

  return null;
}

/**
 * Exa's hosted MCP endpoint answers with a compact human-readable list instead
 * of JSON:
 *
 *   Title: ...
 *   URL: ...
 *   Published: ...
 *   Highlights:
 *   ...
 *   ---
 *
 * Parse that shape only when `Title:` and `URL:` headers are present; arbitrary
 * text must never be mistaken for search results.
 */
function parseTitleUrlTextResults(text: string): unknown[] {
  if (typeof text !== 'string' || !/^Title:\s+\S/m.test(text) || !/^URL:\s+\S/m.test(text)) return [];
  const blocks = text.split(/\n-{3,}\n/);
  const results: unknown[] = [];
  for (const block of blocks) {
    const title = matchLine(block, 'Title');
    const url = matchLine(block, 'URL');
    if (!url) continue;
    const published = matchLine(block, 'Published');
    const author = matchLine(block, 'Author');
    const highlightsIndex = block.search(/^Highlights:\s*$/m);
    let snippet: string | undefined;
    if (highlightsIndex >= 0) {
      snippet = block
        .slice(highlightsIndex + 'Highlights:'.length)
        .replace(/^\s+/,'')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
    }
    results.push({
      title: title ?? url,
      url,
      ...(snippet ? { content: snippet } : {}),
      ...(published && published !== 'N/A' ? { published } : {}),
      ...(author && author !== 'N/A' ? { author } : {}),
    });
  }
  return results;
}

function matchLine(block: string, label: string): string | undefined {
  const match = new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(block);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function extractResultItems(text: string, depth = 0): unknown[] {
  if (depth > 2 || typeof text !== 'string' || !text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return extractResultItemsFromValue(parsed, depth);
}

function extractResultItemsFromValue(value: unknown, depth: number): unknown[] {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isTextContentBlock)) {
      return value.flatMap((block) => extractResultItems(String((block as Record<string, unknown>).text), depth + 1));
    }
    return value;
  }
  if (!isRecord(value)) return [];
  for (const key of ['results', 'data', 'items']) {
    const nested = value[key];
    if (Array.isArray(nested)) return extractResultItemsFromValue(nested, depth + 1);
    if (isRecord(nested)) {
      const inner = extractResultItemsFromValue(nested, depth + 1);
      if (inner.length > 0) return inner;
    }
  }
  for (const key of ['structuredContent', 'structured_content', 'content']) {
    const nested = value[key];
    if (Array.isArray(nested) && nested.length > 0 && nested.every(isTextContentBlock)) {
      return nested.flatMap((block) => extractResultItems(String((block as Record<string, unknown>).text), depth + 1));
    }
  }
  if (typeof value.url === 'string' && value.url) return [value];
  return [];
}

function isTextContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === 'text' && typeof value.text === 'string';
}

function toSearchResult(item: unknown, provider: string): SearchResult | null {
  if (!isRecord(item)) return null;
  const title = firstNonEmptyString(item.title);
  const url = firstNonEmptyString(item.url);
  const snippet = firstNonEmptyString(item.content)
    ?? firstNonEmptyString(item.text)
    ?? firstNonEmptyString(item.snippet)
    ?? firstNonEmptyString(item.description);
  const score = firstFiniteNumber(item.score);
  const published = firstNonEmptyString(item.published_date)
    ?? firstNonEmptyString(item.publishedDate)
    ?? firstNonEmptyString(item.published);
  if (!title && !url && !snippet) return null;

  const result: SearchResult = { provider };
  if (title) result.title = title;
  if (url) result.url = url;
  if (snippet) result.snippet = snippet;
  if (score !== null) result.score = score;
  if (published) result.published = published;
  return result;
}

/**
 * De-duplication key for a result URL: host case and a trailing slash on the
 * path do not make two hits different. Invalid URLs fall back to a trimmed
 * string comparison.
 */
function normalizeUrlForKey(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function firstFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
