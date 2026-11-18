import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMClient } from '../src/agent/llm_client.js';
import { translateInput, translateTools } from '../src/agent/llm_responses.js';
import type { LLMConfig } from '../src/agent/types.js';

/**
 * Contract tests for the OpenAI Responses transport.
 *
 * There is no OpenAI credential in this deployment, so the shape of the request and the event
 * mapping are pinned here: the fake client is the SDK object the adapter would really call, and
 * every assertion reads the body it was handed.
 */

interface Captured { body: Record<string, unknown> }

function eventsOf(rows: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  return (async function* iterate() {
    for (const row of rows) yield row;
  })();
}

function responsesClient(rows: Record<string, unknown>[], config: Partial<LLMConfig> = {}) {
  const client = new LLMClient({
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'sk-openai-test',
    model: 'gpt-test',
    protocol: 'openai-responses',
    ...config,
  });
  const captured: Captured[] = [];
  (client as unknown as { client: unknown }).client = {
    responses: {
      create: async (body: Record<string, unknown>) => {
        captured.push({ body });
        return body.stream ? eventsOf(rows) : rows[0];
      },
    },
  };
  return { client, captured };
}

async function drain(client: LLMClient, messages: Parameters<LLMClient['chatStream']>[0], tools?: Parameters<LLMClient['chatStream']>[1]) {
  const events = [];
  for await (const event of client.chatStream(messages, tools, undefined, 256)) events.push(event);
  return events;
}

test('OpenAI-shaped messages become Responses input items', () => {
  const translated = translateInput([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'find x' },
    {
      role: 'assistant',
      content: 'looking',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'row 1' },
  ] as never);

  assert.equal(translated.instructions, 'be terse');
  assert.deepEqual(translated.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'find x' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'looking' }] },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'row 1' },
  ]);
});

test('image parts survive as input_image items', () => {
  const translated = translateInput([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ] as never);
  assert.deepEqual(translated.input[0], {
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ],
  });
});

test('function tools keep their JSON schema', () => {
  assert.deepEqual(translateTools([{
    type: 'function',
    function: { name: 'lookup', description: 'find rows', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  }] as never), [{
    type: 'function',
    name: 'lookup',
    description: 'find rows',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  }]);
});

test('streaming maps text, reasoning summaries, tool calls and usage', async () => {
  const { client, captured } = responsesClient([
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.reasoning_summary_text.delta', delta: 'pondering' },
    { type: 'response.output_item.added', item: { type: 'function_call', item_id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x"}' },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 40 } } },
    },
  ]);

  const events = await drain(client, [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] as never);

  const body = captured[0].body;
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 256);
  assert.equal(body.instructions, 'be terse');

  assert.deepEqual(events[0], { type: 'content', content: 'Hello' });
  assert.deepEqual(events[1], { type: 'thinking', content: 'pondering' });
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage',
    promptTokens: 100,
    completionTokens: 12,
    totalTokens: 112,
    cachedPromptTokens: 40,
  });
  assert.deepEqual(events.find((event) => event.type === 'tool_calls')?.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
  ]);
  assert.deepEqual(events.at(-1), { type: 'done' });
});

test('max_output_tokens exhaustion maps onto the truncated event', async () => {
  const { client } = responsesClient([
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ]);
  const events = await drain(client, [{ role: 'user', content: 'long task' }] as never);
  assert.deepEqual(events.at(-2), { type: 'truncated', finishReason: 'length' });
  assert.deepEqual(events.at(-1), { type: 'done' });
});

test('a failed response surfaces its provider message', async () => {
  const { client } = responsesClient([
    { type: 'response.failed', response: { error: { message: 'quota exceeded' } } },
  ]);
  await assert.rejects(drain(client, [{ role: 'user', content: 'hi' }] as never), /quota exceeded/);
});

test('completeText reads output_text from a non-streaming response', async () => {
  const { client, captured } = responsesClient([{ output_text: 'summary', output: [] }]);
  const text = await client.completeText([{ role: 'user', content: 'summarize' }] as never, 64);
  assert.equal(text, 'summary');
  assert.equal(captured[0].body.stream, undefined);
  assert.equal(captured[0].body.max_output_tokens, 64);
});
