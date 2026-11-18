import { getConversation } from './config/conversation_service.js';
import { foldConversationPanels, type ConversationPanels, type GoalState } from './conversation_panels.js';
import { readTranscriptRecords, type TranscriptRecord } from './transcript_reader.js';
import { listRoleSessions, resolveTeamRoot } from './team/team_service.js';

/**
 * Which conversations' logs a panel read belongs to.
 *
 * A goal and a to-do list are state documents in a transcript, and a transcript belongs
 * to exactly one conversation. The team turns that into a problem: the user watches the
 * root, while the work — and therefore the state writes — happen in the role sessions.
 * Reading only the requested conversation made the team view permanent-empty (the root
 * never runs) and hid every goal from every other role.
 *
 * The rule here is the same one the merged timeline and the session statistics use: a
 * team is a projection over its role sessions. A team-scoped read folds the root plus
 * every role session, newest write wins. A subagent is *not* team-scoped — it runs
 * isolated on purpose and must not inherit state it was never given.
 */

export interface PanelScopeSource {
  conversationId: string;
  roleId: string | null;
}

export interface PanelScope {
  scope: 'team' | 'conversation';
  rootId: string;
  sources: PanelScopeSource[];
}

export interface ScopedPanels extends PanelScope {
  panels: ConversationPanels;
  /** True when any folded log ended in an unusable record. */
  tornTail: boolean;
}

/**
 * Resolve the conversations one panel read covers.
 *
 * A root with no role sessions is still just a conversation: the team only exists once a
 * role has been needed. Requesting a role session resolves to the whole team, because the
 * state is team-wide — that is what lets a role's `get_goal` see a goal the Web created
 * on the root.
 */
export function panelScopeOf(conversationId: string): PanelScope {
  const conversation = getConversation(conversationId);
  if (!conversation) throw new Error(`Unknown conversation ${conversationId}.`);
  const root = resolveTeamRoot(conversationId) ?? conversation;
  const roleSessions = listRoleSessions(root.id);
  if (!roleSessions.length) {
    return {
      scope: 'conversation',
      rootId: root.id,
      sources: [{ conversationId: conversation.id, roleId: conversation.roleId ?? null }],
    };
  }
  return {
    scope: 'team',
    rootId: root.id,
    sources: [
      { conversationId: root.id, roleId: null },
      ...roleSessions.map((session) => ({
        conversationId: session.id,
        roleId: session.roleId ?? null,
      })),
    ],
  };
}

/**
 * Read and fold every conversation in scope.
 *
 * Records are ordered by wall clock, not sequence: sequences are per log and comparing
 * them across conversations would be meaningless. Ties fall back to the conversation id
 * so the fold is deterministic.
 *
 * A damaged log is not swallowed here — the caller decides. `/panels` reports it loudly,
 * exactly as it does for a single conversation.
 */
export function readScopedPanels(conversationId: string): ScopedPanels {
  const scope = panelScopeOf(conversationId);
  const records: TranscriptRecord[] = [];
  let tornTail = false;
  for (const source of scope.sources) {
    const read = readTranscriptRecords(source.conversationId);
    records.push(...read.records);
    tornTail = tornTail || read.tornTail;
  }
  if (scope.sources.length > 1) records.sort(compareRecords);
  return { ...scope, panels: foldConversationPanels(records), tornTail };
}

/** The current goal in scope; `null` when there is none or the log cannot be read. */
export function readScopedGoal(conversationId: string | undefined): GoalState | null {
  if (!conversationId) return null;
  try {
    return readScopedPanels(conversationId).panels.goal;
  } catch {
    // A transcript that cannot be read must not turn every goal tool into a crash: the
    // model sees "no goal" and the HTTP panel endpoint surfaces the real error.
    return null;
  }
}

/**
 * Conversation a Web state mutation must be appended to.
 *
 * A team's state documents live on the root: the root never runs, so appending there can
 * neither race a recorder nor be stranded by the router switching roles. Every role reads
 * them back through the merged scope above.
 */
export function panelStateOwnerId(conversationId: string): string {
  return panelScopeOf(conversationId).rootId;
}

function compareRecords(a: TranscriptRecord, b: TranscriptRecord): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  const byConversation = a.conversationId.localeCompare(b.conversationId);
  if (byConversation !== 0) return byConversation;
  return a.sequence - b.sequence;
}
