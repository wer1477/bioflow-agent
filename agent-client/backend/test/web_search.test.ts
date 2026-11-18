import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogServerEntry, CatalogToolEntry } from '../src/agent/types.js';
import {
  buildSearchArguments,
  discoverSearchProviders,
  mergeSearchResults,
  parseSearchOutput,
  type ProviderSearchOutcome,
  type SearchResult,
} from '../src/agent/core_tools/web_search.js';

function catalogTool(server: string, toolName: string): CatalogToolEntry {
  return {
    kind: 'mcp_tool',
    id: `${server}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_'),
    server,
    toolName,
    description: `${toolName} tool on ${server}`,
  };
}

function catalogServer(name: string, toolNames: string[]): CatalogServerEntry {
  return { name, instructions: '', tools: toolNames.map((toolName) => catalogTool(name, toolName)), resources: [] };
}

function hit(provider: string, url: string, title = url): SearchResult {
  return { provider, url, title };
}

function outcome(server: string, results: SearchResult[], error?: string): ProviderSearchOutcome {
  return error === undefined
    ? { server, ok: true, results }
    : { server, ok: false, error, results };
}

test('discoverSearchProviders prefers tavily then exa and takes one tool per server', () => {
  const catalog: CatalogServerEntry[] = [
    catalogServer('context7', ['resolve-library-id', 'query-docs']),
    catalogServer('exa', ['web_search_exa', 'crawling_exa', 'company_research_exa']),
    catalogServer('tavily', ['tavily_extract', 'tavily_search', 'tavily_crawl', 'tavily_map', 'tavily_research']),
    catalogServer('serper', ['search']),
  ];

  const providers = discoverSearchProviders(catalog);

  assert.deepEqual(providers.map((provider) => provider.server), ['tavily', 'exa', 'serper']);
  assert.deepEqual(providers[0], { server: 'tavily', publicName: 'tavily_tavily_search', toolName: 'tavily_search' });
  assert.deepEqual(providers[1], { server: 'exa', publicName: 'exa_web_search_exa', toolName: 'web_search_exa' });
  assert.deepEqual(providers[2], { server: 'serper', publicName: 'serper_search', toolName: 'search' });
});

test('discoverSearchProviders skips extract/crawl/map/research/agent/fetch tools', () => {
  const catalog = [
    catalogServer('exa', ['web_search_exa']),
    catalogServer('ops', ['web_extract', 'web_crawl', 'web_map', 'web_research', 'web_agent', 'web_fetch', 'web_search']),
    catalogServer('only-excluded', ['crawling_exa', 'deep_researcher_start']),
  ];

  const providers = discoverSearchProviders(catalog);

  assert.deepEqual(providers.map((provider) => provider.toolName), ['web_search_exa', 'web_search']);
});

test('discoverSearchProviders tolerates empty and malformed catalogs', () => {
  assert.deepEqual(discoverSearchProviders([]), []);
  assert.deepEqual(discoverSearchProviders(undefined as unknown as CatalogServerEntry[]), []);
  assert.deepEqual(discoverSearchProviders([{ name: 'exa', instructions: '', resources: [] } as unknown as CatalogServerEntry]), []);
});

test('buildSearchArguments maps query and max_results onto a Tavily schema', () => {
  const provider = { server: 'tavily', publicName: 'tavily_tavily_search', toolName: 'tavily_search' };
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
      search_depth: { type: 'string' },
    },
    required: ['query'],
  };

  assert.deepEqual(buildSearchArguments(provider, schema, 'p53 structure', 5), {
    query: 'p53 structure',
    max_results: 5,
  });
});

test('buildSearchArguments maps numResults for Exa and does not guess other required fields', () => {
  const provider = { server: 'exa', publicName: 'exa_web_search_exa', toolName: 'web_search_exa' };
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      numResults: { type: 'number' },
      api_key: { type: 'string' },
    },
    required: ['query', 'api_key'],
  };

  assert.deepEqual(buildSearchArguments(provider, schema, '  CRISPR screen  ', 3), {
    query: 'CRISPR screen',
    numResults: 3,
  });
});

test('buildSearchArguments follows the declared key names for q/limit schemas', () => {
  const provider = { server: 'custom', publicName: 'custom_search', toolName: 'search' };
  const schema = { properties: { q: { type: 'string' }, limit: { type: 'integer' } } };

  assert.deepEqual(buildSearchArguments(provider, schema, 'alpha', 7), { q: 'alpha', limit: 7 });
});

test('buildSearchArguments falls back to {query, max_results} when the schema is unusable', () => {
  const provider = { server: 'exa', publicName: 'exa_web_search_exa', toolName: 'web_search_exa' };

  assert.deepEqual(buildSearchArguments(provider, undefined, 'beta', 2), { query: 'beta', max_results: 2 });
  assert.deepEqual(buildSearchArguments(provider, 'not a schema', 'beta', 2), { query: 'beta', max_results: 2 });
  assert.deepEqual(buildSearchArguments(provider, { type: 'object' }, 'beta', 2), { query: 'beta', max_results: 2 });
  assert.deepEqual(buildSearchArguments(provider, null, 'beta', Number.NaN), { query: 'beta', max_results: 5 });
});

test('buildSearchArguments accepts a ChatCompletionTool wrapper as the schema source', () => {
  const provider = { server: 'exa', publicName: 'exa_web_search_exa', toolName: 'web_search_exa' };
  const schema = {
    type: 'function',
    function: {
      name: 'exa_web_search_exa',
      parameters: { type: 'object', properties: { query: { type: 'string' }, numResults: { type: 'number' } } },
    },
  };

  assert.deepEqual(buildSearchArguments(provider, schema, 'gamma', 4), { query: 'gamma', numResults: 4 });
});

test('buildSearchArguments passes only the query when the schema has no result-count field', () => {
  const provider = { server: 'tavily', publicName: 'tavily_tavily_search', toolName: 'tavily_search' };

  assert.deepEqual(buildSearchArguments(provider, { properties: { query: { type: 'string' } } }, 'delta', 5), {
    query: 'delta',
  });
});

test('parseSearchOutput normalizes Tavily-style results', () => {
  const text = JSON.stringify({
    query: 'p53',
    results: [
      {
        title: 'TP53 - Wikipedia',
        url: 'https://en.wikipedia.org/wiki/TP53',
        content: 'Tumor protein p53.',
        score: 0.97,
        published_date: '2024-01-02',
      },
      { title: 'No url', content: 'Snippet only.' },
    ],
  });

  const results = parseSearchOutput('tavily', text);

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    provider: 'tavily',
    title: 'TP53 - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/TP53',
    snippet: 'Tumor protein p53.',
    score: 0.97,
    published: '2024-01-02',
  });
  assert.equal(results[1].url, undefined);
  assert.equal(results[1].snippet, 'Snippet only.');
});

test('parseSearchOutput normalizes Exa-style results from data/items/array shapes', () => {
  const exaPayload = JSON.stringify({
    results: [
      { title: 'Paper', url: 'https://example.org/paper', text: 'Abstract text.', publishedDate: '2023-05-01' },
    ],
  });
  assert.deepEqual(parseSearchOutput('exa', exaPayload), [
    { provider: 'exa', title: 'Paper', url: 'https://example.org/paper', snippet: 'Abstract text.', published: '2023-05-01' },
  ]);

  const dataPayload = JSON.stringify({ data: [{ title: 'Data', url: 'https://example.org/data', description: 'Desc' }] });
  assert.equal(parseSearchOutput('exa', dataPayload)[0].snippet, 'Desc');

  const itemsPayload = JSON.stringify({ items: [{ title: 'Item', url: 'https://example.org/item', snippet: 'Snip' }] });
  assert.equal(parseSearchOutput('exa', itemsPayload)[0].snippet, 'Snip');

  const bareArray = JSON.stringify([{ title: 'Bare', url: 'https://example.org/bare' }]);
  assert.equal(parseSearchOutput('exa', bareArray)[0].title, 'Bare');
});

test('parseSearchOutput unwraps MCP content blocks whose text is JSON', () => {
  const text = JSON.stringify([
    { type: 'text', text: JSON.stringify({ results: [{ title: 'Wrapped', url: 'https://example.org/w', content: 'Inside' }] }) },
  ]);

  assert.deepEqual(parseSearchOutput('tavily', text), [
    { provider: 'tavily', title: 'Wrapped', url: 'https://example.org/w', snippet: 'Inside' },
  ]);
});

test('parseSearchOutput returns an empty array for unparseable or unrelated output', () => {
  assert.deepEqual(parseSearchOutput('tavily', ''), []);
  assert.deepEqual(parseSearchOutput('tavily', 'not json at all'), []);
  assert.deepEqual(parseSearchOutput('tavily', JSON.stringify({ error: 'rate limited' })), []);
  assert.deepEqual(parseSearchOutput('tavily', JSON.stringify({ results: [{ score: 1 }] })), []);
});

test('parseSearchOutput de-duplicates URLs ignoring host case and trailing slashes', () => {
  const text = JSON.stringify({
    results: [
      { title: 'First', url: 'https://Example.COM/Path/' },
      { title: 'Duplicate', url: 'https://example.com/Path' },
      { title: 'Third', url: 'https://example.com/other' },
    ],
  });

  const results = parseSearchOutput('exa', text);

  assert.deepEqual(results.map((result) => result.title), ['First', 'Third']);
});

test('mergeSearchResults interleaves providers round-robin', () => {
  const merged = mergeSearchResults([
    outcome('tavily', [hit('tavily', 'https://a.example/1'), hit('tavily', 'https://a.example/2')]),
    outcome('exa', [hit('exa', 'https://b.example/1'), hit('exa', 'https://b.example/2'), hit('exa', 'https://b.example/3')]),
  ], 10);

  assert.deepEqual(merged.results.map((result) => result.url), [
    'https://a.example/1',
    'https://b.example/1',
    'https://a.example/2',
    'https://b.example/2',
    'https://b.example/3',
  ]);
  assert.equal(merged.truncated, false);
  assert.deepEqual(merged.providers, [
    { server: 'tavily', ok: true },
    { server: 'exa', ok: true },
  ]);
});

test('mergeSearchResults de-duplicates across providers and caps at maxResults', () => {
  const merged = mergeSearchResults([
    outcome('tavily', [hit('tavily', 'https://Example.com/page/'), hit('tavily', 'https://a.example/2')]),
    outcome('exa', [hit('exa', 'https://example.com/page'), hit('exa', 'https://b.example/2')]),
  ], 2);

  assert.deepEqual(merged.results.map((result) => result.url), [
    'https://Example.com/page/',
    'https://a.example/2',
  ]);
  assert.equal(merged.truncated, true);
});

test('mergeSearchResults reports truncated only when unique candidates exceed the limit', () => {
  const exactlyAtLimit = mergeSearchResults([
    outcome('tavily', [hit('tavily', 'https://a.example/1'), hit('tavily', 'https://a.example/2')]),
  ], 2);
  assert.equal(exactlyAtLimit.results.length, 2);
  assert.equal(exactlyAtLimit.truncated, false);

  const duplicatesDoNotCount = mergeSearchResults([
    outcome('tavily', [hit('tavily', 'https://a.example/1'), hit('tavily', 'https://a.example/1/')]),
  ], 2);
  assert.equal(duplicatesDoNotCount.results.length, 1);
  assert.equal(duplicatesDoNotCount.truncated, false);
});

test('mergeSearchResults keeps failed providers in the status list with their error', () => {
  const merged = mergeSearchResults([
    outcome('tavily', [], 'HTTP 401: invalid API key'),
    outcome('exa', [hit('exa', 'https://b.example/1')]),
  ], 5);

  assert.deepEqual(merged.providers, [
    { server: 'tavily', ok: false, error: 'HTTP 401: invalid API key' },
    { server: 'exa', ok: true },
  ]);
  assert.deepEqual(merged.results.map((result) => result.provider), ['exa']);
});

test('mergeSearchResults handles empty outcomes', () => {
  assert.deepEqual(mergeSearchResults([], 5), { results: [], providers: [], truncated: false });
});

test('parseSearchOutput understands the Exa MCP markdown-style result list', () => {
  const text = [
    'Title: Base editing: precision chemistry | Nature Reviews Genetics',
    'URL: https://www.nature.com/articles/s41576-018-0059-1',
    'Published: 2018-10-15T05:47:17.000Z',
    'Author: Rees, Holly A., Liu, David R.',
    'Highlights:',
    '## Abstract',
    'Base editing installs point mutations without double-stranded breaks.',
    '---',
    'Title: CRISPR base editors: genome editing without double-stranded breaks',
    'URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC5995079/',
    'Published: N/A',
    'Highlights:',
    'A review of base editor architectures.',
  ].join('\n');

  const results = parseSearchOutput('exa', text);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.title, 'Base editing: precision chemistry | Nature Reviews Genetics');
  assert.equal(results[0]?.url, 'https://www.nature.com/articles/s41576-018-0059-1');
  assert.match(results[0]?.snippet || '', /point mutations/);
  assert.equal(results[1]?.published, undefined);
  assert.match(results[1]?.snippet || '', /base editor architectures/);
});
