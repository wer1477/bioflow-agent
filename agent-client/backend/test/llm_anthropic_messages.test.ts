import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMClient, readCachedPromptTokens } from '../src/agent/llm_client.js';
import {
  anthropicHeaders,
  messagesEndpoint,
  translateMessages,
  translateTools,
} from '../src/agent/llm_anthropic.js';
import type { LLMConfig } from '../src/agent/types.js';

/**
 * Contract tests for the Anthropic Messages transport.
 *
 * There is no Anthropic credential in this deployment (the plan records the gap), so this is
 * the only proof that the translation and the event mapping are right: a stub server returns
 * the same SSE frames the real endpoint sends, and the assertions read the request body the
 * adapter would have put on the wire.
 */

const SSE_TEXT = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"cache_read_input_tokens":80,"cache_creation_input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","thinking":"pondering"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Replaces fetch for the duration of `run`; the client snapshots fetch in its constructor. */
async function withStubbedFetch<T>(
  response: () => Response,
  run: (captured: Captured[]) => Promise<T>,
  config: Partial<LLMConfig> = {},
): Promise<T> {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    captured.push({
      url: String(input),
      headers: Object.fromEntries(Object.entries((init.headers || {}) as Record<string, string>)),
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
    });
    return response();
  }) as typeof fetch;
  try {
    return await run(captured);
  } finally {
    globalThis.fetch = original;
  }
}

function anthropicClient(config: Partial<LLMConfig> = {}): LLMClient {
  return new LLMClient({
    baseUrl: 'https://api.anthropic.test/v1',
    apiKey: 'sk-ant-test',
    model: 'claude-test',
    protocol: 'anthropic-messages',
    ...config,
  });
}

async function drain(client: LLMClient, messages: Parameters<LLMClient['chatStream']>[0], tools?: Parameters<LLMClient['chatStream']>[1]) {
  const events = [];
  for await (const event of client.chatStream(messages, tools, undefined, 512)) events.push(event);
  return events;
}

test('the client resolves the Messages endpoint from either base URL shape', () => {
  assert.equal(messagesEndpoint('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');
  assert.equal(messagesEndpoint('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/messages');
  assert.equal(messagesEndpoint('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
});

test('credentials use x-api-key and a version header, never a bearer token', () => {
  const headers = anthropicHeaders('sk-ant', { authorization: 'Bearer nope', 'anthropic-version': '2099-01-01', 'x-beta': '1' });
  assert.equal(headers['x-api-key'], 'sk-ant');
  assert.equal(headers['anthropic-version'], '2099-01-01');
  assert.equal(headers['x-beta'], '1');
  assert.equal(headers.authorization, undefined);
});

test('OpenAI-shaped messages become Messages-shaped ones', () => {
  const translated = translateMessages([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'find x' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'row 1' },
    { role: 'tool', tool_call_id: 'call_2', content: 'row 2' },
  ] as never);

  assert.deepEqual(translated.system, [{ type: 'text', text: 'be terse' }]);
  assert.equal(translated.messages.length, 3);
  assert.deepEqual(translated.messages[0], { role: 'user', content: [{ type: 'text', text: 'find x' }] });
  assert.deepEqual(translated.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
  });
  // Both tool results answer the same turn, so the protocol wants one user message.
  assert.deepEqual(translated.messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'row 1' }] },
      { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'row 2' }] },
    ],
  });
});

test('data-URL images become base64 image blocks', () => {
  const translated = translateMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ] as never);
  assert.deepEqual(translated.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  });
});

test('tools keep their JSON schema and any cache breakpoint', () => {
  const tools = translateTools([
    {
      type: 'function',
      function: { name: 'lookup', description: 'find rows', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
      cache_control: { type: 'ephemeral' },
    },
  ] as never);
  assert.deepEqual(tools, [{
    name: 'lookup',
    description: 'find rows',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    cache_control: { type: 'ephemeral' },
  }]);
});

test('streaming maps content, thinking, tool calls and the cache-aware usage block', async () => {
  await withStubbedFetch(
    () => new Response(SSE_TEXT, { headers: { 'content-type': 'text/event-stream' } }),
    async (captured) => {
      const events = await drain(anthropicClient(), [{ role: 'user', content: 'hi' }] as never);

      // Request shape.
      assert.equal(captured[0].url, 'https://api.anthropic.test/v1/messages');
      assert.equal(captured[0].body.stream, true);
      assert.equal(captured[0].body.max_tokens, 512);
      assert.equal(captured[0].headers['x-api-key'], 'sk-ant-test');
      assert.equal(captured[0].headers['anthropic-version'], '2023-06-01');

      assert.deepEqual(events[0], { type: 'content', content: 'Hello' });
      assert.deepEqual(events[1], { type: 'thinking', content: 'pondering' });
      const usage = events.find((event) => event.type === 'usage');
      assert.deepEqual(usage, {
        type: 'usage',
        // Anthropic reports the cached prefix separately; the runtime's prompt count is the sum.
        promptTokens: 190,
        completionTokens: 12,
        totalTokens: 202,
        cachedPromptTokens: 80,
      });
      const calls = events.find((event) => event.type === 'tool_calls') as { tool_calls: unknown[] } | undefined;
      assert.deepEqual(calls?.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }]);
      assert.deepEqual(events.at(-1), { type: 'done' });
    },
  );
});

test('a budget below the protocol minimum is dropped and max_tokens stays above the budget', async () => {
  await withStubbedFetch(
    () => new Response(SSE_TEXT, { headers: { 'content-type': 'text/event-stream' } }),
    async (captured) => {
      const low = anthropicClient({ thinking: { format: 'anthropic-budget', wire: 200 }, cacheReport: 'hits-only' });
      await drain(low, [{ role: 'user', content: 'hi' }] as never);
      assert.equal(captured[0].body.thinking, undefined);

      await withStubbedFetch(
        () => new Response(SSE_TEXT, { headers: { 'content-type': 'text/event-stream' } }),
        async (capturedInner) => {
          const high = anthropicClient({ thinking: { format: 'anthropic-budget', wire: 2048 } });
          for await (const _event of high.chatStream([{ role: 'user', content: 'hi' }] as never, undefined, undefined, 1024)) {
            // drain
          }
          assert.deepEqual(capturedInner[0].body.thinking, { type: 'enabled', budget_tokens: 2048 });
          assert.equal(capturedInner[0].body.max_tokens, 2049);
        },
      );
    },
  );
});

test('explicit cache mode marks the system head and the last tool', async () => {
  await withStubbedFetch(
    () => new Response(SSE_TEXT, { headers: { 'content-type': 'text/event-stream' } }),
    async (captured) => {
      const client = anthropicClient({ cacheMode: 'explicit' });
      await drain(
        client,
        [{ role: 'system', content: 'stable prompt' }, { role: 'user', content: 'hi' }] as never,
        [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] as never,
      );
      const body = captured[0].body as { system: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> };
      assert.equal(body.system[0].text, 'stable prompt');
      assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
      assert.deepEqual(body.tools.at(-1)?.cache_control, { type: 'ephemeral' });
    },
  );
});

test('completeText reads the text blocks of a non-streaming response', async () => {
  await withStubbedFetch(
    () => new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'summary' }],
    }), { headers: { 'content-type': 'application/json' } }),
    async (captured) => {
      const text = await anthropicClient().completeText([{ role: 'user', content: 'summarize' }] as never, 64);
      assert.equal(text, 'summary');
      assert.equal(captured[0].body.stream, false);
    },
  );
});

test('an HTTP failure carries the status and the endpoint message', async () => {
  await withStubbedFetch(
    () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' } }), { status: 400 }),
    async () => {
      await assert.rejects(
        drain(anthropicClient(), [{ role: 'user', content: 'hi' }] as never),
        (error: Error & { status?: number }) => {
          assert.equal(error.status, 400);
          assert.match(error.message, /max_tokens: must be greater than 0/);
          return true;
        },
      );
    },
  );
});

test('an absent cache counter is a miss only when the provider declares hits-only', () => {
  assert.equal(readCachedPromptTokens({}, 'hits-only'), 0);
  assert.equal(readCachedPromptTokens({}, 'none'), null);
  assert.equal(readCachedPromptTokens({ cache_read_input_tokens: 7 }, 'none'), 7);
});
