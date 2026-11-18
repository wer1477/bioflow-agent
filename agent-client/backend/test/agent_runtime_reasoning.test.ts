import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation, getMessages } from '../src/agent/config/conversation_service.js';
import { PersistedRunState } from '../src/agent/service/agent_service.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * Reasoning must reach the UI and the durable record, and must never be handed back to the
 * provider as assistant content.
 *
 * A fake provider streams `reasoning_content` before each answer, asks for one read-only
 * tool call on the first turn, and answers on the second — so the second request body is a
 * real opportunity for the first turn's reasoning to leak back in.
 */
const FIRST_REASONING = 'SECRET_REASONING_ONE';
const SECOND_REASONING = 'SECRET_REASONING_TWO';

test('reasoning is streamed to the UI and never re-sent to the provider', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      const rows = bodies.length === 1
        ? [
            { choices: [{ delta: { reasoning_content: FIRST_REASONING } }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_1',
                    function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }) },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            },
          ]
        : [
            { choices: [{ delta: { reasoning_content: SECOND_REASONING } }] },
            { choices: [{ delta: { content: 'final answer' }, finish_reason: 'stop' }] },
          ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const project = createTempProject('runtime-reasoning');
  const conversation = createConversation({ title: 'runtime reasoning', projectPath: project.projectPath });
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
    userMessage: 'Report the working directory.',
    systemPrompt: 'You are a test agent.',
    conversationId: conversation.id,
    mcpServers: [],
  })) {
    events.push(event);
  }

  // 1. Both turns' reasoning reached the stream the UI consumes.
  assert.deepEqual(
    events.filter((event) => event.type === 'thinking').map((event) => event.content),
    [FIRST_REASONING, SECOND_REASONING],
  );

  // 2. No request ever carries reasoning back to the provider, in any role. The second
  //    request is the one that echoes the first turn's assistant message, so it is the
  //    place a leak would show up.
  assert.ok(bodies.length >= 2, `expected a second request (saw ${bodies.length})`);
  assert.ok(!JSON.stringify(bodies[1].messages).includes(FIRST_REASONING),
    'reasoning must not be re-sent as assistant content');
  for (const [index, body] of bodies.entries()) {
    for (const message of body.messages as Array<{ role: string; content?: unknown }>) {
      const content = typeof message.content === 'string' ? message.content : '';
      assert.ok(!content.includes(FIRST_REASONING) && !content.includes(SECOND_REASONING),
        `request ${index + 1} carried reasoning inside a ${message.role} message`);
    }
  }
});

/**
 * The other half of the contract, driven through the real persistence path: reasoning must
 * not join the message content, and it must still be readable back from the transcript —
 * the raw provider chunks are the only place it was ever stored.
 */
test('reasoning stays out of the message content and is rebuilt from the raw chunks', () => {
  const project = createTempProject('runtime-reasoning-record');
  const conversation = createConversation({ title: 'reasoning record', projectPath: project.projectPath });
  try {
    const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });
    const runId = runState.runId;
    assert.ok(runId);
    const transcript = createTranscriptRecorder(conversation.id, runId);
    assert.ok(transcript);
    runState.attachTranscript(transcript);

    // What the runtime writes for a turn that reasons and then answers: the raw chunk goes
    // to the transcript, the thinking event goes to the UI, and only the answer reaches
    // `fullContent`.
    transcript.recordModelChunk('request-1', { choices: [{ delta: { reasoning_content: FIRST_REASONING } }] });
    runState.applyRuntimeEvent({ type: 'thinking', content: FIRST_REASONING });
    runState.applyRuntimeEvent({ type: 'content', content: 'final answer' });
    transcript.recordModelResponse({
      requestId: 'request-1',
      turnIndex: 0,
      content: 'final answer',
      toolCalls: [],
      finishReason: 'stop',
    });
    runState.persist('completed');

    const message = getMessages(conversation.id).find((item) => item.toolCalls?.run?.runId === runId);
    assert.ok(message);
    assert.equal(message.content, 'final answer');
    assert.ok(!message.content.includes(FIRST_REASONING), 'reasoning must not join the message content');

    const events = (message.toolCalls?.run?.events || []) as Array<{ type: string; content?: string }>;
    // Reasoning sits ahead of the narration of the turn it belongs to.
    assert.deepEqual(events.map((event) => event.type), ['thinking', 'info']);
    assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.content), [FIRST_REASONING]);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
