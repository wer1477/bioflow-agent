import { v4 as uuidv4 } from 'uuid';
import { createRecord, deleteSessionDirectory, listChildRecords, listRecords, readRecord, updateRecord } from './conversation_file_store.js';
import type { Conversation, Message } from './conversation_types.js';
import type { AgentEvent } from '../types.js';
import { runProjectionsByConversation } from '../transcript_reader.js';

export type { Conversation, Message } from './conversation_types.js';

export function getAllConversations(): Conversation[] {
  return listRecords()
    .map((record) => record.conversation)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
}

export function getConversation(id: string): Conversation | undefined {
  return readRecord(id)?.conversation;
}

/**
 * A session always belongs to a project: `projectPath` is the project
 * directory that becomes the agent's working root.
 */
export function createConversation(data: Partial<Conversation> & { projectPath: string }): Conversation {
  const now = new Date().toISOString();
  const id = uuidv4();
  const conversation: Conversation = {
    id,
    title: data.title || 'New conversation',
    pinned: Boolean(data.pinned),
    skillId: data.skillId || null,
    promptId: data.promptId || null,
    llmProviderId: data.llmProviderId || null,
    projectPath: data.projectPath,
    createdAt: now,
    updatedAt: now,
    ...(data.parentConversationId ? { parentConversationId: data.parentConversationId } : {}),
    ...(typeof data.subagentDepth === 'number' ? { subagentDepth: data.subagentDepth } : {}),
    ...(data.subagentDescription ? { subagentDescription: data.subagentDescription } : {}),
    ...(data.agentId ? { agentId: data.agentId } : {}),
    ...(data.roleId ? { roleId: data.roleId } : {}),
  };
  createRecord(data.projectPath, conversation);
  return conversation;
}

/**
 * Which agent answers a run on this conversation.
 *
 * A team role session always answers as its role. A delegated child answers as the role
 * that created it — recorded on the conversation, so continuing the child later keeps the
 * identity instead of silently turning it into whoever the caller selected. Everything else
 * (a plain session, the team root) answers as the caller asks.
 */
export function resolveAnsweringAgentId(
  conversation: Pick<Conversation, 'roleId' | 'agentId'>,
  requestedAgentId?: string | null,
): string | undefined {
  const resolved = conversation.roleId || conversation.agentId || requestedAgentId;
  return resolved || undefined;
}

/**
 * Direct children of one conversation, in creation order.
 *
 * Both role sessions and delegated subagents are children; callers that mean one of the
 * two filter on `roleId`.
 */
export function listChildConversations(parentConversationId: string): Conversation[] {
  return listChildRecords(parentConversationId).map((record) => record.conversation);
}

/**
 * Every conversation below one conversation, breadth-first.
 *
 * Teams nest: a root owns role sessions, and either level can own delegated children.
 * Session statistics and the trajectory map both need the whole subtree, and walking
 * `listChildConversations` keeps that definition in one place instead of every caller
 * re-inventing "root plus roles plus, sometimes, subagents".
 */
export function listDescendantConversations(
  conversationId: string,
  options: { maxDepth?: number } = {},
): Conversation[] {
  const maxDepth = Math.min(Math.max(Math.trunc(options.maxDepth ?? 8), 1), 16);
  const found: Conversation[] = [];
  const seen = new Set<string>([conversationId]);
  let level = [conversationId];
  for (let depth = 0; depth < maxDepth && level.length; depth += 1) {
    const next: string[] = [];
    for (const parentId of level) {
      for (const child of listChildConversations(parentId)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push(child);
        next.push(child.id);
      }
    }
    level = next;
  }
  return found;
}

export function updateConversation(id: string, data: Partial<Conversation>): Conversation | undefined {
  return updateRecord(
    id,
    (record) => {
      const next = { ...record.conversation, ...pickConversationUpdate(data), updatedAt: new Date().toISOString() };
      record.conversation = next;
      return next;
    },
    (record) => ({ type: 'patch', conversation: record.conversation, collections: {} }),
  );
}

/**
 * Deletes one session's state directory under `.sessions/<projectKey>/<id>`.
 * The project directory itself is never touched.
 *
 * Children are deleted with their parent. For delegated subagents that is because they are
 * reachable only through the parent's header; for role sessions it is because a team is one
 * unit — deleting the root must not leave four orphaned role sessions behind.
 */
export function deleteConversation(id: string): boolean {
  if (!getConversation(id)) return false;
  for (const child of listChildConversations(id)) {
    deleteConversation(child.id);
  }
  return deleteSessionDirectory(id);
}

/**
 * Message count without materialising the messages.
 *
 * `getMessages` replays the transcript to attach each run's events; a header badge
 * that refreshes every couple of seconds must not pay that cost.
 */
export function getMessageCount(conversationId: string): number {
  return readRecord(conversationId)?.messages.length || 0;
}

export function getMessages(conversationId: string): Message[] {
  const messages = (readRecord(conversationId)?.messages || [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Run events are stored once, in the transcript. Attaching them here keeps the
  // message shape every consumer already reads — context assembly derives loaded
  // tools and skills from these events, and the Web renders the trace from them —
  // without a second stored copy. The run's system prompt comes from the same read:
  // it is not persisted either.
  const projections = runProjectionsByConversation(conversationId);
  if (projections.size === 0) return messages;
  return messages.map((message) => {
    const run = message.toolCalls?.run;
    if (!run?.runId) return message;
    // The rebuilt events mirror the runtime event shape field for field — the parity
    // test asserts that against the stream the runtime actually produced — but they
    // arrive as plain records rather than the discriminated union, so the boundary
    // restores the type the consumers already narrow on.
    const projection = projections.get(run.runId);
    const events = (projection?.events ?? []) as AgentEvent[];
    return {
      ...message,
      toolCalls: {
        ...message.toolCalls,
        run: { ...run, events, ...(projection?.systemPrompt ? { systemPrompt: projection.systemPrompt } : {}) },
      },
    };
  });
}

export function createMessage(data: Omit<Message, 'id' | 'createdAt'>): Message {
  const message: Message = { id: uuidv4(), ...data, createdAt: new Date().toISOString() };
  const result = updateRecord(
    data.conversationId,
    (record) => {
      record.messages.push(message);
      touch(record);
      return message;
    },
    (record) => ({
      type: 'patch',
      conversation: record.conversation,
      collections: { messages: { upserts: [message], deletes: [] } },
    }),
  );
  if (!result) throw new Error('Conversation not found.');
  return result;
}

export function updateMessage(
  conversationId: string,
  id: string,
  data: Partial<Pick<Message, 'content' | 'toolCalls'>>,
): Message | undefined {
  return updateRecord(
    conversationId,
    (record) => {
      const index = record.messages.findIndex((message) => String(message.id) === id);
      if (index < 0) return undefined;
      const message = { ...record.messages[index], ...data };
      record.messages[index] = message;
      touch(record);
      return message;
    },
    (record) => {
      const message = record.messages.find((item) => String(item.id) === id);
      return {
        type: 'patch',
        ...(message ? { conversation: record.conversation } : {}),
        collections: message ? { messages: { upserts: [message], deletes: [] } } : {},
      };
    },
  );
}

export function getMessage(conversationId: string, id: string): Message | undefined {
  return readRecord(conversationId)?.messages.find((message) => message.id === id);
}

function touch(record: { conversation: Conversation }): void {
  record.conversation.updatedAt = new Date().toISOString();
}

function pickConversationUpdate(data: Partial<Conversation>): Partial<Conversation> {
  const { title, pinned, skillId, promptId, llmProviderId } = data;
  return {
    ...(title === undefined ? {} : { title }),
    ...(pinned === undefined ? {} : { pinned }),
    ...(skillId === undefined ? {} : { skillId }),
    ...(promptId === undefined ? {} : { promptId }),
    ...(llmProviderId === undefined ? {} : { llmProviderId }),
  };
}
