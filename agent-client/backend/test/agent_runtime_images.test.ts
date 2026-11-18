import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * An image returned by a CoreTool must reach the provider as an image content part on
 * the tool message, not as base64 inside the JSON text (which would be truncated by the
 * observation budget and would land in the transcript).
 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lRE9WQAAAABJRU5ErkJggg==';

test('read_file images are sent back to the model as tool-message image parts', async (t) => {
  let imagePath = '';
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
                  id: 'call_image',
                  function: { name: 'read_file', arguments: JSON.stringify({ file_path: imagePath }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }]
        : [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const project = createTempProject('runtime-images');
  const conversation = createConversation({ title: 'runtime images', projectPath: project.projectPath });
  imagePath = path.join(project.projectPath, 'pixel.png');
  await writeFile(imagePath, Buffer.from(PNG_BASE64, 'base64'));
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
    userMessage: 'Show me the image.',
    systemPrompt: 'You are a test agent.',
    conversationId: conversation.id,
    mcpServers: [],
  })) {
    events.push(event);
  }

  const toolResult = events.find((event) => event.type === 'tool_call_result');
  assert.ok(toolResult);
  assert.ok(!String(toolResult.result).includes(PNG_BASE64), 'base64 must not leak into the tool result event');

  assert.equal(bodies.length, 2);
  const toolMessage = bodies[1].messages.find((message: any) => message.role === 'tool');
  assert.ok(toolMessage, 'second request must carry the tool result');
  assert.ok(Array.isArray(toolMessage.content), 'image tool results must use content parts');
  assert.ok(toolMessage.content.some((part: any) => part.type === 'image_url' && String(part.image_url?.url).startsWith('data:image/png;base64,')), 'image part missing');
  assert.ok(toolMessage.content.every((part: any) => part.type !== 'text' || !String(part.text).includes(PNG_BASE64)), 'base64 must not be in the text part');
});
