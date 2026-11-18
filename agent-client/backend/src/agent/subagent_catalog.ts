import { getConversation, getMessageCount, listChildConversations } from './config/conversation_service.js';
import { getConversationRuns } from './config/run_store.js';
import { subagentRuntime } from './core_tools/subagent_runtime.js';

/**
 * The durable view of delegation: which conversations are children of a parent,
 * and what happened to each of them.
 *
 * Two consumers share this module so the Web header and the `subagent` tool can
 * never disagree about a child's state:
 *
 * - `http/routes/conversations.ts` builds the parent's subagent panel from it.
 * - `core_tools/subagent_executor.ts` answers `action=status` / `action=result`
 *   from it.
 *
 * The live process map (`subagentRuntime`) is consulted first and the persisted
 * run history second: a child whose process died has no handle but still has a
 * run record, and an interrupted run still reads as "not finished" there.
 */

export type SubagentConversationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface SubagentConversationSummary {
  conversationId: string;
  parentConversationId: string | null;
  /** Team role of the parent conversation; null when the parent is not a role session. */
  roleId: string | null;
  title: string;
  description: string;
  status: SubagentConversationStatus;
  depth: number | null;
  startedAt: string | null;
  durationMs: number | null;
  messageCount: number;
}

export interface SubagentCounts {
  total: number;
  running: number;
}

/** `<parent> · <description>` is the creation title; strip the prefix for display fallbacks. */
function derivedDescription(title: string, description?: string | null): string {
  const explicit = (description || '').trim();
  if (explicit) return explicit;
  return title.replace(/^Subagent · /, '').trim();
}

/**
 * Children created before the title guard landed were renamed from their first
 * message, so their stored title is the delegation instruction ("You are a
 * delegated…"). The description is the child's real name; rebuild the display title
 * from it rather than showing the instruction text or rewriting anyone's records.
 */
export function displaySubagentTitle(conversation: {
  title: string;
  parentConversationId?: string | null;
  subagentDescription?: string | null;
}): string {
  if (!conversation.parentConversationId) return conversation.title;
  // The stored title is the truncated first message, so it usually stops at
  // "You are a delegated" without the trailing "subagent".
  if (!/^You are a delegated\b/.test(conversation.title)) return conversation.title;
  const description = (conversation.subagentDescription || '').trim();
  return description ? `Subagent · ${description}` : conversation.title;
}

/**
 * Direct children only: the current delegation limit is a shallow tree, and the
 * header entry lists one level (a child that delegates further is reachable from
 * its own header, the same way this one is).
 *
 * Role sessions are children too, but they are the team, not delegations, so they never
 * appear in this list.
 */
export function listSubagentConversations(parentConversationId: string): SubagentConversationSummary[] {
  const parent = getConversation(parentConversationId);
  // A team root is a container: the delegations are created by the role sessions it
  // owns, so one panel has to cover the root's own children *and* one level below it.
  // A role session (or a plain conversation) lists only its own, exactly as before.
  const scope = parent && !parent.roleId && !parent.parentConversationId
    ? [parent.id, ...listChildConversations(parent.id)
        .filter((child) => child.roleId)
        .map((child) => child.id)]
    : [parentConversationId];

  const rows: SubagentConversationSummary[] = [];
  for (const id of scope) {
    for (const child of listChildConversations(id)) {
      if (child.roleId) continue; // role sessions are the team, not delegations
      const summary = describeSubagentConversation(child.id);
      if (summary) rows.push(summary);
    }
  }
  return rows.sort((a, b) => (a.startedAt || a.conversationId).localeCompare(b.startedAt || b.conversationId));
}

/** `null` when the conversation does not exist (or is not a delegated child). */
export function describeSubagentConversation(conversationId: string): SubagentConversationSummary | null {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;

  const live = subagentRuntime.get(conversationId);
  const latestRun = getConversationRuns(conversationId)[0];
  const status: SubagentConversationStatus = live
    ? 'running'
    : latestRun?.status === 'completed'
      ? 'completed'
      : latestRun?.status === 'cancelled'
        ? 'cancelled'
        : latestRun?.status === 'failed'
          ? 'failed'
          : latestRun
            ? 'running'
            : 'unknown';
  // A finished run carries `completedAt`; an unfinished one is still burning wall clock,
  // so its duration keeps growing until the child settles.
  const finishedAt = latestRun?.completedAt ? Date.parse(latestRun.completedAt) : Date.now();
  const startedAt = latestRun?.startedAt || null;

  const title = displaySubagentTitle(conversation);
  const parent = conversation.parentConversationId
    ? getConversation(conversation.parentConversationId)
    : undefined;
  return {
    conversationId,
    parentConversationId: conversation.parentConversationId || null,
    roleId: parent?.roleId ?? null,
    title,
    description: derivedDescription(title, conversation.subagentDescription),
    status,
    depth: conversation.subagentDepth ?? null,
    startedAt,
    durationMs: startedAt ? Math.max(0, finishedAt - Date.parse(startedAt)) : null,
    messageCount: getMessageCount(conversationId),
  };
}

export function summarizeSubagents(rows: SubagentConversationSummary[]): SubagentCounts {
  return { total: rows.length, running: rows.filter((row) => row.status === 'running').length };
}
