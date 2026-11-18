import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * A delegated child has no approval UI. A call that would ask the user must fail closed
 * with a stable error instead of parking the run until the approval store's ten-minute
 * timeout — the parent's turn is waiting on this child, so a silent stall is the worst
 * possible outcome.
 */
test('a delegated child refuses an approval-requiring call instead of waiting for one', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      const rows = bodies.length === 1
        ? [{
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_write',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ file_path: 'delegated.txt', content: 'should not exist' }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }]
        : [{ choices: [{ delta: { content: 'reported the refusal' }, finish_reason: 'stop' }] }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const project = createTempProject('subagent-approval');
  const conversation = createConversation({ title: 'delegated child', projectPath: project.projectPath });
  t.after(() => {
    deleteConversation(conversation.id);
    project.cleanup();
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const runtime = new AgentRuntime({ async connectServers() { return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] }; } } as any);
  const events: any[] = [];
  for await (const event of runtime.chat({
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: 128_000 },
    messages: [],
    userMessage: 'Write the delegated file.',
    systemPrompt: 'You are a delegated test agent.',
    conversationId: conversation.id,
    mcpServers: [],
    securityMode: 'approval',
    approvalPolicy: 'never',
    delegationDepth: 1,
  })) {
    events.push(event);
  }

  assert.equal(
    events.some((event) => event.type === 'security_approval_request'),
    false,
    'a delegated child must never surface an approval request',
  );

  const results = events.filter((event) => event.type === 'tool_call_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_name, 'write_file');
  assert.match(results[0].result, /approval_unavailable/);

  const content = events.filter((event) => event.type === 'content').map((event) => event.content).join('');
  assert.match(content, /reported the refusal/);
  assert.ok(bodies.length >= 2, 'the run must continue after the refusal rather than stopping');
});
