import fs from 'node:fs';
import path from 'node:path';
import {
  createConversation,
  getConversation,
  getMessageCount,
  listChildConversations,
} from '../config/conversation_service.js';
import { findSessionProjectKey } from '../config/conversation_file_store.js';
import { teamStateFilePath } from '../config/session_paths.js';
import {
  readSessionLlmOverrides,
  type SessionLlmOverride,
} from '../config/session_llm_override_store.js';
import { resolveLLMTargetForCurrentUser, resolveRoleBinding } from '../../auth/user_llm_store.js';
import {
  TEAM_ROLE_IDS,
  getAgent,
  getTeamConfig,
  type AgentRole,
} from '../config/agent_config_store.js';
import type { Conversation } from '../config/conversation_types.js';
import { HANDOFF_CARD_KEEP, type HandoffCard } from './dispatch.js';
import { TEAM_MESSAGE_KEEP, type TeamMessage } from './message.js';

/**
 * A team is a root conversation plus one child conversation per role.
 *
 * The root is the conversation the user created; the role sessions are where the work
 * actually happens. Both share the root's project directory, so "one workspace, five
 * roles" needs no extra plumbing: `projectPath` already is the working root of every
 * conversation in a project.
 *
 * Role sessions are created lazily. A conversation created before the team existed simply
 * has none, and becomes a team the first time a role is needed.
 */

const TEAM_SCHEMA_VERSION = 1;

export type TeamMode = 'auto' | 'manual';

/** Why a turn went to the role it went to. Recorded so the UI can explain routing. */
export interface TeamRouteRecord {
  roleId: AgentRole;
  /** 0..1; `always-pi` reports 1 and manual switches report 1. */
  confidence: number;
  source: 'default' | 'rule' | 'llm' | 'biod' | 'fallback' | 'manual';
  reason: string;
  at: string;
}

export interface TeamState {
  schemaVersion: number;
  mode: TeamMode;
  activeRoleId: AgentRole;
  lastRoute: TeamRouteRecord | null;
  /** Newest last; capped at `HANDOFF_CARD_KEEP`. */
  cards: HandoffCard[];
  /**
   * Every message the team sent, newest last, capped at `TEAM_MESSAGE_KEEP`.
   *
   * This is the durable record of the cross-role channel: the in-flight queue in
   * `message_bus` only holds what the current turn has not executed yet.
   */
  messages: TeamMessage[];
}

export interface TeamRoleView {
  id: AgentRole;
  label: string;
  name: string;
  description: string;
  orchestratorDescription: string;
  /** The role's own conversation, or null when no work has needed it yet. */
  sessionId: string | null;
  messageCount: number;
  /** Which provider/model/level this role answers with in THIS session. */
  llm: TeamRoleLlmView;
}

/**
 * The model a role actually runs with, already resolved.
 *
 * The Web renders the composer picker from this instead of walking
 * `session override > user binding > agents.json` a second time: two implementations of one
 * precedence rule drift, and the one the user reads would be the one that is wrong.
 */
export interface TeamRoleLlmView {
  /** The session-scoped pick, or null when the role follows its binding. */
  override: SessionLlmOverride | null;
  selection: {
    providerId: string;
    providerName: string;
    modelId: string;
    thinkingLevel?: string;
  };
  /** Which layer produced `selection`. */
  source: 'session' | 'user' | 'role' | 'default';
  /** False when the saved selection no longer resolves; `selection` then keeps the raw ids. */
  routable: boolean;
}

export interface TeamView {
  rootId: string;
  title: string;
  projectPath: string | null;
  leadRoleId: AgentRole;
  mode: TeamMode;
  activeRoleId: AgentRole;
  lastRoute: TeamRouteRecord | null;
  cards: HandoffCard[];
  messages: TeamMessage[];
  roles: TeamRoleView[];
}

/** The root of the team a conversation belongs to; a root resolves to itself. */
export function resolveTeamRoot(conversationId: string): Conversation | undefined {
  const conversation = getConversation(conversationId);
  if (!conversation) return undefined;
  if (!conversation.roleId || !conversation.parentConversationId) return conversation;
  return getConversation(conversation.parentConversationId) || conversation;
}

export function listRoleSessions(rootId: string): Conversation[] {
  return listChildConversations(rootId).filter((conversation) => Boolean(conversation.roleId));
}

export function getRoleSession(rootId: string, roleId: string): Conversation | undefined {
  return listRoleSessions(rootId).find((conversation) => conversation.roleId === roleId);
}

/**
 * Return the role's session, creating it on first use.
 *
 * Throws when the id is not a team root: a role session never nests inside another role
 * session, and a delegated subagent is not a team.
 */
export function ensureRoleSession(rootId: string, roleId: AgentRole): Conversation {
  const root = getConversation(rootId);
  if (!root) throw new Error(`Conversation not found: ${rootId}`);
  if (root.roleId) throw new Error('A role session cannot own role sessions.');
  if (!root.projectPath) throw new Error('The team root has no project directory.');
  const agent = getAgent(roleId);
  if (!agent) throw new Error(`Unknown team role: ${roleId}`);

  const existing = getRoleSession(rootId, roleId);
  if (existing) return existing;
  return createConversation({
    projectPath: root.projectPath,
    title: agent.label || roleId,
    parentConversationId: rootId,
    roleId,
    subagentDepth: 0,
  });
}

export function readTeamState(rootId: string): TeamState {
  const defaults: TeamState = {
    schemaVersion: TEAM_SCHEMA_VERSION,
    mode: 'auto',
    activeRoleId: getTeamConfig().leadRoleId,
    lastRoute: null,
    cards: [],
    messages: [],
  };
  const file = teamStatePath(rootId);
  if (!file || !fs.existsSync(file)) return defaults;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TeamState>;
    return normalizeState(raw, defaults);
  } catch {
    return defaults;
  }
}

export function updateTeamState(rootId: string, patch: Partial<Pick<TeamState, 'mode' | 'activeRoleId' | 'lastRoute'>>): TeamState {
  const current = readTeamState(rootId);
  const next = normalizeState({ ...current, ...(patch || {}) }, current);
  const file = teamStatePath(rootId);
  if (!file) throw new Error(`Conversation not found: ${rootId}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

export function describeTeam(conversationId: string): TeamView | undefined {
  const root = resolveTeamRoot(conversationId);
  if (!root) return undefined;
  const team = getTeamConfig();
  const state = readTeamState(root.id);
  const sessions = new Map(listRoleSessions(root.id).map((session) => [session.roleId, session]));
  const overrides = readSessionLlmOverrides(root.id);

  return {
    rootId: root.id,
    title: root.title,
    projectPath: root.projectPath,
    leadRoleId: team.leadRoleId,
    mode: state.mode,
    activeRoleId: state.activeRoleId,
    lastRoute: state.lastRoute,
    cards: state.cards,
    messages: state.messages,
    roles: TEAM_ROLE_IDS.map((roleId) => {
      const agent = getAgent(roleId);
      const session = sessions.get(roleId);
      return {
        id: roleId,
        label: agent?.label || roleId,
        name: agent?.name || roleId,
        description: agent?.description || '',
        orchestratorDescription: agent?.orchestratorDescription || '',
        sessionId: session?.id || null,
        messageCount: session ? getMessageCount(session.id) : 0,
        llm: describeRoleLlm(roleId, agent, overrides[roleId] || null),
      };
    }),
  };
}

/**
 * Resolve one role's selection through the same chain the run path uses, and say where it
 * came from. A saved selection that no longer resolves is reported, not replaced: the chip
 * keeps showing what the user picked, and the run fails with the same unknown-model error
 * the resolver would raise.
 */
function describeRoleLlm(roleId: AgentRole, agent: ReturnType<typeof getAgent>, override: SessionLlmOverride | null): TeamRoleLlmView {
  const binding = override ? null : resolveRoleBinding(roleId);
  const source: TeamRoleLlmView['source'] = override
    ? 'session'
    : binding
      ? 'user'
      : agent?.llmProviderId
        ? 'role'
        : 'default';
  const requested = override
    ? { providerId: override.providerId, modelId: override.modelId, thinkingLevel: override.thinkingLevel }
    : binding
      ? { providerId: binding.providerId, modelId: binding.modelId, thinkingLevel: binding.thinkingLevel }
      : {
          providerId: agent?.llmProviderId || undefined,
          modelId: agent?.llmModelId || undefined,
          thinkingLevel: agent?.llmThinkingLevel || undefined,
        };
  const resolved = resolveLLMTargetForCurrentUser(requested);
  if (resolved.ok) {
    return {
      override,
      selection: {
        providerId: resolved.provider.id,
        providerName: resolved.provider.name,
        modelId: resolved.provider.model,
        ...(resolved.provider.thinkingLevelName ? { thinkingLevel: resolved.provider.thinkingLevelName } : {}),
      },
      source,
      routable: true,
    };
  }
  return {
    override,
    selection: {
      providerId: requested.providerId || '',
      providerName: '',
      modelId: requested.modelId || '',
      ...(requested.thinkingLevel ? { thinkingLevel: requested.thinkingLevel } : {}),
    },
    source,
    routable: false,
  };
}

/**
 * Storage path of the team state, or null when the conversation has no session directory
 * yet (which cannot happen for a persisted root, but keeps the read side total).
 */
function teamStatePath(rootId: string): string | null {
  const projectKey = findSessionProjectKey(rootId);
  return projectKey ? teamStateFilePath(projectKey, rootId) : null;
}

function normalizeState(raw: Partial<TeamState>, fallback: TeamState): TeamState {
  const roles = new Set<string>(TEAM_ROLE_IDS);
  const leadRoleId = getTeamConfig().leadRoleId;
  const activeRoleId = typeof raw.activeRoleId === 'string' && roles.has(raw.activeRoleId)
    ? raw.activeRoleId as AgentRole
    : fallback.activeRoleId || leadRoleId;
  const mode: TeamMode = raw.mode === 'manual' ? 'manual' : 'auto';
  const lastRoute = raw.lastRoute && typeof raw.lastRoute === 'object' && roles.has(String(raw.lastRoute.roleId))
    ? {
        roleId: raw.lastRoute.roleId,
        confidence: Number.isFinite(Number(raw.lastRoute.confidence)) ? Number(raw.lastRoute.confidence) : 0,
        source: raw.lastRoute.source || 'default',
        reason: String(raw.lastRoute.reason || ''),
        at: String(raw.lastRoute.at || ''),
      } satisfies TeamRouteRecord
    : null;
  const cards = Array.isArray(raw.cards)
    ? raw.cards.filter((card): card is HandoffCard => Boolean(card) && typeof card === 'object' && typeof (card as HandoffCard).id === 'string').slice(-HANDOFF_CARD_KEEP)
    : [];
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter((message): message is TeamMessage => isTeamMessage(message)).slice(-TEAM_MESSAGE_KEEP)
    : [];
  return { schemaVersion: TEAM_SCHEMA_VERSION, mode, activeRoleId, lastRoute, cards, messages };
}

function isTeamMessage(value: unknown): value is TeamMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<TeamMessage>;
  return typeof message.id === 'string' && typeof message.kind === 'string' && typeof message.from === 'string' && typeof message.to === 'string';
}

function writeTeamState(rootId: string, next: TeamState): TeamState {
  const file = teamStatePath(rootId);
  if (!file) throw new Error(`Conversation not found: ${rootId}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** Append a card and drop the oldest beyond the keep limit. */
export function appendHandoffCard(rootId: string, card: HandoffCard): TeamState {
  const current = readTeamState(rootId);
  return writeTeamState(rootId, { ...current, cards: [...current.cards, card].slice(-HANDOFF_CARD_KEEP) });
}

/** Append a message to the durable record and drop the oldest beyond the keep limit. */
export function appendTeamMessage(rootId: string, message: TeamMessage): TeamState {
  const current = readTeamState(rootId);
  return writeTeamState(rootId, { ...current, messages: [...current.messages, message].slice(-TEAM_MESSAGE_KEEP) });
}
