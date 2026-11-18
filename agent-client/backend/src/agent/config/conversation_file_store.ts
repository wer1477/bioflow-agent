import fs from 'node:fs';
import path from 'node:path';
import type { ContextCheckpoint } from './context_store.js';
import type { AgentRun, AgentRunStep } from './run_store.js';
import type { ContextMessage, Conversation, Message } from './conversation_types.js';
import { sessionsRoot } from '../../paths.js';
import { isPathSegment } from './path_segments.js';
import {
  historyFilePath,
  legacyHistoryFilePath,
  projectKeyForPath,
  sessionDirectory,
  sessionFilePath,
} from './session_paths.js';

const HISTORY_FILE = 'history.jsonl';
const LEGACY_FILE = 'history.json';
const COLLECTIONS = ['messages', 'runs', 'runSteps', 'checkpoints', 'contextMessages'] as const;
const HISTORY_COMPACTION_BYTES = 1 * 1024 * 1024;
const HISTORY_COMPACTION_PATCHES = 500;
const HISTORY_COMPACTION_MIN_PATCHES_AFTER_SNAPSHOT = 100;
const SESSION_FORMAT_VERSION = 3;
// Agent runs frequently update one conversation. Keep reconstructed records in
// process memory so those updates append a patch instead of replaying every
// history.jsonl file on each persistence tick.
const recordCache = new Map<string, ConversationFileRecord>();
const historyPatchesSinceCompaction = new Map<string, number>();
// conversationId -> projectKey. Without it every persistence tick would have to
// readdir the whole session store to locate the session directory.
const sessionKeyCache = new Map<string, string>();

// parentConversationId -> child ids. Rebuilt by `listRecords()` and invalidated by any
// mutation that can change parentage. Without it, the Web's subagent poll would walk
// every session on disk every two seconds just to find one parent's children.
const childrenByParent = new Map<string, string[]>();
let childrenIndexReady = false;

export interface ConversationFileRecord {
  formatVersion: 2 | 3;
  conversation: Conversation;
  messages: Message[];
  runs: AgentRun[];
  runSteps: AgentRunStep[];
  checkpoints: ContextCheckpoint[];
  /** Append-only model transcript; see `context_message_store.ts`. */
  contextMessages: ContextMessage[];
}

type Collection = typeof COLLECTIONS[number];
type CollectionChange<T> = { upserts: T[]; deletes: string[] };
type CollectionPatches = {
  [Name in Collection]: CollectionChange<ConversationFileRecord[Name][number]>;
};
export type ConversationFilePatch = {
  type: 'patch';
  conversation?: Conversation;
  collections: Partial<CollectionPatches>;
};
type HistoryEvent = { type: 'snapshot'; record: ConversationFileRecord } | ConversationFilePatch;

export function getHistoryPath(conversationId: string): string {
  return historyFilePath(requireSessionKey(conversationId), conversationId);
}

/** Directory name of the session, or null when the id is unknown or malformed. */
export function findSessionProjectKey(conversationId: string): string | null {
  return resolveSessionKey(conversationId);
}

/**
 * Sessions are keyed by project, so locating one session means scanning the
 * project keys. The result is cached; a malformed id is "not found" rather than
 * an exception, so HTTP handlers answer 404 instead of 500.
 */
function resolveSessionKey(conversationId: string): string | null {
  const id = String(conversationId || '').trim();
  if (!isPathSegment(id)) return null;
  const cached = sessionKeyCache.get(id);
  if (cached) return cached;
  if (!fs.existsSync(sessionsRoot())) return null;
  for (const entry of fs.readdirSync(sessionsRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !isPathSegment(entry.name)) continue;
    if (fs.existsSync(sessionFilePath(entry.name, id))) {
      sessionKeyCache.set(id, entry.name);
      return entry.name;
    }
  }
  return null;
}

function requireSessionKey(conversationId: string): string {
  const key = resolveSessionKey(conversationId);
  if (!key) throw new Error(`Unknown conversation ${conversationId}.`);
  return key;
}

/** Walks `.sessions/<projectKey>/<sessionId>/session.json` (two levels). */
export function listRecords(): ConversationFileRecord[] {
  const records: ConversationFileRecord[] = [];
  const knownIds = new Set<string>();
  if (!fs.existsSync(sessionsRoot())) {
    rebuildChildrenIndex(records);
    return records;
  }
  for (const projectEntry of fs.readdirSync(sessionsRoot(), { withFileTypes: true })) {
    if (!projectEntry.isDirectory() || !isPathSegment(projectEntry.name)) continue;
    const projectDirectory = path.join(sessionsRoot(), projectEntry.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(projectDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory() || !isPathSegment(sessionEntry.name)) continue;
      knownIds.add(sessionEntry.name);
      sessionKeyCache.set(sessionEntry.name, projectEntry.name);
      const record = readRecord(sessionEntry.name);
      if (record) records.push(record);
    }
  }
  for (const id of recordCache.keys()) {
    if (knownIds.has(id)) continue;
    recordCache.delete(id);
    historyPatchesSinceCompaction.delete(id);
    sessionKeyCache.delete(id);
  }
  rebuildChildrenIndex(records);
  return records;
}

/**
 * Direct children of one conversation, in creation order.
 *
 * The index is built once from the session store and invalidated by creation/deletion,
 * so the two-second `/subagents` poll costs one lookup instead of a full disk walk.
 */
export function listChildRecords(parentConversationId: string): ConversationFileRecord[] {
  if (!childrenIndexReady) listRecords();
  const ids = childrenByParent.get(parentConversationId) ?? [];
  const records: ConversationFileRecord[] = [];
  for (const id of ids) {
    const record = recordCache.get(id);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.conversation.createdAt.localeCompare(b.conversation.createdAt));
}

function rebuildChildrenIndex(records: readonly ConversationFileRecord[]): void {
  childrenByParent.clear();
  for (const record of records) {
    const parent = record.conversation.parentConversationId;
    if (!parent) continue;
    const list = childrenByParent.get(parent);
    if (list) list.push(record.conversation.id);
    else childrenByParent.set(parent, [record.conversation.id]);
  }
  childrenIndexReady = true;
}

function invalidateChildrenIndex(): void {
  childrenIndexReady = false;
  childrenByParent.clear();
}

export function readRecord(conversationId: string): ConversationFileRecord | null {
  const projectKeyValue = resolveSessionKey(conversationId);
  if (!projectKeyValue) {
    recordCache.delete(conversationId);
    historyPatchesSinceCompaction.delete(conversationId);
    return null;
  }
  const sessionPath = sessionFilePath(projectKeyValue, conversationId);
  try {
    // Legacy migration runs inside the guard: a malformed record must not throw
    // out of the store and surface as HTTP 500.
    migrateLegacyRecord(projectKeyValue, conversationId);
    if (!fs.existsSync(sessionPath)) {
      recordCache.delete(conversationId);
      historyPatchesSinceCompaction.delete(conversationId);
      return null;
    }
    const cached = recordCache.get(conversationId);
    if (cached) return cached;
    const session = parseSession(fs.readFileSync(sessionPath, 'utf8'), conversationId);
    if (!session) return null;
    const record: ConversationFileRecord = {
      formatVersion: SESSION_FORMAT_VERSION,
      conversation: session.conversation,
      messages: [],
      runs: [],
      runSteps: [],
      checkpoints: [],
      contextMessages: [],
    };
    let patchesSinceSnapshot = 0;
    const historyPath = historyFilePath(projectKeyValue, conversationId);
    if (fs.existsSync(historyPath)) {
      for (const line of fs.readFileSync(historyPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as HistoryEvent;
          applyEvent(record, event);
          patchesSinceSnapshot = event.type === 'snapshot' ? 0 : patchesSinceSnapshot + 1;
        } catch { break; } // torn tail: retain valid prefix
      }
    }
    recordCache.set(conversationId, record);
    historyPatchesSinceCompaction.set(conversationId, patchesSinceSnapshot);
    return record;
  } catch (error) {
    console.warn(`Ignoring unreadable conversation session ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Creates the session directory under the project's key and writes the record. */
export function createRecord(projectPath: string, conversation: Conversation): ConversationFileRecord {
  const projectKeyValue = projectKeyForPath(projectPath);
  const record: ConversationFileRecord = {
    formatVersion: SESSION_FORMAT_VERSION,
    conversation: { ...conversation, projectPath },
    messages: [],
    runs: [],
    runSteps: [],
    checkpoints: [],
    contextMessages: [],
  };
  fs.mkdirSync(sessionDirectory(projectKeyValue, conversation.id), { recursive: true });
  sessionKeyCache.set(conversation.id, projectKeyValue);
  writeSessionFile(projectKeyValue, record.conversation);
  appendEvent(conversation.id, { type: 'snapshot', record });
  historyPatchesSinceCompaction.set(conversation.id, 0);
  recordCache.set(conversation.id, record);
  invalidateChildrenIndex();
  return record;
}

export function updateRecord<T>(
  conversationId: string,
  mutate: (record: ConversationFileRecord) => T,
  createPatch: (record: ConversationFileRecord) => ConversationFilePatch,
): T | undefined {
  const record = readRecord(conversationId);
  if (!record) return undefined;
  const result = mutate(record);
  const event = createPatch(record);
  if (event.conversation || Object.keys(event.collections).length) appendEvent(conversationId, event);
  if (event.conversation) writeSessionFile(requireSessionKey(conversationId), record.conversation);
  return result;
}

export function writeRecord(conversationId: string, record: ConversationFileRecord): void {
  const projectKeyValue = requireSessionKey(conversationId);
  fs.mkdirSync(sessionDirectory(projectKeyValue, conversationId), { recursive: true });
  writeSessionFile(projectKeyValue, record.conversation);
  appendEvent(conversationId, { type: 'snapshot', record });
  historyPatchesSinceCompaction.set(conversationId, 0);
  invalidateChildrenIndex();
}

/** Removes one session's whole state directory (never a project directory). */
export function deleteSessionDirectory(conversationId: string): boolean {
  const projectKeyValue = resolveSessionKey(conversationId);
  if (!projectKeyValue) return false;
  const target = path.resolve(sessionDirectory(projectKeyValue, conversationId));
  const root = path.resolve(sessionsRoot());
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Refusing to delete a session directory outside the session store.');
  }
  fs.rmSync(target, { recursive: true, force: true });
  // 最后一个会话被删除后，不要留下空的项目 key 目录。
  try {
    fs.rmdirSync(path.dirname(target));
  } catch {
    // 该项目还有别的会话，或目录已不存在。
  }
  sessionKeyCache.delete(conversationId);
  recordCache.delete(conversationId);
  historyPatchesSinceCompaction.delete(conversationId);
  invalidateChildrenIndex();
  return true;
}

/**
 * Moves a session between project keys and rewrites its `projectPath`, both in
 * `session.json` and as a fresh history patch — without the patch, replaying
 * history would restore the previous path.
 */
export function moveSessionToProject(conversationId: string, projectPath: string): boolean {
  const fromKey = resolveSessionKey(conversationId);
  if (!fromKey) return false;
  const toKey = projectKeyForPath(projectPath);
  if (fromKey === toKey) return false;
  const from = sessionDirectory(fromKey, conversationId);
  const to = sessionDirectory(toKey, conversationId);
  if (fs.existsSync(to)) throw new Error(`Conversation ${conversationId} already exists in the target project.`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  sessionKeyCache.set(conversationId, toKey);
  invalidateChildrenIndex();

  const record = recordCache.get(conversationId);
  const conversation = record
    ? { ...record.conversation, projectPath }
    : parseSession(fs.readFileSync(sessionFilePath(toKey, conversationId), 'utf8'), conversationId)?.conversation;
  if (conversation) {
    const updated = { ...conversation, projectPath };
    if (record) record.conversation = updated;
    writeSessionFile(toKey, updated);
    appendEvent(conversationId, { type: 'patch', conversation: updated, collections: {} });
  }
  return true;
}

/** Replace an accumulated patch log with one atomic current-state snapshot. */
export function compactRecord(conversationId: string): void {
  const record = readRecord(conversationId);
  if (!record) return;
  const file = getHistoryPath(conversationId);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ type: 'snapshot', record } satisfies HistoryEvent)}\n`, 'utf8');
  fs.renameSync(temp, file);
  historyPatchesSinceCompaction.set(conversationId, 0);
}

function applyEvent(record: ConversationFileRecord, event: HistoryEvent): void {
  if (event.type === 'snapshot') {
    Object.assign(record, structuredClone(event.record));
    // Snapshots written before the model transcript existed have no such collection.
    if (!Array.isArray(record.contextMessages)) record.contextMessages = [];
    return;
  }
  if (event.conversation) record.conversation = event.conversation;
  applyCollectionPatch(record.messages, event.collections.messages);
  applyCollectionPatch(record.runs, event.collections.runs);
  applyCollectionPatch(record.runSteps, event.collections.runSteps);
  applyCollectionPatch(record.checkpoints, event.collections.checkpoints);
  applyCollectionPatch(record.contextMessages, event.collections.contextMessages);
}

function applyCollectionPatch<T extends { id: string }>(items: T[], patch: CollectionChange<T> | undefined): void {
  if (!patch) return;
  const index = new Map(items.map((item) => [item.id, item]));
  patch.deletes.forEach((id) => index.delete(id));
  patch.upserts.forEach((item) => index.set(item.id, item));
  items.splice(0, items.length, ...index.values());
}

function parseSession(text: string, expectedId: string): { conversation: Conversation } | null {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed) || !isConversation(parsed.conversation)) return null;
  if (parsed.conversation.id !== expectedId) {
    console.warn(`Ignoring conversation session whose id "${parsed.conversation.id}" does not match its directory "${expectedId}".`);
    return null;
  }
  return { conversation: { ...parsed.conversation, projectPath: parsed.conversation.projectPath ?? null } };
}

function isConversation(value: unknown): value is Conversation {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.pinned === 'boolean'
    && (typeof value.skillId === 'string' || value.skillId === null)
    && (typeof value.promptId === 'string' || value.promptId === null)
    && (typeof value.llmProviderId === 'string' || value.llmProviderId === null)
    && (typeof value.projectPath === 'string' || value.projectPath === null || value.projectPath === undefined)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendEvent(conversationId: string, event: HistoryEvent): void {
  const file = getHistoryPath(conversationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  if (event.type === 'snapshot') {
    historyPatchesSinceCompaction.set(conversationId, 0);
    return;
  }

  const patches = (historyPatchesSinceCompaction.get(conversationId) || 0) + 1;
  historyPatchesSinceCompaction.set(conversationId, patches);
  const size = fs.statSync(file).size;
  if (patches >= HISTORY_COMPACTION_PATCHES || (size >= HISTORY_COMPACTION_BYTES && patches >= HISTORY_COMPACTION_MIN_PATCHES_AFTER_SNAPSHOT)) {
    compactRecord(conversationId);
  }
}

function migrateLegacyRecord(projectKeyValue: string, conversationId: string): void {
  const sessionPath = sessionFilePath(projectKeyValue, conversationId);
  const legacy = legacyHistoryFilePath(projectKeyValue, conversationId);
  if (fs.existsSync(sessionPath) || !fs.existsSync(legacy)) return;
  try {
    const old = JSON.parse(fs.readFileSync(legacy, 'utf8')) as ConversationFileRecord;
    if (!old.conversation) return;
    const conversation: Conversation = { ...old.conversation, id: conversationId, projectPath: old.conversation.projectPath ?? null };
    const record: ConversationFileRecord = {
      formatVersion: SESSION_FORMAT_VERSION,
      conversation,
      messages: [],
      runs: [],
      runSteps: [],
      checkpoints: [],
      contextMessages: [],
    };
    writeSessionFile(projectKeyValue, conversation);
    appendEvent(conversationId, { type: 'snapshot', record });
    fs.renameSync(legacy, `${legacy}.migrated`);
  } catch (error) {
    console.warn(`Unable to migrate legacy history ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeSessionFile(projectKeyValue: string, conversation: Conversation): void {
  writeJson(sessionFilePath(projectKeyValue, conversation.id), {
    formatVersion: SESSION_FORMAT_VERSION,
    conversation,
  });
}

function writeJson(filePath: string, data: unknown): void {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}
