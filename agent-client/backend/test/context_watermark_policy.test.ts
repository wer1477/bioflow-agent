import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import {
  MAX_RUNTIME_COMPACTIONS,
  estimateContextBudget,
  shouldCompactInRun,
} from '../src/agent/context_manager.js';
import { buildResidentTools } from '../src/agent/resident_tools.js';

// `toLlmConfig` interpolates the provider's `${BIOFLOW_LLM_API_KEY_*}` reference and tests
// never load `backend/.env`; the value itself is unused here.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

const SYSTEM_PROMPT = 'You are a test agent.';
const WINDOW = 20_000;

/**
 * Mirror the runtime's own estimate: the system prompt travels inside `messages`, so the
 * runtime passes `systemPrompt: ''` and counts one array. Reproducing it here is what lets
 * a test pick a payload that lands in a chosen band instead of guessing.
 */
function ratioFor(historyChars: number): number {
  return estimateContextBudget({
    systemPrompt: '',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      // Assistant first on purpose: the tail walk-back always takes the last message, so a
      // huge *user* message would become the tail and leave nothing summarisable, while a
      // huge assistant message stays in the cold zone where compaction can act on it.
      { role: 'assistant', content: 'x'.repeat(historyChars) },
      { role: 'user', content: 'continue' },
      { role: 'user', content: 'hi' },
    ],
    userMessage: '',
    contextWindowTokens: WINDOW,
    tools: buildResidentTools(),
  }).ratio;
}

/** Smallest payload whose budget ratio falls inside `[low, high]`. */
function payloadFor(low: number, high: number): number {
  let start = 1_000;
  let end = 400_000;
  let found = -1;
  while (start <= end) {
    const middle = Math.floor((start + end) / 2);
    const ratio = ratioFor(middle);
    if (ratio < low) start = middle + 1;
    else if (ratio > high) end = middle - 1;
    else {
      found = middle;
      break;
    }
  }
  assert.ok(found > 0, `no payload lands in [${low}, ${high}] for a ${WINDOW}-token window`);
  return found;
}

async function runWithPayload(historyChars: number): Promise<{ events: any[]; bodies: any[] }> {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        // The compaction summariser uses a non-streaming completion; without this branch the
        // SDK would try to parse an SSE body as JSON.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'summary',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ schemaVersion: 1, taskState: { userGoal: 'test', currentStatus: 'in_progress' } }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const runtime = new AgentRuntime({
      async connectServers() {
        return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] };
      },
    } as any);
    const events: any[] = [];
    for await (const event of runtime.chat({
      runId: 'watermark-policy',
      llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: WINDOW },
      messages: [
        { role: 'assistant', content: 'x'.repeat(historyChars) },
        { role: 'user', content: 'continue' },
      ],
      userMessage: 'hi',
      systemPrompt: SYSTEM_PROMPT,
      pinnedTail: [],
      mcpServers: [],
    })) {
      events.push(event);
    }
    return { events, bodies };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the soft watermark no longer rewrites the run; only the hard one does', () => {
  const status = (hard: boolean) => ({ hardExceeded: hard });
  assert.equal(shouldCompactInRun(status(false), 0), false, '0.6–0.8 must leave the run untouched');
  assert.equal(shouldCompactInRun(status(true), 0), true);
  assert.equal(shouldCompactInRun(status(true), MAX_RUNTIME_COMPACTIONS - 1), true);
  assert.equal(shouldCompactInRun(status(true), MAX_RUNTIME_COMPACTIONS), false, 'the cap must stop the cycle');
});

test('between 0.6 and 0.8 the run is marked for a checkpoint but not compacted', async () => {
  const { events, bodies } = await runWithPayload(payloadFor(0.64, 0.78));
  const reasons = events.filter((event) => event.type === 'loop_health').map((event) => event.reason);
  assert.ok(reasons.includes('context_watermark_exceeded'), `expected the soft watermark notice, got ${reasons.join(',')}`);
  assert.ok(!reasons.includes('context_compaction_started'), 'the soft watermark must not rewrite messages');
  assert.ok(!reasons.includes('context_compaction_completed'));
  assert.equal(bodies.length, 1, 'only the model turn should reach the provider');
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].tools?.length, buildResidentTools().length, 'tools stay available below the hard watermark');
});

test('at the hard watermark the runtime compacts before the turn and keeps going', async () => {
  const { events, bodies } = await runWithPayload(payloadFor(0.85, 0.95));
  const reasons = events.filter((event) => event.type === 'loop_health').map((event) => event.reason);
  assert.ok(reasons.includes('context_compaction_started'), `expected compaction, got ${reasons.join(',')}`);
  assert.ok(reasons.includes('context_compaction_completed'), 'a successful compaction must be reported as such');
  const started = events.find((event) => event.reason === 'context_compaction_started');
  assert.match(started.detail, /attempt 1\/3/);
  assert.equal(bodies.length, 2, 'one summariser call, then the model turn');
  assert.notEqual(bodies[0].stream, true, 'the summariser is a non-streaming completion');
  assert.equal(bodies[1].stream, true);
});
