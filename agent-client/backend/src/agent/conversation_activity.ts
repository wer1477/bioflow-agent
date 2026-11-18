import { getConversation } from './config/conversation_service.js';
import { snapshotRunActivity, type RunActivityStatus } from './run_activity.js';

/**
 * The Web-facing view of "who is busy right now".
 *
 * A team is one root conversation plus role sessions (and, below them, delegated children).
 * The user watches the team timeline, so a role working in its own session has to show up on
 * the root — and a child that keeps working after its parent's turn ended has to show up on
 * the role session that created it. That is the whole point of this module: walk each live
 * run up its `parentConversationId` chain and let every ancestor inherit the activity.
 *
 * `runningRoles` names the roles behind the activity so the sidebar can say *who* is working
 * instead of just that something is.
 */

export interface ConversationActivity {
  conversationId: string;
  /** This conversation or anything below it is running. */
  running: boolean;
  /** This conversation's own run is live; a descendant's is not. */
  selfRunning: boolean;
  /** Live runs at or below this conversation. */
  runningCount: number;
  /** Roles of the live runs: its own role first, then the roles of its descendants. */
  runningRoles: string[];
  /** Newest settled run at or below this conversation (the completion dot reads this). */
  runId: string | null;
  status: RunActivityStatus | null;
  startedAt: string | null;
  finishedAt: string | null;
  seq: number;
}

export interface ConversationActivitySnapshot {
  epoch: string;
  generatedAt: string;
  conversations: Record<string, ConversationActivity>;
}

function emptyActivity(conversationId: string): ConversationActivity {
  return {
    conversationId,
    running: false,
    selfRunning: false,
    runningCount: 0,
    runningRoles: [],
    runId: null,
    status: null,
    startedAt: null,
    finishedAt: null,
    seq: 0,
  };
}

/** Earlier of two ISO timestamps; the live run started first is the one that matters. */
function earliest(current: string | null, next: string): string {
  if (!current) return next;
  return next < current ? next : current;
}

function addRole(activity: ConversationActivity, roleId: string | null | undefined): void {
  const role = String(roleId || '').trim();
  if (!role || activity.runningRoles.includes(role)) return;
  activity.runningRoles.push(role);
}

/**
 * Only the newest settled run is kept per conversation: the dot is "there is something you
 * have not looked at", and an older finish that has already been seen cannot change that.
 */
function applySettled(activity: ConversationActivity, record: { runId: string; status: RunActivityStatus; startedAt: string; finishedAt: string | null; seq: number }): void {
  if (record.seq <= activity.seq) return;
  activity.seq = record.seq;
  activity.runId = record.runId;
  activity.status = record.status;
  activity.startedAt = record.startedAt;
  activity.finishedAt = record.finishedAt;
}

/**
 * Every conversation touched by a live or recently finished run, with ancestor activity
 * folded in. Conversations that no longer exist are dropped; their ancestors still inherit
 * whatever the record said.
 */
export function listConversationActivity(): ConversationActivitySnapshot {
  const snapshot = snapshotRunActivity();
  const conversations = new Map<string, ConversationActivity>();

  for (const record of snapshot.records) {
    const conversation = getConversation(record.conversationId);
    if (!conversation) continue;

    const own = conversations.get(conversation.id) || emptyActivity(conversation.id);
    conversations.set(conversation.id, own);
    const live = record.status === 'running';
    if (live) {
      own.running = true;
      own.selfRunning = true;
      own.runningCount += 1;
      own.startedAt = earliest(own.startedAt, record.startedAt);
      addRole(own, conversation.roleId);
    } else {
      applySettled(own, record);
    }

    // Walk up to the team root. `inheritedRole` is the nearest role on the way, so a
    // delegated child lights up the role session that created it, not just the root.
    let parentId = conversation.parentConversationId || null;
    let inheritedRole = conversation.roleId || null;
    const visited = new Set([conversation.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = getConversation(parentId);
      if (!parent) break;
      inheritedRole = parent.roleId || inheritedRole;
      const view = conversations.get(parent.id) || emptyActivity(parent.id);
      conversations.set(parent.id, view);
      if (live) {
        view.running = true;
        view.runningCount += 1;
        view.startedAt = earliest(view.startedAt, record.startedAt);
        addRole(view, inheritedRole);
      } else {
        applySettled(view, record);
      }
      parentId = parent.parentConversationId || null;
    }
  }

  return {
    epoch: snapshot.epoch,
    generatedAt: snapshot.generatedAt,
    conversations: Object.fromEntries(conversations),
  };
}
