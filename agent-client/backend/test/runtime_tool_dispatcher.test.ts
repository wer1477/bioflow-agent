import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { RuntimeToolDispatcher } from '../src/agent/runtime_tool_dispatcher.js';
import { mcpManager } from '../src/agent/mcp_manager.js';
import type { CatalogServerEntry } from '../src/agent/types.js';
import { KNOWLEDGEBASE_TOOL_NAME, READ_FILE_TOOL_NAME, TOOLLIBRARY_CORE_TOOL_ID, TOOLLIBRARY_TOOL_NAME, TOOLLOAD_TOOL_NAME } from '../src/agent/core_tools/ids.js';

const delayedMcpTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'biology_search',
    description: 'Search the biology catalog.',
    parameters: { type: 'object', properties: {} },
  },
};

const mcpServers: CatalogServerEntry[] = [{
  name: 'biology',
  instructions: 'Use this server for biology records.',
  tools: [{ kind: 'mcp_tool', id: 'biology_search', server: 'biology', toolName: 'search', description: 'Search the biology catalog.' }],
  resources: [{ kind: 'mcp_resource', server: 'biology', uri: 'biology://catalog', name: 'catalog', mimeType: 'text/plain' }],
}];

const biologySkill = {
  id: 'bio-seq',
  name: 'bio-seq',
  description: 'Sequence validation tools.',
  instructions: 'Use bio-seq for sequence work.',
  resources: [{
    id: 'resource-1',
    fileName: 'notes.md',
    mimeType: 'text/markdown',
    size: 8,
    content: 'notes!!!',
    encoding: 'utf8' as const,
  }],
  directory: '',
};

function createDispatcher(options: {
  manager?: unknown;
  addedTools?: ChatCompletionTool[][];
  skills?: unknown[];
  mainAgent?: Record<string, unknown>;
} = {}): RuntimeToolDispatcher {
  const addedTools = options.addedTools || [];
  return new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'Find biology records.',
      mcpServers: [],
      skills: (options.skills ?? [biologySkill]) as any,
      ...(options.mainAgent ? { mainAgent: options.mainAgent as any } : {}),
    },
    manager: (options.manager || mcpManager) as any,
    mcpToolsByName: new Map([[delayedMcpTool.function.name, delayedMcpTool]]),
    mcpServers,
    addTools: (tools) => {
      addedTools.push(tools);
      return tools.map((tool) => tool.type === 'function' ? tool.function.name : '');
    },
    runInstanceId: 'test-run',
  });
}

test('toolload registers one MCP tool schema without executing the MCP tool', async () => {
  const addedTools: ChatCompletionTool[][] = [];
  const dispatcher = createDispatcher({ addedTools });

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { id: 'biology_search' });

  assert.deepEqual(JSON.parse(dispatched.result), {
    ok: true,
    action: 'mcp_tool',
    id: 'biology_search',
    loaded: ['biology_search'],
    alreadyLoaded: false,
  });
  assert.deepEqual(dispatched.events, []);
  assert.deepEqual(addedTools, [[delayedMcpTool]]);
});

test('toolload loads one skill body and its resources by id', async () => {
  const dispatcher = createDispatcher();

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { id: 'bio-seq' });
  const parsed = JSON.parse(dispatched.result);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'skill');
  assert.equal(parsed.skillId, 'bio-seq');
  assert.equal(parsed.skillName, 'bio-seq');
  assert.match(parsed.content, /## Skill: bio-seq/);
  assert.match(parsed.content, /Use bio-seq for sequence work\./);
  assert.match(parsed.content, /### Resource: notes\.md\nnotes!!!/);
  assert.deepEqual(dispatched.events, []);
});

test('toolload reports an unavailable capability', async () => {
  const dispatcher = createDispatcher();

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { id: 'biology_missing' });

  const parsed = JSON.parse(dispatched.result);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /is not available to this agent/);
});

test('toolload rejects mixing id with resource parameters', async () => {
  const dispatcher = createDispatcher();

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { id: 'biology_search', resource: 'biology://catalog' });

  const parsed = JSON.parse(dispatched.result);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Pass either id .* or resource\/server/);
});

test('toolload without any selector guides the model back to the catalog', async () => {
  const dispatcher = createDispatcher();

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, {});

  const parsed = JSON.parse(dispatched.result);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /requires id .* or resource\/server/);
});

test("toolload lists one server's MCP resources through the catalog", async () => {
  const dispatcher = createDispatcher();

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { server: 'biology' });

  assert.deepEqual(JSON.parse(dispatched.result), {
    ok: true,
    action: 'mcp_resource',
    server: 'biology',
    resources: [{ server: 'biology', uri: 'biology://catalog', name: 'catalog', mimeType: 'text/plain' }],
  });
});

test('toolload reads one MCP resource through the manager', async () => {
  const reads: string[][] = [];
  const dispatcher = createDispatcher({
    manager: {
      async readResource(server: string, uri: string) {
        reads.push([server, uri]);
        return { contents: [{ uri, mimeType: 'text/plain', text: 'catalog body' }] };
      },
    },
  });

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { resource: 'biology://catalog' });

  assert.deepEqual(reads, [['biology', 'biology://catalog']]);
  assert.deepEqual(JSON.parse(dispatched.result), {
    ok: true,
    action: 'mcp_resource',
    server: 'biology',
    uri: 'biology://catalog',
    content: { contents: [{ uri: 'biology://catalog', mimeType: 'text/plain', text: 'catalog body' }] },
  });
});

test('toolload surfaces a failed MCP resource read', async () => {
  const dispatcher = createDispatcher({
    manager: { async readResource() { return { error: 'resource unavailable' }; } },
  });

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { resource: 'biology://catalog' });

  const parsed = JSON.parse(dispatched.result);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'resource unavailable');
  assert.equal(parsed.uri, 'biology://catalog');
});

test('toolload rejects a resource uri that no connected server exposes', async () => {
  const dispatcher = createDispatcher();

  const dispatched = await dispatcher.execute(TOOLLOAD_TOOL_NAME, { resource: 'other://thing' });

  const parsed = JSON.parse(dispatched.result);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /is not exposed by any connected MCP server/);
});

test('toollibrary browsing is routed through the dispatcher', async () => {
  const dispatcher = createDispatcher();

  const index = await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {});
  const parsed = JSON.parse(index.result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'index');
  assert.ok(Array.isArray(parsed.domains));

  const unknown = await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { domain: 'nope' });
  const unknownParsed = JSON.parse(unknown.result);
  assert.equal(unknownParsed.ok, false);
  assert.match(unknownParsed.error, /Unknown tool-library domain/);
});

test('internal MCP servers are hidden from the tool library but still back web_search', async () => {
  const internalTool: ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'tavily_tavily_search',
      description: 'Search the web.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  };
  const browsableTool: ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'biology_lookup',
      description: 'Lookup biology records.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
    },
  };
  const managerCalls: string[] = [];
  const dispatcher = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'Search.',
      mcpServers: [{ id: 'tavily', name: 'tavily', internal: true } as any],
    },
    manager: {
      async executeTool(tool: string) {
        managerCalls.push(tool);
        return JSON.stringify({ results: [{ title: 'Hit', url: 'https://example.test/hit', content: 'snippet' }] });
      },
    } as any,
    mcpToolsByName: new Map([
      [internalTool.function.name, internalTool],
      [browsableTool.function.name, browsableTool],
    ]),
    mcpServers: [
      {
        name: 'tavily',
        instructions: '',
        tools: [{ kind: 'mcp_tool', id: 'tavily_tavily_search', server: 'tavily', toolName: 'tavily_search', description: 'Search the web.' }],
        resources: [{ kind: 'mcp_resource', server: 'tavily', uri: 'tavily://docs', name: 'docs' }],
      },
      {
        name: 'biology',
        instructions: '',
        tools: [{ kind: 'mcp_tool', id: 'biology_lookup', server: 'biology', toolName: 'lookup', description: 'Lookup biology records.' }],
        resources: [],
      },
    ],
    addTools: () => [],
    runInstanceId: 'test-run',
  });

  // The internal provider never reaches the catalog; the non-internal capability that is
  // not listed on disk still shows up in the runtime fallback domain.
  const fallback = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { domain: 'Unclassified' })).result);
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.entries.map((entry: any) => entry.id), ['biology_lookup']);

  // ...and its schema cannot be registered for the next turn.
  const hiddenLoad = JSON.parse((await dispatcher.execute(TOOLLOAD_TOOL_NAME, { id: 'tavily_tavily_search' })).result);
  assert.equal(hiddenLoad.ok, false);
  assert.match(hiddenLoad.error, /is not available to this agent/);

  // Its MCP resources are hidden together with its tools.
  const hiddenResources = JSON.parse((await dispatcher.execute(TOOLLOAD_TOOL_NAME, { server: 'tavily' })).result);
  assert.deepEqual(hiddenResources, { ok: true, action: 'mcp_resource', server: 'tavily', resources: [] });

  // The provider stays connected for the built-in web_search CoreTool.
  const search = JSON.parse((await dispatcher.execute('web_search', { query: 'bioinformatics' })).result);
  assert.equal(search.ok, true);
  assert.deepEqual(search.providers.map((provider: any) => provider.server), ['tavily']);
  assert.deepEqual(managerCalls, ['tavily_tavily_search']);
});

test('web_search fans out to Tavily and Exa, merges and de-duplicates results', async () => {
  const calls: Array<{ tool: string; args: any }> = [];
  const manager = {
    async executeTool(tool: string, args: any) {
      calls.push({ tool, args });
      if (tool === 'tavily_tavily_search') {
        return JSON.stringify({ results: [
          { title: 'Shared page', url: 'https://example.com/page/', content: 'tavily snippet', score: 0.9 },
          { title: 'Tavily only', url: 'https://tavily.example/item', content: 'tavily second' },
        ] });
      }
      return JSON.stringify({ results: [
        { title: 'Shared page', url: 'https://example.com/page', text: 'exa duplicate' },
        { title: 'Exa only', url: 'https://exa.example/item', text: 'exa snippet' },
      ] });
    },
  };
  const dispatcher = new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'Search.',
      mcpServers: [],
    },
    manager: manager as any,
    mcpToolsByName: new Map([
      ['tavily_tavily_search', { type: 'function', function: { name: 'tavily_tavily_search', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } } } } }],
      ['exa_web_search_exa', { type: 'function', function: { name: 'exa_web_search_exa', parameters: { type: 'object', properties: { query: { type: 'string' }, numResults: { type: 'number' } } } } }],
    ]) as any,
    mcpServers: [
      { name: 'tavily', instructions: '', tools: [{ kind: 'mcp_tool', id: 'tavily_tavily_search', server: 'tavily', toolName: 'tavily_search', description: 'search' }], resources: [] },
      { name: 'exa', instructions: '', tools: [{ kind: 'mcp_tool', id: 'exa_web_search_exa', server: 'exa', toolName: 'web_search_exa', description: 'search' }], resources: [] },
    ],
    addTools: () => [],
    runInstanceId: 'test-run',
  });

  const parsed = JSON.parse((await dispatcher.execute('web_search', { query: 'bioinformatics', max_results: 3 })).result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results.length, 3);
  assert.deepEqual(parsed.results.map((result: any) => result.url), [
    'https://example.com/page/',
    'https://tavily.example/item',
    'https://exa.example/item',
  ]);
  assert.deepEqual(parsed.providers.map((provider: any) => [provider.server, provider.ok]), [['tavily', true], ['exa', true]]);
  assert.equal(calls.find((call) => call.tool === 'tavily_tavily_search')?.args.max_results, 3);
  assert.equal(calls.find((call) => call.tool === 'exa_web_search_exa')?.args.numResults, 3);
});

test('web_search reports a missing provider and survives one failing provider', async () => {
  const noProvider = new RuntimeToolDispatcher({
    request: { llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' }, messages: [], userMessage: 'Search.', mcpServers: [] },
    manager: { async executeTool() { throw new Error('unused'); } } as any,
    mcpToolsByName: new Map(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'test-run',
  });
  const missing = JSON.parse((await noProvider.execute('web_search', { query: 'x' })).result);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NO_WEB_SEARCH_PROVIDER');

  const dispatcher = new RuntimeToolDispatcher({
    request: { llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' }, messages: [], userMessage: 'Search.', mcpServers: [] },
    manager: { async executeTool(tool: string) {
      if (tool === 'tavily_tavily_search') throw new Error('tavily down');
      return JSON.stringify({ results: [{ title: 'Exa hit', url: 'https://exa.example/hit', text: 'ok' }] });
    } } as any,
    mcpToolsByName: new Map([['exa_web_search_exa', { type: 'function', function: { name: 'exa_web_search_exa', parameters: { type: 'object', properties: {} } } }]]) as any,
    mcpServers: [
      { name: 'tavily', instructions: '', tools: [{ kind: 'mcp_tool', id: 'tavily_tavily_search', server: 'tavily', toolName: 'tavily_search', description: 'search' }], resources: [] },
      { name: 'exa', instructions: '', tools: [{ kind: 'mcp_tool', id: 'exa_web_search_exa', server: 'exa', toolName: 'web_search_exa', description: 'search' }], resources: [] },
    ],
    addTools: () => [],
    runInstanceId: 'test-run',
  });
  const fallback = JSON.parse((await dispatcher.execute('web_search', { query: 'x' })).result);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.results.length, 1);
  assert.deepEqual(fallback.providers.map((provider: any) => [provider.server, provider.ok]), [['tavily', false], ['exa', true]]);
});

test('a CoreTool call outside the agent configuration is refused, except the capability families', async () => {
  const dispatcher = createDispatcher({ mainAgent: { id: 'main', coreToolIds: ['shell'] } });

  const blocked = JSON.parse((await dispatcher.execute(READ_FILE_TOOL_NAME, { file_path: 'notes.md' })).result);
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /not configured for this agent/);

  // Tool Library and Knowledge Base stay resident for every role; the binding only decides
  // whether biod or the model selects. `toolload` must therefore still work unconfigured.
  const allowedUnconfigured = JSON.parse((await dispatcher.execute(TOOLLOAD_TOOL_NAME, { id: 'bio-seq' })).result);
  assert.equal(allowedUnconfigured.ok, true);

  const configured = createDispatcher({ mainAgent: { id: 'main', coreToolIds: [TOOLLIBRARY_CORE_TOOL_ID] } });
  const allowed = JSON.parse((await configured.execute(TOOLLOAD_TOOL_NAME, { id: 'bio-seq' })).result);
  assert.equal(allowed.ok, true);
});

test('knowledgebase browsing is scoped to the agent knowledge entries', async () => {
  const empty = createDispatcher({ mainAgent: { id: 'main', knowledgeEntryIds: [] } });
  const emptyIndex = JSON.parse((await empty.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'index' })).result);
  assert.equal(emptyIndex.ok, true);
  assert.deepEqual(emptyIndex.domains, []);

  const scoped = createDispatcher({ mainAgent: { id: 'main', knowledgeEntryIds: ['Bioinformatics/pysam'] } });
  const scopedIndex = JSON.parse((await scoped.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'index' })).result);
  assert.deepEqual(scopedIndex.domains.map((domain: { name: string }) => domain.name), ['Bioinformatics']);
  assert.equal(scopedIndex.domains[0].entries, 1);

  const catalog = JSON.parse((await scoped.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'catalog', domain: 'Bioinformatics' })).result);
  assert.deepEqual(catalog.entries.map((entry: { id: string }) => entry.id), ['Bioinformatics/pysam']);

  const blocked = JSON.parse((await scoped.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'catalog', domain: 'General Science' })).result);
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /is not enabled for this agent/);

  const blockedEntry = JSON.parse((await scoped.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'read', entry: 'Bioinformatics/anndata' })).result);
  assert.equal(blockedEntry.ok, false);
  assert.match(String(blockedEntry.error), /is not enabled for this agent/);
});
