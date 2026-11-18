import type OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { StreamEvent } from './llm_client.js';

/**
 * OpenAI Responses transport.
 *
 * Same SDK as the Chat Completions path (`client.responses`), so this adds no dependency and no
 * second credential model. The translation is deliberately narrow: the runtime's message shape is
 * the source of truth, and anything the Responses API can express better (reasoning summaries,
 * server-side state) is left off — `store: false` keeps the request stateless like every other
 * provider.
 *
 * The adapter is covered by contract tests only: this deployment has no OpenAI key.
 */

export interface ResponsesConfig {
  model: string;
  /** Shared with the other adapters: one image rejection turns images off for this client. */
  state: { supportsImages: boolean };
}

type InputItem = Record<string, unknown>;

function contentParts(content: unknown): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
    else if (record.type === 'image_url') {
      const url = (record.image_url as { url?: unknown } | undefined)?.url;
      if (typeof url === 'string' && url) images.push(url);
    }
  }
  return { text: texts.join('\n'), images };
}

function parseArguments(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) return raw;
  return '{}';
}

/**
 * `ChatCompletionMessageParam[]` -> Responses `input` items.
 *
 * - every `system` message joins into `instructions`;
 * - an assistant turn becomes one message item plus one `function_call` item per tool call;
 * - a `tool` message becomes a `function_call_output` item.
 */
export function translateInput(messages: ChatCompletionMessageParam[]): { instructions?: string; input: InputItem[] } {
  const instructions: string[] = [];
  const input: InputItem[] = [];
  for (const message of messages as unknown as Array<Record<string, unknown>>) {
    const role = String(message.role || '');
    if (role === 'system') {
      const { text } = contentParts(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || ''),
        output: contentParts(message.content).text,
      });
      continue;
    }
    if (role === 'assistant') {
      const { text } = contentParts(message.content);
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
      for (const call of calls) {
        const fn = (call.function || {}) as Record<string, unknown>;
        input.push({
          type: 'function_call',
          call_id: String(call.id || ''),
          name: String(fn.name || ''),
          arguments: parseArguments(fn.arguments),
        });
      }
      continue;
    }
    const { text, images } = contentParts(message.content);
    const parts: InputItem[] = [];
    if (text) parts.push({ type: 'input_text', text });
    for (const url of images) parts.push({ type: 'input_image', image_url: url });
    if (parts.length) input.push({ role: 'user', content: parts });
  }
  return { ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}), input };
}

export function translateTools(tools: ChatCompletionTool[] | undefined): InputItem[] | undefined {
  if (!tools?.length) return undefined;
  return (tools as unknown as Array<Record<string, unknown>>).map((tool) => {
    const fn = (tool.function || {}) as Record<string, unknown>;
    return {
      type: 'function',
      name: String(fn.name || ''),
      ...(typeof fn.description === 'string' && fn.description ? { description: fn.description } : {}),
      parameters: fn.parameters || { type: 'object', properties: {} },
    };
  });
}

interface Usage { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }

function usageOf(response: Record<string, unknown> | undefined): Usage | undefined {
  const usage = response?.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const prompt = Number(usage.input_tokens);
  const completion = Number(usage.output_tokens);
  if (!Number.isFinite(prompt) || prompt <= 0) return undefined;
  const details = usage.input_tokens_details as Record<string, unknown> | undefined;
  const cached = Number(details?.cached_tokens);
  return {
    promptTokens: prompt,
    completionTokens: Number.isFinite(completion) ? completion : 0,
    ...(Number.isFinite(cached) && cached >= 0 ? { cachedPromptTokens: cached } : {}),
  };
}

export async function* streamResponses(
  client: OpenAI,
  config: ResponsesConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[] | undefined,
  abortSignal: AbortSignal | undefined,
  maxTokens: number,
  onRawChunk?: (chunk: unknown) => void,
): AsyncGenerator<StreamEvent> {
  const { instructions, input } = translateInput(messages);
  const toolDefs = translateTools(tools);
  const stream = await (client as unknown as {
    responses: { create(body: unknown, options?: unknown): Promise<AsyncIterable<Record<string, unknown>>> };
  }).responses.create({
    model: config.model,
    input,
    max_output_tokens: maxTokens,
    ...(instructions ? { instructions } : {}),
    ...(toolDefs ? { tools: toolDefs, tool_choice: 'auto' } : {}),
    store: false,
    stream: true,
  }, abortSignal ? { signal: abortSignal } : undefined);

  const toolCalls = new Map<string, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  let usage: Usage | undefined;
  let stopReason = '';

  for await (const event of stream) {
    onRawChunk?.(JSON.parse(JSON.stringify(event)));
    const type = String(event.type || '');
    switch (type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) yield { type: 'content', content: event.delta };
        break;
      case 'response.reasoning_summary_text.delta':
        if (typeof event.delta === 'string' && event.delta) yield { type: 'thinking', content: event.delta };
        break;
      case 'response.output_item.added': {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          toolCalls.set(String(item.item_id || item.id || ''), {
            id: String(item.call_id || item.id || ''),
            type: 'function',
            function: { name: String(item.name || ''), arguments: '' },
          });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const current = toolCalls.get(String(event.item_id || ''));
        if (current && typeof event.delta === 'string') current.function.arguments += event.delta;
        break;
      }
      case 'response.completed':
        usage = usageOf(event.response as Record<string, unknown> | undefined);
        break;
      case 'response.incomplete': {
        const response = event.response as Record<string, unknown> | undefined;
        stopReason = String((response?.incomplete_details as Record<string, unknown> | undefined)?.reason || '');
        break;
      }
      case 'response.failed':
      case 'error': {
        const response = event.response as Record<string, unknown> | undefined;
        const error = (response?.error || event.error || event) as Record<string, unknown>;
        throw new Error(String(error.message || 'OpenAI Responses stream error'));
      }
      default:
        break;
    }
  }

  if (usage) {
    yield {
      type: 'usage',
      promptTokens: usage.promptTokens,
      ...(usage.completionTokens > 0
        ? { completionTokens: usage.completionTokens, totalTokens: usage.promptTokens + usage.completionTokens }
        : {}),
      ...(usage.cachedPromptTokens !== undefined ? { cachedPromptTokens: usage.cachedPromptTokens } : {}),
    };
  }

  if (stopReason === 'max_output_tokens') {
    yield { type: 'truncated', finishReason: 'length' };
  } else if (toolCalls.size) {
    yield { type: 'tool_calls', tool_calls: [...toolCalls.values()] };
  }
  yield { type: 'done' };
}

export async function completeResponsesText(
  client: OpenAI,
  config: ResponsesConfig,
  messages: ChatCompletionMessageParam[],
  maxTokens: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  const { instructions, input } = translateInput(messages);
  const response = await (client as unknown as {
    responses: { create(body: unknown, options?: unknown): Promise<Record<string, unknown>> };
  }).responses.create({
    model: config.model,
    input,
    max_output_tokens: maxTokens,
    ...(instructions ? { instructions } : {}),
    store: false,
  }, abortSignal ? { signal: abortSignal } : undefined);
  if (typeof response.output_text === 'string') return response.output_text;
  const output = Array.isArray(response.output) ? response.output as Array<Record<string, unknown>> : [];
  return output
    .flatMap((item) => (Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []))
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('');
}

export async function testResponsesConnection(client: OpenAI, config: ResponsesConfig): Promise<boolean> {
  const response = await (client as unknown as {
    responses: { create(body: unknown): Promise<Record<string, unknown>> };
  }).responses.create({ model: config.model, input: 'Hello', max_output_tokens: 16, store: false });
  return Array.isArray(response.output) ? response.output.length > 0 : typeof response.output_text === 'string';
}
