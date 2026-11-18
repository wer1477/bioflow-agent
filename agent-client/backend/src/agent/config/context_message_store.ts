import { v4 as uuidv4 } from 'uuid';
import { readRecord, updateRecord } from './conversation_file_store.js';
import type { ContextMessage, ContextToolCall } from './conversation_types.js';

/**
 * Append-only model transcript.
 *
 * `messages` is the chat record the Web renders (one aggregated assistant bubble per run,
 * plus run metadata). This collection is exactly what the model saw: one row per model
 * step and one row per tool result. Assembly replays these rows and compaction is a
 * projection over them; the rows themselves are never rewritten.
 *
 * Kept apart from `messages` because the two have different granularity — a single run can
 * be 20 assistant turns and 40 tool results but still be one chat bubble.
 */
export interface AppendContextMessageInput {
  runId?: string | null;
  role: ContextMessage['role'];
  content: unknown;
  toolCalls?: ContextToolCall[] | null;
  toolCallId?: string | null;
  toolName?: string | null;
}

/** All model-visible rows of a conversation, ordered by their monotonic `seq`. */
export function listContextMessages(
  conversationId: string,
  filter: { runId?: string | null } = {},
): ContextMessage[] {
  const record = readRecord(conversationId);
  if (!record) return [];
  const messages = record.contextMessages.slice().sort((a, b) => a.seq - b.seq);
  if (filter.runId === undefined) return messages;
  return messages.filter((message) => message.runId === filter.runId);
}

/** Append one row; the sequence number is assigned inside the record update. */
export function appendContextMessage(
  conversationId: string,
  input: AppendContextMessageInput,
): ContextMessage | null {
  const message: ContextMessage = {
    id: uuidv4(),
    conversationId,
    runId: input.runId ?? null,
    seq: 0,
    role: input.role,
    content: input.content,
    toolCalls: input.toolCalls ?? null,
    toolCallId: input.toolCallId ?? null,
    toolName: input.toolName ?? null,
    createdAt: new Date().toISOString(),
  };
  return updateRecord(
    conversationId,
    (record) => {
      message.seq = record.contextMessages.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
      record.contextMessages.push(message);
      return message;
    },
    () => ({ type: 'patch', collections: { contextMessages: { upserts: [message], deletes: [] } } }),
  ) ?? null;
}

/**
 * Seed the model transcript from a chat record written before this collection existed.
 *
 * Legacy sessions only have `messages` (user + assistant text). Copying them once — in
 * order, with `runId: null` — gives the accumulation a starting point instead of
 * silently discarding the history the user can still see in the UI.
 */
export function seedContextMessages(
  conversationId: string,
  messages: Array<{ role: ContextMessage['role']; content: string }>,
): number {
  let seeded = 0;
  for (const message of messages) {
    if (message.role === 'tool') continue;
    appendContextMessage(conversationId, { role: message.role, content: message.content, runId: null });
    seeded += 1;
  }
  return seeded;
}

/**
 * Fill in tool results a run never produced (cancellation, crash, abort mid-batch).
 *
 * A transcript that ends on an unanswered `tool_calls` is not a valid provider request:
 * every call id needs one `tool` row before the next assistant/user row. The repair
 * appends the missing rows at the end of the run's slice, which stays after its assistant
 * row because only the run-start user row precedes them.
 */
export function repairRunToolPairs(conversationId: string, runId: string | null): number {
  const messages = listContextMessages(conversationId, { runId });
  const answered = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.toolCallId)
      .map((message) => message.toolCallId as string),
  );
  let repaired = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      if (answered.has(call.id)) continue;
      appendContextMessage(conversationId, {
        runId,
        role: 'tool',
        content: JSON.stringify({ ok: false, error: 'the run ended before this tool returned a result' }),
        toolCallId: call.id,
        toolName: call.name,
      });
      answered.add(call.id);
      repaired += 1;
    }
  }
  return repaired;
}
