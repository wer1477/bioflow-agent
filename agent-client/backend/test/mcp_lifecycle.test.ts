import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { MCPServerSession } from '../src/agent/mcp_manager.js';

test('an empty MCP server list still synchronizes sessions and emits MCP status', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const calls: unknown[][] = [];
  const manager = {
    async connectServers(configs: unknown[]) {
      calls.push(configs);
      return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: ['stale-server'] };
    },
  };
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const runtime = new AgentRuntime(manager as any);
  const iterator = runtime.chat({
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test' },
    messages: [],
    userMessage: 'Hello',
    mcpServers: [],
  });

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'mcp_status', connected: [], failed: [], disconnected: ['stale-server'] },
  });
  assert.deepEqual(calls, [[]]);
});

test('the first model request carries the resident surface and never an MCP tool schema', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const mcpTool = {
    type: 'function',
    function: { name: 'biology.search', description: 'Search biology.', parameters: { type: 'object', properties: {} } },
  };
  const manager = {
    async connectServers() {
      return {
        tools: [mcpTool],
        serverCatalog: [{
          name: 'biology',
          instructions: 'Use this server for biology records.',
          tools: [{ kind: 'mcp_tool', id: 'biology.search', server: 'biology', toolName: 'search', description: 'Search biology.' }],
          resources: [],
        }],
        connected: [{ name: 'biology', tools_count: 1, prompts_count: 0, resources_count: 0 }],
        failed: [],
        disconnected: [],
      };
    },
  };
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const runtime = new AgentRuntime(manager as any);
  for await (const _event of runtime.chat({
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: 128000 },
    messages: [],
    userMessage: 'Hello',
    mcpServers: [],
  })) {
    // Drain the run; only the first model request matters here.
  }

  assert.ok(bodies.length >= 1, 'the runtime must have issued a model request');
  const tools = bodies[0].tools || [];
  const names = tools.map((tool: any) => tool.function?.name);

  assert.ok(names.includes('toollibrary'), 'the tool library browse entry stays resident');
  assert.ok(names.includes('toolload'), 'the tool library load entry stays resident');
  assert.ok(names.includes('exec_command'), 'CoreTools stay resident');
  assert.equal(names.includes('load_skill'), false, 'the legacy load_skill entry is retired');
  assert.equal(names.includes('biology.search'), false, 'MCP tool schemas load on demand');
  assert.equal(names.some((name: string) => name.includes('__')), false, 'no MCP tool leaks into the resident surface');

  const library = tools.find((tool: any) => tool.function?.name === 'toollibrary');
  const description = String(library?.function?.description);
  assert.match(description, /two-level tool library/);
  assert.match(description, /<tool_library_domains>/);
  assert.doesNotMatch(description, /<mcp_catalog>/);
  assert.doesNotMatch(description, /- server: biology/);
});

test('a non-responsive MCP initialization times out and closes its transport', async () => {
  const session = new MCPServerSession('hung', {
    name: 'hung',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  });

  await assert.rejects(session.start(50), /Connection to 'hung' timed out after 0.05s/);
  assert.equal(session.connected, false);
});
