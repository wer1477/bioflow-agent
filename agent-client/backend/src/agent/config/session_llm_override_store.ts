import fs from 'node:fs';
import path from 'node:path';
import { TEAM_ROLE_IDS, type AgentRole } from './agent_config_store.js';
import { findSessionProjectKey } from './conversation_file_store.js';
import { getConversation } from './conversation_service.js';
import { llmOverridesFilePath } from './session_paths.js';

/**
 * Session-scoped model overrides, one file per team root, keyed by role.
 *
 * The settings page owns the *durable* per-user binding (`user_role_bindings`); this file
 * owns the answer to "in this session, this role answers with that provider/model/level".
 * It lives beside the root's `team.json` for the same reason the team does: one session is
 * one directory tree, and deleting the root deletes the override with it.
 *
 * Nothing here validates a provider or a model. Validation belongs to the HTTP route, which
 * resolves the triple through the same per-user catalog the run path uses; a value that
 * survives a hand edit is reported by the resolver instead of being silently replaced.
 */

const SCHEMA_VERSION = 1;
/** A subagent nested under a role session sits two hops below the root; allow headroom. */
const MAX_PARENT_HOPS = 8;

export interface SessionLlmOverride {
  providerId: string;
  modelId?: string;
  thinkingLevel?: string;
  updatedAt: string;
}

export type SessionLlmOverrides = Partial<Record<AgentRole, SessionLlmOverride>>;

interface OverrideDocument {
  schemaVersion: number;
  roles: Record<string, SessionLlmOverride>;
}

/**
 * The team root a conversation belongs to, walking every parent hop.
 *
 * `resolveTeamRoot` in `team_service` stops after one hop because it only ever distinguishes
 * "root" from "role session". Override lookup must also work for a delegated child, whose
 * parent is the role session that created it, so this walks to the top of the tree instead.
 * A conversation with no parent is its own root.
 */
export function resolveSessionRootId(conversationId: string): string | undefined {
  let current = getConversation(conversationId);
  if (!current) return undefined;
  for (let hop = 0; hop < MAX_PARENT_HOPS && current.parentConversationId; hop += 1) {
    const parent = getConversation(current.parentConversationId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

/** The override that names this role in this session, or null when the role follows its binding. */
export function readSessionLlmOverride(conversationId: string | undefined, roleId: string | undefined): SessionLlmOverride | null {
  if (!conversationId || !roleId) return null;
  return readAll(conversationId)[roleId as AgentRole] || null;
}

/** Every role override recorded for the session a conversation belongs to. */
export function readSessionLlmOverrides(conversationId: string | undefined): SessionLlmOverrides {
  return conversationId ? readAll(conversationId) : {};
}

/**
 * Record (or replace) one role's override. Throws when the conversation has no session
 * directory, which only happens for an id that was never persisted.
 */
export function setSessionLlmOverride(
  conversationId: string,
  roleId: AgentRole,
  input: { providerId: string; modelId?: string; thinkingLevel?: string },
): SessionLlmOverride {
  const file = overridePath(conversationId);
  if (!file) throw new Error(`Conversation not found: ${conversationId}`);
  const override: SessionLlmOverride = {
    providerId: input.providerId,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    updatedAt: new Date().toISOString(),
  };
  const current = readAll(conversationId);
  writeDocument(file, { ...current, [roleId]: override });
  return override;
}

/** Drop one role's override; returns whether it existed. */
export function clearSessionLlmOverride(conversationId: string, roleId: AgentRole): boolean {
  const current = readAll(conversationId);
  if (!current[roleId]) return false;
  const file = overridePath(conversationId);
  if (!file) return false;
  const next = { ...current };
  delete next[roleId];
  writeDocument(file, next);
  return true;
}

function readAll(conversationId: string): SessionLlmOverrides {
  const file = overridePath(conversationId);
  if (!file || !fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OverrideDocument>;
    return normalize(raw);
  } catch (err) {
    // A hand-edited file must not take down every run of the session: the override is an
    // optimisation over the durable binding, so a broken one degrades to "no override".
    console.warn(`[session-llm-override] ignoring ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function writeDocument(file: string, roles: SessionLlmOverrides): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const document: OverrideDocument = {
    schemaVersion: SCHEMA_VERSION,
    roles: roles as Record<string, SessionLlmOverride>,
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function normalize(raw: Partial<OverrideDocument>): SessionLlmOverrides {
  if (raw.schemaVersion !== SCHEMA_VERSION) return {};
  const source = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  const next: SessionLlmOverrides = {};
  for (const roleId of TEAM_ROLE_IDS) {
    const entry = (source as Record<string, unknown>)[roleId];
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Partial<SessionLlmOverride>;
    const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
    if (!providerId) continue;
    next[roleId] = {
      providerId,
      ...(typeof value.modelId === 'string' && value.modelId.trim() ? { modelId: value.modelId.trim() } : {}),
      ...(typeof value.thinkingLevel === 'string' && value.thinkingLevel.trim() ? { thinkingLevel: value.thinkingLevel.trim() } : {}),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    };
  }
  return next;
}

function overridePath(conversationId: string): string | null {
  const rootId = resolveSessionRootId(conversationId);
  if (!rootId) return null;
  const projectKey = findSessionProjectKey(rootId);
  return projectKey ? llmOverridesFilePath(projectKey, rootId) : null;
}
