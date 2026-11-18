import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * Regression guard for the failure that aborted run 733ad6a0 in project "123":
 * after ten tool-use turns the runtime injected a checkpoint note as a *system*
 * message at the END of the conversation. The provider requires the single system
 * message to be first ("System message must be at the beginning." -> HTTP 400),
 * so the very next model request failed and the run died.
 *
 * A fake provider records every request body and keeps asking for one read-only
 * tool call until the checkpoint threshold has been crossed.
 */
const TOOL_TURNS_TO_TRIGGER_CHECKPOINT = 10;

test('runtime guidance never adds a second system message to a conversation', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      const toolTurn = bodies.length;
      const chunk = toolTurn <= TOOL_TURNS_TO_TRIGGER_CHECKPOINT
        ? {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `call_${toolTurn}`,
                  function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }
        : { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const project = createTempProject('system-message-role');
  const conversation = createConversation({ title: 'system message role', projectPath: project.projectPath });
  t.after(() => {
    deleteConversation(conversation.id);
    project.cleanup();
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const runtime = new AgentRuntime({ async connectServers() { return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] }; } } as any);
  for await (const _event of runtime.chat({
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: 128_000 },
    messages: [],
    userMessage: 'Keep checking the working directory.',
    systemPrompt: 'You are a test agent.',
    conversationId: conversation.id,
    mcpServers: [],
  })) {
    // Drain the run; the recorded request bodies are the assertion target.
  }

  assert.ok(
    bodies.length > TOOL_TURNS_TO_TRIGGER_CHECKPOINT,
    `the run must cross the checkpoint threshold and issue another request (saw ${bodies.length})`,
  );

  for (const [index, body] of bodies.entries()) {
    const systemIndexes = (body.messages as Array<{ role: string }>)
      .map((message, position) => (message.role === 'system' ? position : -1))
      .filter((position) => position >= 0);
    assert.deepEqual(
      systemIndexes,
      [0],
      `request ${index + 1} must carry exactly one system message, at index 0 (saw ${JSON.stringify(systemIndexes)})`,
    );
  }
});
