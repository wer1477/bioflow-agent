import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMClient } from '../src/agent/llm_client.js';
import type { LLMConfig } from '../src/agent/types.js';

/**
 * The request body is the only place the level/wire split becomes observable, so each
 * encoding is pinned by intercepting `fetch` and reading what actually left the process.
 */
async function captureBody(config: LLMConfig, options: { ignoreThinking?: boolean } = {}): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await new LLMClient(config).completeText([{ role: 'user', content: 'hi' }], 16, undefined, options);
    return body;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const base: LLMConfig = { baseUrl: 'http://example.invalid/v1', apiKey: 'test', model: 'm' };

test('an openai-effort provider receives the wire spelling, not the level name', async () => {
  const body = await captureBody({
    ...base,
    thinking: { format: 'openai-effort', wire: 'xhigh' },
  });
  assert.equal(body.reasoning_effort, 'xhigh');
  assert.equal('thinking' in body, false);
});

test('an anthropic-budget provider receives thinking.budget_tokens, and a float budget is floored', async () => {
  const body = await captureBody({
    ...base,
    thinking: { format: 'anthropic-budget', wire: 4096.7 },
  });
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.equal('reasoning_effort' in body, false);
});

test('a none provider sends no thinking field at all', async () => {
  const body = await captureBody({ ...base, thinking: { format: 'none', wire: 'high' } });
  assert.equal('reasoning_effort' in body, false);
  assert.equal('thinking' in body, false);
});

test('the legacy thinkingLevel field still forwards verbatim when no format is resolved', async () => {
  const body = await captureBody({ ...base, thinkingLevel: 'max' });
  assert.equal(body.reasoning_effort, 'max');
});

test('a resolved thinking setting wins over the legacy field', async () => {
  const body = await captureBody({
    ...base,
    thinkingLevel: 'max',
    thinking: { format: 'openai-effort', wire: 'low' },
  });
  assert.equal(body.reasoning_effort, 'low');
});

test('ignoreThinking suppresses the fragment for extraction calls', async () => {
  const body = await captureBody({ ...base, thinking: { format: 'openai-effort', wire: 'xhigh' } }, { ignoreThinking: true });
  assert.equal(body.reasoning_effort, 'none', 'ignoreThinking must explicitly disable provider-default reasoning');
  assert.equal('thinking' in body, false);
});

test('an invalid budget degrades to sending nothing rather than an empty object', async () => {
  const body = await captureBody({ ...base, thinking: { format: 'anthropic-budget', wire: 0 } });
  assert.equal('thinking' in body, false);
});

test('an endpoint rejecting reasoning_effort gets one compatibility retry without it', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    bodies.push(body);
    if (bodies.length === 1) {
      return Response.json({ error: { message: 'Unknown parameter: reasoning_effort' } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: 'ok-after-retry' } }] });
  }) as typeof fetch;
  try {
    const client = new LLMClient(base);
    const text = await client.completeText([{ role: 'user', content: 'hi' }], 16, undefined, { ignoreThinking: true });
    assert.equal(text, 'ok-after-retry');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].reasoning_effort, 'none');
    assert.equal('reasoning_effort' in bodies[1], false);
    // The capability result is cached per client: later extraction calls go straight to
    // the compatible body instead of provoking another 400.
    await client.completeText([{ role: 'user', content: 'again' }], 16, undefined, { ignoreThinking: true });
    assert.equal(bodies.length, 3);
    assert.equal('reasoning_effort' in bodies[2], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a 5xx mentioning reasoning_effort is not treated as an unsupported parameter', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body || '{}')));
    return Response.json({ error: { message: 'upstream reasoning_effort failure' } }, { status: 500 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      new LLMClient(base).completeText([{ role: 'user', content: 'hi' }], 16, undefined, { ignoreThinking: true }),
    );
    // The SDK's own bounded retries may repeat the same request; none of them may be the
    // reasoning_off compatibility retry (which would omit the parameter).
    assert.ok(bodies.length >= 1 && bodies.length <= 3);
    assert.ok(bodies.every((body) => body.reasoning_effort === 'none'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
