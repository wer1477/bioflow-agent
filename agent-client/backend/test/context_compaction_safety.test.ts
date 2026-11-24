import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { compactRuntimeMessages } from '../src/agent/context_manager.js';

test('compaction keeps system, pinned blocks, active user and complete tool pairs', async (t) => {
  const summaryPrompts: string[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        summaryPrompts.push(String(body.messages?.at(-1)?.content || ''));
      } catch {
        summaryPrompts.push('');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 1,
              taskState: { userGoal: 'keep structure', currentStatus: 'in_progress' },
              decisions: [], stableFacts: [], completedActions: [], pendingActions: [],
              discardedContext: {}, continuationPrompt: 'continue',
            }),
          },
          finish_reason: 'stop',
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const call = { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  const callB = { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  const messages = [
    { role: 'system', content: 'SYSTEM-MARK' },
    { role: 'assistant', content: '', tool_calls: [call, callB] },
    { role: 'tool', tool_call_id: 'call-a', content: 'RESULT-A' },
    { role: 'tool', tool_call_id: 'call-b', content: 'RESULT-B' },
    { role: 'assistant', content: '<runtime_context_snapshot>PINNED-MARK</runtime_context_snapshot>' },
    { role: 'assistant', content: `COLD ${'c'.repeat(20_000)}` },
    { role: 'user', content: 'ACTIVE-USER' },
    { role: 'assistant', content: `TAIL ${'t'.repeat(30_000)}` },
  ] as never;

  const result = await compactRuntimeMessages({
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'safety', contextWindowTokens: 20_000 },
    messages,
    contextWindowTokens: 20_000,
    tailTokenLimit: 3_000,
    activeUserMessage: messages[6],
  });
  assert.equal(result.compacted, true);
  const output = result.messages as any[];
  assert.equal(output[0].role, 'system');
  assert.match(JSON.stringify(output[0].content), /SYSTEM-MARK/);
  assert.ok(output.some((message) => typeof message.content === 'string' && message.content.includes('ACTIVE-USER')));
  assert.ok(output.some((message) => typeof message.content === 'string' && message.content.includes('PINNED-MARK')));
  const callIds = new Set<string>();
  for (const message of output) {
    for (const item of message.tool_calls || []) callIds.add(item.id);
  }
  const resultIds = new Set(output.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
  assert.deepEqual([...resultIds].sort(), [...callIds].sort(), `orphan tool rows: calls=${[...callIds]} results=${[...resultIds]}`);
  // An empty/empty pair alone would be vacuous: if the group left the request, its
  // original content must be inspectable in the summariser input or the archive index.
  if (callIds.size === 0) {
    const prompt = summaryPrompts.join('\n');
    const archive = JSON.stringify(result.archiveIndex ?? []);
    assert.ok(
      (prompt.includes('RESULT-A') && prompt.includes('RESULT-B')) || /read_file/.test(archive),
      'removed tool group is neither in the summariser input nor in the archive index',
    );
  }
});
