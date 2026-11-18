import { getConversation, listChildConversations } from './config/conversation_service.js';
import type { Conversation } from './config/conversation_types.js';
import {
  foldRuns,
  readTranscriptRecords,
  TranscriptLogError,
  type TranscriptRunSummary,
} from './transcript_reader.js';

/**
 * Read one conversation tree's trajectory as a map.
 *
 * The log is per conversation, but the product is a tree: a team root plus one session
 * per role, and any of those can delegate subagents. Listing the runs of every node in
 * one answer is what turns "six files" back into "one session's work"; reading the events
 * of a single node stays the existing per-conversation endpoint.
 *
 * A node whose log cannot be read is reported as `damaged` instead of failing the whole
 * map: one broken role log must not hide the rest of the team. The single-conversation
 * endpoint still answers 500 for that node.
 */

export interface TranscriptTreeConversation {
  conversationId: string;
  title: string;
  roleId: string | null;
  agentId: string | null;
  /** Conversation that owns this one; null for the requested root. */
  parentConversationId: string | null;
  /** Distance from the requested conversation (the root is 0). */
  depth: number;
  runs: TranscriptRunSummary[];
  eventCount: number;
  tornTail: boolean;
  damaged: boolean;
}

export interface TranscriptTree {
  rootId: string;
  generatedAt: string;
  conversations: TranscriptTreeConversation[];
  totals: { conversations: number; runs: number; events: number; damaged: number };
}

const DEFAULT_MAX_DEPTH = 8;
const MAX_MAX_DEPTH = 16;

export function readTranscriptTree(
  conversationId: string,
  options: { maxDepth?: number } = {},
): TranscriptTree | null {
  const requested = getConversation(conversationId);
  if (!requested) return null;
  const maxDepth = normaliseDepth(options.maxDepth);

  const nodes: TranscriptTreeConversation[] = [];
  const seen = new Set<string>([requested.id]);
  let level: Array<{ conversation: Conversation; depth: number }> = [{ conversation: requested, depth: 0 }];

  while (level.length) {
    const next: typeof level = [];
    for (const { conversation, depth } of level) {
      nodes.push(toNode(conversation, depth));
      if (depth >= maxDepth) continue;
      for (const child of listChildConversations(conversation.id)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        next.push({ conversation: child, depth: depth + 1 });
      }
    }
    level = next;
  }

  return {
    rootId: requested.id,
    generatedAt: new Date().toISOString(),
    conversations: nodes,
    totals: {
      conversations: nodes.length,
      runs: nodes.reduce((total, node) => total + node.runs.length, 0),
      events: nodes.reduce((total, node) => total + node.eventCount, 0),
      damaged: nodes.filter((node) => node.damaged).length,
    },
  };
}

function toNode(conversation: Conversation, depth: number): TranscriptTreeConversation {
  const base = {
    conversationId: conversation.id,
    title: conversation.title,
    roleId: conversation.roleId ?? null,
    agentId: conversation.agentId ?? null,
    parentConversationId: conversation.parentConversationId ?? null,
    depth,
  };
  try {
    const { records, tornTail } = readTranscriptRecords(conversation.id);
    return { ...base, runs: foldRuns(records), eventCount: records.length, tornTail, damaged: false };
  } catch (error) {
    if (!(error instanceof TranscriptLogError)) throw error;
    return { ...base, runs: [], eventCount: 0, tornTail: false, damaged: true };
  }
}

function normaliseDepth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_DEPTH;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_MAX_DEPTH);
}
