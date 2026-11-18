import type { TeamMessage } from './message.js';

/**
 * Pending team messages of one in-flight turn, keyed by team root.
 *
 * A tool call cannot switch conversations, so sending a message only records it here. The
 * team pump drains this list when the current run ends and executes every message in the
 * target role's own session — the message is not waiting for a free slot, it is waiting for
 * the sender to finish its own step.
 *
 * Process-local on purpose: the durable record of what was said is `TeamState.messages` in
 * `team.json`. A restart loses an in-flight turn, which is exactly what it already loses
 * today, and never loses the fact that a message was sent.
 */
const pending = new Map<string, TeamMessage[]>();

export function enqueueTeamMessage(rootId: string, message: TeamMessage): TeamMessage {
  const list = pending.get(rootId);
  if (list) list.push(message);
  else pending.set(rootId, [message]);
  return message;
}

/** Take everything waiting for one team root, oldest first; the queue starts empty again. */
export function drainTeamMessages(rootId: string): TeamMessage[] {
  const list = pending.get(rootId) || [];
  pending.delete(rootId);
  return list;
}

export function peekTeamMessages(rootId: string): TeamMessage[] {
  return [...(pending.get(rootId) || [])];
}

export function clearTeamMessages(rootId: string): void {
  pending.delete(rootId);
}

export function resetTeamMessageBusForTests(): void {
  pending.clear();
}
