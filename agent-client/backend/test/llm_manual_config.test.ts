import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMClient } from '../src/agent/llm_client.js';
import { resolveContextWindow } from '../src/agent/context_window.js';

/**
 * The runtime contract that outlived the provider/model split.
 *
 * Values are materialised into the configuration when a provider or model is edited (from
 * the catalog, from an endpoint probe, or by the operator), so the runtime still receives a
 * decided value — and still refuses to invent one.
 */

async function captureRequest(config: ConstructorParameters<typeof LLMClient>[0]): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let request: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    request = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    assert.equal(await new LLMClient(config).completeText([{ role: 'user', content: 'hello' }]), 'ok');
    return request;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a legacy thinkingLevel is still forwarded verbatim when no format is resolved', async () => {
  const request = await captureRequest({
    baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'anything', thinkingLevel: 'max',
  });
  assert.equal(request.reasoning_effort, 'max');
});

test('a resolved thinking setting wins over the legacy field', async () => {
  // The level a role names ("high") and the value this endpoint accepts ("xhigh") are
  // separate on purpose; the resolved form is what reaches the wire.
  const request = await captureRequest({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    model: 'anything',
    thinkingLevel: 'high',
    thinking: { format: 'openai-effort', wire: 'xhigh' },
  });
  assert.equal(request.reasoning_effort, 'xhigh');
});

test('a context window is never assumed: an unset one still stops the run', () => {
  assert.throws(() => resolveContextWindow({}), /未设置“最大上下文”/);
  assert.equal(resolveContextWindow({ contextWindowTokens: 1_000_000 }).tokens, 1_000_000);
});
