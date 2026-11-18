export function isConversationRunning(runningConversationIds, conversationId) {
  return Boolean(conversationId && runningConversationIds.has(conversationId));
}

export function resolveMessageDisposition(runningConversationIds, conversationId) {
  return isConversationRunning(runningConversationIds, conversationId) ? 'queue' : 'start';
}
