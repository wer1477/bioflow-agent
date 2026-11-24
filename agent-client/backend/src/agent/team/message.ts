import { v4 as uuidv4 } from 'uuid';
import type { AgentRole } from '../config/agent_config_store.js';

/**
 * One message between two team roles.
 *
 * A message is the only cross-session unit in a team. A role never switches conversations
 * itself: a tool call records the message, the team pump runs the target in the target's own
 * session, and everything the receiving model sees is `renderTeamMessagePrompt`. The injected
 * row is a plain user turn (a second system row breaks strict chat templates), so the header
 * carries the two facts the row itself cannot: who sent it and what kind of message it is.
 */
export type TeamMessageKind = 'delegate' | 'append' | 'relay' | 'deliver' | 'reply';

/** How the biod gate ruled on a role-initiated relay. Recorded next to the message. */
export interface TeamMessageGate {
  verdict: 'allow' | 'reject' | 'escalate';
  /** 0..1; low confidence is what escalates to the lead. */
  confidence: number;
  /** The three judgement questions the gate answered, one line each. */
  reasons?: string[];
  /** Which engine produced the verdict, so a fallback is visible after the fact. */
  source?: string;
  at?: string;
}

export interface TeamMessage {
  id: string;
  kind: TeamMessageKind;
  /** Who sent it. A runtime-authored `reply` carries the role that answered. */
  from: AgentRole;
  to: AgentRole;
  body: string;
  /** Acceptance criteria, only meaningful for `delegate`. */
  expect?: string;
  dependsOn?: string[];
  /** The message this one answers. */
  replyTo?: string;
  gate?: TeamMessageGate;
  createdAt: string;
}

/** How many messages the team keeps in `team.json`. */
export const TEAM_MESSAGE_KEEP = 60;

export function buildTeamMessage(input: {
  kind: TeamMessageKind;
  from: AgentRole;
  to: AgentRole;
  body: string;
  expect?: string;
  dependsOn?: string[];
  replyTo?: string;
  gate?: TeamMessageGate;
}): TeamMessage {
  return {
    id: uuidv4(),
    kind: input.kind,
    from: input.from,
    to: input.to,
    body: String(input.body ?? '').trim(),
    ...(input.expect ? { expect: String(input.expect).trim() } : {}),
    ...(input.dependsOn?.length ? { dependsOn: [...input.dependsOn] } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.gate ? { gate: input.gate } : {}),
    createdAt: new Date().toISOString(),
  };
}

const KIND_LABEL: Record<TeamMessageKind, string> = {
  delegate: '委派',
  append: '追加',
  relay: '转述',
  deliver: '交付',
  reply: '回复',
};

export function teamMessageKindLabel(kind: TeamMessageKind): string {
  return KIND_LABEL[kind] || kind;
}

/**
 * The exact text the receiving role reads.
 *
 * Kept pure and identical for every call site: a message that reached a role through a
 * different path must not read differently, or the model will infer authority it was not
 * given (``已请 PI 转达`` and similar fabrications start exactly here).
 */
export function renderTeamMessagePrompt(message: TeamMessage): string {
  const lines = [`[团队消息 · 来自 ${message.from} · ${teamMessageKindLabel(message.kind)}]`, message.body];
  if (message.expect) lines.push('', `验收标准：${message.expect}`);
  return lines.join('\n');
}

/** One line describing a message for the record and for the lead's acceptance prompt. */
export function summarizeTeamMessage(message: TeamMessage, maxChars = 160): string {
  const body = message.body.replace(/\s+/g, ' ').trim();
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `[${message.from} → ${message.to}] ${teamMessageKindLabel(message.kind)}：${clipped}`;
}
