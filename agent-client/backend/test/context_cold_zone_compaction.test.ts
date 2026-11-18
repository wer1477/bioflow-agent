import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { compactRuntimeMessages } from '../src/agent/context_manager.js';

async function startProvider(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 1,
              taskState: { userGoal: 'finish the run', currentStatus: 'in_progress' },
              stableFacts: [{ fact: 'the aligner finished', source: 'tool', confidence: 'high' }],
            }),
          },
          finish_reason: 'stop',
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function longRun(): Array<Record<string, unknown>> {
  return [
    // Oldest group, and an orphan result: its recency score is the lowest in the zone, so the
    // threshold sends it to the archive rather than to the summariser.
    { role: 'tool', tool_call_id: 'old', content: `OLD_RESULT ${'o'.repeat(2_000)}` },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: 'assistant',
      content: `STEP ${index} ${'s'.repeat(2_000)}`,
    })),
  ];
}

test('compaction archives low-value groups and names them instead of dropping them silently', async (t) => {
  const { server, baseUrl } = await startProvider();
  t.after(() => server.close());

  const messages = longRun();
  const outcome = await compactRuntimeMessages({
    llm: { baseUrl, apiKey: 'unused', model: `cold-zone-${Date.now()}`, contextWindowTokens: 20_000 } as never,
    messages: messages as never[],
    contextWindowTokens: 20_000,
  });

  assert.equal(outcome.compacted, true);
  assert.equal(outcome.degraded, undefined);
  assert.ok(outcome.archiveIndex?.length, 'the archived group must leave an index line');

  const checkpoint = String((outcome.messages[0] as { content?: unknown }).content);
  assert.match(checkpoint, /<runtime_context_checkpoint>/);
  assert.match(checkpoint, /Archived/);
  assert.match(checkpoint, /\[#0\]/, 'the index names the archived group by position');
  assert.match(checkpoint, /the aligner finished/, 'the summary is rendered into the message');

  const serialized = JSON.stringify(outcome.messages);
  assert.equal(serialized.includes('OLD_RESULT'), false, 'archived content must leave the context');
  assert.ok(outcome.messages.length < messages.length);
});

test('a cold zone that fits the verbatim quota costs no summariser call', async (t) => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  // One short user prompt: it is kept whole, so nothing is left to paraphrase. The assistant
  // message is larger than the tail budget, so it becomes the tail and the prompt is the zone.
  const messages = [
    { role: 'user', content: 'remember: use WT only' },
    { role: 'assistant', content: `WORK ${'w'.repeat(120_000)}` },
  ];
  const outcome = await compactRuntimeMessages({
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'no-call', contextWindowTokens: 100_000 } as never,
    messages: messages as never[],
    contextWindowTokens: 100_000,
  });

  assert.equal(calls, 0, 'a zone that is entirely kept or archived must not call the summariser');
  assert.equal(outcome.compacted, true);
  const serialized = JSON.stringify(outcome.messages);
  assert.match(serialized, /use WT only/, 'the user prompt survives verbatim');
});
