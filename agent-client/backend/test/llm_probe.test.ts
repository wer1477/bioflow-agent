import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { parseThinkingLevels, probeModels, verifyConnection } from '../src/agent/llm_probe.js';

/** A configurable stand-in for an OpenAI-compatible endpoint. */
async function withEndpoint<T>(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    return await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('probing reports the endpoint models and its context window extension', async () => {
  await withEndpoint((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    json(res, 200, {
      object: 'list',
      data: [
        { id: 'RadixArk/Qwen3.8-Flash-Next-NVFP4', max_model_len: 1_000_000 },
        { id: 'second-model' },
        { noId: true },
      ],
    });
  }, async (baseUrl) => {
    const result = await probeModels({ baseUrl, apiKey: 'test-key' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, [
      { id: 'RadixArk/Qwen3.8-Flash-Next-NVFP4', maxModelLen: 1_000_000 },
      { id: 'second-model' },
    ]);
  });
});

test('probing reads models.dev/OpenCode context windows from the limit object', async () => {
  await withEndpoint((_req, res) => {
    json(res, 200, {
      object: 'list',
      data: [
        { id: 'deepseek-v4.1-flash', limit: { context: 1_000_000, output: 384_000 } },
        { id: 'glm-5.3', limit: { context: '200000' } },
        { id: 'legacy', context_window: 131_072 },
      ],
    });
  }, async (baseUrl) => {
    const result = await probeModels({ baseUrl, apiKey: 'k' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, [
      { id: 'deepseek-v4.1-flash', maxModelLen: 1_000_000 },
      { id: 'glm-5.3', maxModelLen: 200_000 },
      { id: 'legacy', maxModelLen: 131_072 },
    ]);
  });
});

test('a trailing slash on the base URL still hits one route', async () => {
  await withEndpoint((req, res) => {
    assert.equal(req.url, '/v1/models');
    json(res, 200, { data: [{ id: 'm' }] });
  }, async (baseUrl) => {
    assert.equal((await probeModels({ baseUrl: `${baseUrl}/`, apiKey: 'k' })).ok, true);
  });
});

test('provider-required headers travel with both the model probe and the verification call', async () => {
  await withEndpoint((req, res) => {
    const url = req.url || '';
    // The routing header OpenCode's Go gateway requires; without it the call is 400.
    assert.equal(req.headers['x-opencode-session'], 'session-1');
    // The credential is still the bearer token, never replaced by a configured header.
    assert.equal(req.headers.authorization, 'Bearer test-key');
    if (url === '/v1/models') return json(res, 200, { data: [{ id: 'deepseek-v4.1-flash' }] });
    assert.equal(url, '/v1/chat/completions');
    json(res, 200, { model: 'deepseek-v4.1-flash', choices: [{ message: { content: '' } }] });
  }, async (baseUrl) => {
    const headers = { 'x-opencode-session': 'session-1' };
    assert.equal((await probeModels({ baseUrl, apiKey: 'test-key', headers })).ok, true);
    const verified = await verifyConnection({
      baseUrl,
      apiKey: 'test-key',
      headers,
      model: 'deepseek-v4.1-flash',
      thinking: { format: 'openai-effort', wire: 'high' },
    });
    assert.equal(verified.ok, true);
  });
});

test('an unauthenticated endpoint is reported as auth, not as a broken config', async () => {
  await withEndpoint((_req, res) => json(res, 401, { error: { message: 'invalid api key' } }), async (baseUrl) => {
    const result = await probeModels({ baseUrl, apiKey: 'wrong' });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'auth');
    assert.equal(result.error.status, 401);
    assert.match(result.error.message, /invalid api key/);
  });
});

test('an endpoint without /models says so instead of pretending to have no models', async () => {
  await withEndpoint((_req, res) => json(res, 404, { error: 'not found' }), async (baseUrl) => {
    const result = await probeModels({ baseUrl, apiKey: 'k' });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'unsupported');
    assert.match(result.error.message, /手动填写/);
  });
});

test('a non-JSON 200 is unsupported, and an empty model list is not a success', async () => {
  await withEndpoint((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hello</html>');
    }
  }, async (baseUrl) => {
    const html = await probeModels({ baseUrl, apiKey: 'k' });
    assert.equal(html.ok, false);
    assert.equal(html.error.kind, 'unsupported');
  });

  await withEndpoint((_req, res) => json(res, 200, { data: [] }), async (baseUrl) => {
    const empty = await probeModels({ baseUrl, apiKey: 'k' });
    assert.equal(empty.ok, false);
    assert.equal(empty.error.kind, 'unsupported');
  });
});

test('an unreachable endpoint is a network error rather than a thrown exception', async () => {
  const result = await probeModels({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'network');
});

test('thinking levels are read out of the endpoint error, including its parenthetical default', async () => {
  await withEndpoint((req, res, body) => {
    if (req.url === '/v1/chat/completions') {
      const payload = JSON.parse(body);
      assert.equal(payload.reasoning_effort, '__probe__');
      json(res, 400, { error: { message: 'Unexpected reasoning effort __probe__. Supported types are xhigh (default), medium, and low.' } });
      return;
    }
    json(res, 200, { data: [{ id: 'qwen' }] });
  }, async (baseUrl) => {
    const result = await probeModels({ baseUrl, apiKey: 'k' }, { model: 'qwen', probeThinkingLevels: true });
    assert.deepEqual(result.thinkingLevels, ['xhigh', 'medium', 'low']);
    assert.equal(result.thinkingLevelsSource, 'endpoint-error');
  });
});

test('an endpoint that accepts the sentinel yields no levels rather than inventing them', async () => {
  await withEndpoint((req, res) => {
    if (req.url === '/v1/chat/completions') return json(res, 200, { choices: [{ message: { content: '' } }] });
    json(res, 200, { data: [{ id: 'qwen' }] });
  }, async (baseUrl) => {
    const result = await probeModels({ baseUrl, apiKey: 'k' }, { model: 'qwen', probeThinkingLevels: true });
    assert.deepEqual(result.thinkingLevels, []);
    assert.equal(result.thinkingLevelsSource, 'unknown');
  });
});

test('level parsing tolerates the wording variants without over-matching', () => {
  assert.deepEqual(parseThinkingLevels('Supported types are xhigh (default), medium, and low.'), ['xhigh', 'medium', 'low']);
  assert.deepEqual(parseThinkingLevels('reasoning_effort must be one of: low, medium, high'), ['low', 'medium', 'high']);
  assert.deepEqual(parseThinkingLevels('allowed values are minimal and aggressive'), ['minimal', 'aggressive']);
  assert.deepEqual(parseThinkingLevels('model not found'), []);
  assert.deepEqual(parseThinkingLevels(''), []);
});

test('verification reports latency and the echoed model on success', async () => {
  await withEndpoint((_req, res, body) => {
    const payload = JSON.parse(body);
    assert.equal(payload.max_tokens, 1);
    assert.equal(payload.reasoning_effort, 'xhigh');
    json(res, 200, { model: 'qwen', choices: [{ message: { content: '' } }] });
  }, async (baseUrl) => {
    const result = await verifyConnection({ baseUrl, apiKey: 'k', model: 'qwen', thinking: { format: 'openai-effort', wire: 'xhigh' } });
    assert.equal(result.ok, true);
    assert.equal(result.modelEcho, 'qwen');
    assert.ok(result.latencyMs >= 0);
  });
});

test('a rejected thinking encoding is distinguishable from a transport failure', async () => {
  await withEndpoint((_req, res) => json(res, 400, { error: { message: 'Unexpected reasoning effort max. Supported types are low and high.' } }), async (baseUrl) => {
    const result = await verifyConnection({ baseUrl, apiKey: 'k', model: 'qwen', thinking: { format: 'openai-effort', wire: 'max' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'bad-thinking-format');
    assert.equal(result.error.status, 400);
  });
});

test('verification sends a token budget when the provider declares that encoding', async () => {
  await withEndpoint((_req, res, body) => {
    assert.deepEqual(JSON.parse(body).thinking, { type: 'enabled', budget_tokens: 4096 });
    json(res, 200, { choices: [{ message: { content: '' } }] });
  }, async (baseUrl) => {
    const result = await verifyConnection({ baseUrl, apiKey: 'k', model: 'claude', thinking: { format: 'anthropic-budget', wire: 4096 } });
    assert.equal(result.ok, true);
  });
});
