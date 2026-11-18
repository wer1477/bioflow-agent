/**
 * Pick the next queued message that may start now.
 *
 * A conversation runs one turn at a time, so the pump has to respect both the live state
 * (the conversation is running somewhere, possibly in another view or a team run) and a
 * per-message `notBefore`: a send the server just refused because a run was already active
 * is pushed back by a moment instead of being retried in a tight loop.
 */
export function claimNextQueuedMessage(queuedMessages, runningConversationIds, claimedConversationIds, now = Date.now()) {
  const item = (queuedMessages || []).find((candidate) => (
    candidate?.conversationId
    && !runningConversationIds.has(candidate.conversationId)
    && !claimedConversationIds.has(candidate.conversationId)
    && Number(candidate.notBefore || 0) <= now
  ));
  if (!item) return null;
  claimedConversationIds.add(item.conversationId);
  return { item, remaining: queuedMessages.filter((candidate) => candidate.id !== item.id) };
}
