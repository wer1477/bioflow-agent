import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { captureFailedResponseBodies, describeProviderError, getLLMClient, LLMClient, readCachedPromptTokens } from '../src/agent/llm_client.js';

async function* chunks(rows: unknown[]) {
  for (const row of rows) yield row;
}

function clientFor(rows: unknown[]): LLMClient {
  const client = new LLMClient({ baseUrl: 'http://example.invalid', apiKey: 'test', model: 'test-model' });
  (client as any).client = {
    chat: { completions: { create: async () => chunks(rows) } },
  };
  return client;
}

test('LLM clients are pooled by provider and model configuration with an explicit request policy', () => {
  const config = { baseUrl: 'https://example.test/v1', apiKey: 'pool-test-key-a', model: 'first-model' };
  const rotatedCredential = { ...config, apiKey: 'pool-test-key-b' };

  const first = getLLMClient(config);
  assert.strictEqual(getLLMClient({ ...config }), first);
  assert.notStrictEqual(getLLMClient({ ...config, model: 'third-model' }), first);
  assert.notStrictEqual(getLLMClient(rotatedCredential), first);
  // Two providers can share URL/key/model and differ only by a routing header.
  assert.notStrictEqual(getLLMClient({ ...config, headers: { 'x-opencode-session': 'a' } }), first);
  assert.strictEqual(
    getLLMClient({ ...config, headers: { 'x-opencode-session': 'a' } }),
    getLLMClient({ ...config, headers: { 'x-opencode-session': 'a' } }),
  );
  assert.notStrictEqual(
    getLLMClient({ ...config, headers: { 'x-opencode-session': 'a' } }),
    getLLMClient({ ...config, headers: { 'x-opencode-session': 'b' } }),
  );
  assert.equal((first as any).client.timeout, 60_000);
  assert.equal((first as any).client.maxRetries, 2);
});

test('configured provider headers are sent with the completion request', async () => {
  let seenHeaders: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const client = new LLMClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      model: 'test-model',
      headers: { 'x-opencode-session': 'session-1', 'x-extra': 'extra-1' },
    });
    assert.equal(await client.testConnection(), true);
    assert.equal(seenHeaders['x-opencode-session'], 'session-1');
    assert.equal(seenHeaders['x-extra'], 'extra-1');
    assert.equal(seenHeaders.authorization, 'Bearer test-key');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('length-truncated streams discard their entire accumulated tool-call batch', async () => {
  const client = clientFor([
    { choices: [{ delta: { content: 'I will run ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"rm -rf' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]);

  const events = [] as any[];
  for await (const event of client.chatStream([{ role: 'user', content: 'test' }])) events.push(event);

  assert.deepEqual(events, [
    { type: 'content', content: 'I will run ' },
    { type: 'truncated', finishReason: 'length' },
    { type: 'done' },
  ]);
});

test('normally completed streams still return complete tool calls', async () => {
  const client = clientFor([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);

  const events = [] as any[];
  for await (const event of client.chatStream([{ role: 'user', content: 'test' }])) events.push(event);

  assert.deepEqual(events, [
    {
      type: 'tool_calls',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }],
    },
    { type: 'done' },
  ]);
});

test('stream usage is emitted from the final usage chunk', async () => {
  const client = clientFor([
    { choices: [{ delta: { content: 'done' } }] },
    { choices: [], usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } },
  ]);

  const events = [] as any[];
  for await (const event of client.chatStream([{ role: 'user', content: 'test' }])) events.push(event);

  assert.deepEqual(events, [
    { type: 'content', content: 'done' },
    { type: 'usage', promptTokens: 123, completionTokens: 7, totalTokens: 130 },
    { type: 'done' },
  ]);
});

test('streamed reasoning is normalized into thinking events, kept apart from content', async () => {
  const client = clientFor([
    { choices: [{ delta: { reasoning_content: 'weighing ' } }] },
    { choices: [{ delta: { reasoning_content: 'options' } }] },
    // The plain alias some OpenAI-compatible servers use instead.
    { choices: [{ delta: { reasoning: 'plain alias' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);

  const events = [] as any[];
  for await (const event of client.chatStream([{ role: 'user', content: 'test' }])) events.push(event);

  assert.deepEqual(events, [
    { type: 'thinking', content: 'weighing ' },
    { type: 'thinking', content: 'options' },
    { type: 'thinking', content: 'plain alias' },
    { type: 'content', content: 'answer' },
    { type: 'done' },
  ]);
});

test('a response without reasoning produces no thinking event', async () => {
  const client = clientFor([
    { choices: [{ delta: { content: 'answer' } }] },
    { choices: [{ delta: { reasoning_content: '' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);

  const events = [] as any[];
  for await (const event of client.chatStream([{ role: 'user', content: 'test' }])) events.push(event);

  assert.deepEqual(events, [
    { type: 'content', content: 'answer' },
    { type: 'done' },
  ]);
});

test('unsupported stream usage options retry once without usage collection', async () => {
  const client = new LLMClient({ baseUrl: 'http://example.invalid', apiKey: 'test', model: 'test-model' });
  let calls = 0;
  (client as any).client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          calls += 1;
          if (calls === 1) {
            assert.deepEqual(request.stream_options, { include_usage: true });
            const error: any = new Error('stream_options is unsupported');
            error.status = 400;
            throw error;
          }
          assert.equal(request.stream_options, undefined);
          return chunks([{ choices: [{ delta: { content: 'fallback' } }] }]);
        },
      },
    },
  };

  const events = [] as any[];
  for await (const event of client.chatStream([{ role: 'user', content: 'test' }])) events.push(event);

  assert.equal(calls, 2);
  assert.deepEqual(events, [{ type: 'content', content: 'fallback' }, { type: 'done' }]);
});

test('a rejected provider body reaches the run error instead of an opaque status code', async () => {
  const body = JSON.stringify({
    object: 'error',
    message: 'System message must be at the beginning.',
    type: 'BadRequest',
    param: null,
    code: 400,
  });
  const failingFetch = captureFailedResponseBodies(async () => new Response(body, {
    status: 400,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '4096' },
  }));

  const response = await failingFetch('http://example.invalid/v1/chat/completions', {});
  assert.equal(response.status, 400);
  // The SDK must still be able to read the body, so the wrapper cannot consume it.
  assert.equal(await response.text(), body);
  // The passed-through stream is no longer gzip-encoded or 4096 bytes long.
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);

  // This is the error shape openai@6 produces for a body without an `error` envelope.
  const sdkError: any = new Error('400 status code (no body)');
  sdkError.status = response.status;
  sdkError.headers = response.headers;

  const described = describeProviderError(sdkError);
  assert.equal(described.message, '400 status code: System message must be at the beginning.');
  assert.equal((described as any).status, 400);
});

test('successful provider responses pass through the error-body wrapper untouched', async () => {
  const original = new Response('{"choices":[]}', { status: 200 });
  const passingFetch = captureFailedResponseBodies(async () => original);
  assert.strictEqual(await passingFetch('http://example.invalid/v1/chat/completions', {}), original);
});

test('errors without a captured provider body keep their own message and status', () => {
  const error: any = new Error('stream_options is unsupported');
  error.status = 400;
  assert.strictEqual(describeProviderError(error), error);
  assert.equal(describeProviderError('plain failure').message, 'plain failure');
});

test('an image-rejecting provider is retried once text-only and then kept text-only', async () => {
  const requests: any[] = [];
  const client = new LLMClient({ baseUrl: 'http://example.invalid', apiKey: 'test', model: 'text-model' });
  (client as any).client = {
    chat: {
      completions: {
        create: async (body: any) => {
          requests.push(JSON.parse(JSON.stringify(body)));
          if (requests.length === 1) {
            const error = new Error('image input is not supported by this model') as Error & { status: number };
            error.status = 400;
            throw error;
          }
          return chunks([{ choices: [{ delta: { content: 'text answer' }, finish_reason: 'stop' }] }]);
        },
      },
    },
  };

  const messages = [{
    role: 'tool',
    tool_call_id: 'call_1',
    content: [
      { type: 'text', text: 'image attached' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ],
  }] as any;
  const events = [] as any[];
  for await (const event of client.chatStream(messages)) events.push(event);

  assert.equal(requests.length, 2, 'the client should retry exactly once');
  assert.ok(Array.isArray(requests[1].messages[0].content));
  assert.ok(requests[1].messages[0].content.every((part: any) => part.type === 'text'), 'retry must not contain image parts');
  assert.ok(requests[1].messages[0].content.some((part: any) => /image omitted/.test(part.text)), 'retry text should mention the omitted image');
  assert.deepEqual(events, [{ type: 'content', content: 'text answer' }, { type: 'done' }]);
});

/**
 * Prefix-cache counters are provider-specific and optional. A missing counter must stay
 * "unknown" rather than defaulting to zero, otherwise every endpoint that does not report
 * caching would be indistinguishable from a genuine cache miss.
 */
test('a hits-only endpoint reports a miss when the counter is absent', () => {
  // SGLang with `--enable-cache-report` emits the field only when the count is positive,
  // so on a miss the usage block looks exactly like an endpoint that never counts. The
  // declared mode is what separates the two: treating this as "unknown" would drop every
  // miss and report a 100% hit rate on a cold conversation.
  const miss = { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_tokens_details: null };
  assert.equal(readCachedPromptTokens(miss, 'hits-only'), 0);
  assert.equal(readCachedPromptTokens(miss, 'none'), null);
  assert.equal(readCachedPromptTokens(miss, 'full'), null);
  assert.equal(
    readCachedPromptTokens({ ...miss, prompt_tokens_details: { cached_tokens: 6848 } }, 'hits-only'),
    6848,
  );
  // An explicit zero is a measurement; a missing block is not.
  assert.equal(readCachedPromptTokens({ prompt_tokens: 10, prompt_tokens_details: null }, 'full'), null);
  assert.equal(readCachedPromptTokens({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }, 'full'), 0);
});

test('prefix-cache hit counters are normalised, and absent counters stay absent', async () => {
  const eventsFrom = async (usage: unknown) => {
    const client = clientFor([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage },
    ]);
    const events = [] as any[];
    for await (const event of client.chatStream([{ role: 'user', content: 'hi' }])) events.push(event);
    return events.find((event) => event.type === 'usage');
  };

  assert.equal(
    (await eventsFrom({ prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_tokens_details: { cached_tokens: 800 } })).cachedPromptTokens,
    800,
    'OpenAI / vLLM shape',
  );
  assert.equal(
    (await eventsFrom({ prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_cache_hit_tokens: 640 })).cachedPromptTokens,
    640,
    'DeepSeek shape',
  );
  assert.equal(
    (await eventsFrom({ prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 })).cachedPromptTokens,
    undefined,
    'an endpoint without cache counters must not report a hit of zero',
  );
});

test('an explicit-cache provider gets breakpoints on the head, the last tool and the last message', async () => {
  const requests: any[] = [];
  const client = new LLMClient({
    baseUrl: 'http://example.invalid',
    apiKey: 'test',
    model: 'test-model',
    cacheMode: 'explicit',
  });
  (client as any).client = {
    chat: {
      completions: {
        create: async (body: any) => {
          requests.push(JSON.parse(JSON.stringify(body)));
          return chunks([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
        },
      },
    },
  };
  const tools = [
    { type: 'function', function: { name: 'first', description: 'a', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'last', description: 'b', parameters: { type: 'object', properties: {} } } },
  ] as any;
  for await (const _event of client.chatStream(
    [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'HELLO' }],
    tools,
  )) { /* drain */ }

  const body = requests[0];
  const cacheControl = { type: 'ephemeral' };
  // The text is wrapped, never rewritten: a provider that ignores cache_control still sees
  // the same content, and one that supports it caches from the marked block onward.
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'SYSTEM', cache_control: cacheControl }]);
  assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'HELLO', cache_control: cacheControl }]);
  assert.equal(body.tools[0].cache_control, undefined, 'only the last tool carries a breakpoint');
  assert.deepEqual(body.tools[1].cache_control, cacheControl);
});

test('an auto-cache provider keeps the plain wire body', async () => {
  const requests: any[] = [];
  const client = new LLMClient({ baseUrl: 'http://example.invalid', apiKey: 'test', model: 'test-model' });
  (client as any).client = {
    chat: {
      completions: {
        create: async (body: any) => {
          requests.push(JSON.parse(JSON.stringify(body)));
          return chunks([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
        },
      },
    },
  };
  for await (const _event of client.chatStream([{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'HELLO' }])) {
    /* drain */
  }
  assert.equal(requests[0].messages[0].content, 'SYSTEM');
  assert.equal(requests[0].messages[1].content, 'HELLO');
});
