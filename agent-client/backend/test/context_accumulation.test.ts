import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import {
  appendContextMessage,
  listContextMessages,
  repairRunToolPairs,
  seedContextMessages,
} from '../src/agent/config/context_message_store.js';
import { RuntimeContextManager } from '../src/agent/context_manager.js';
import { createTempProject } from './helpers/project_fixture.js';

test('the model transcript accumulates rows and repairs unanswered tool calls', () => {
  const project = createTempProject('context-accumulation');
  const conversation = createConversation({ title: 'accumulation', projectPath: project.projectPath });
  try {
    seedContextMessages(conversation.id, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);

    const runId = 'run-1';
    appendContextMessage(conversation.id, { runId, role: 'user', content: 'run pwd' });
    appendContextMessage(conversation.id, {
      runId,
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' }],
    });

    assert.equal(repairRunToolPairs(conversation.id, runId), 1, 'the unanswered call must be repaired once');
    assert.equal(repairRunToolPairs(conversation.id, runId), 0, 'repair is idempotent');

    const rows = listContextMessages(conversation.id);
    assert.deepEqual(rows.map((row) => row.role), ['user', 'assistant', 'user', 'assistant', 'tool']);
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3, 4, 5]);
    assert.equal(rows[4].toolCallId, 'call_1');
    assert.equal(rows[4].toolName, 'exec_command');
    assert.match(String(rows[4].content), /ended before this tool returned a result/);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('the assembled history replays the accumulated transcript and prices it', () => {
  const managed = new RuntimeContextManager().buildManagedHistory({
    conversationId: 'not-a-stored-conversation',
    history: [
      { role: 'user', content: 'run pwd' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' }] },
      { role: 'tool', toolCallId: 'call_1', content: 'x'.repeat(4000) },
    ],
    userMessage: 'continue',
    context: {
      agent: {},
      llm: { model: 'test', contextWindowTokens: 128_000 },
      systemPrompt: 'system',
      coreTools: [],
      mcpServers: [],
      skills: [],
      workspace: null,
    } as any,
  });

  assert.equal(managed.messages.length, 3);
  assert.equal(managed.messages[1].toolCalls?.[0].id, 'call_1');
  assert.equal(managed.messages[2].toolCallId, 'call_1');
  // 4,000 characters of tool output must reach the budget instead of being dropped.
  assert.ok(managed.budget.breakdown.messages > 1_000, `tool output must be priced (${managed.budget.breakdown.messages})`);
});

test('the runtime replays tool_calls/tool rows and reports the rows it produced', async (t) => {
  const bodies: any[] = [];
  const reported: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      const chunk = { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const runtime = new AgentRuntime({
    async connectServers() {
      return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] };
    },
  } as any);

  for await (const _event of runtime.chat({
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: 128_000 },
    messages: [
      { role: 'user', content: 'run pwd' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' }] },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true,"stdout":"/tmp"}' },
    ],
    userMessage: 'continue',
    systemPrompt: 'You are a test agent.',
    mcpServers: [],
    onContextMessage: (message) => reported.push(message),
  })) {
    // Drain the run; the recorded request body is the assertion target.
  }

  assert.equal(bodies.length, 1);
  const messages = bodies[0].messages as any[];
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, 'run pwd');
  assert.equal(messages[2].role, 'assistant');
  assert.deepEqual(messages[2].tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' },
  }]);
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'call_1');

  assert.deepEqual(reported.map((message) => message.role), ['assistant']);
  assert.equal(reported[0].content, 'done');
});
