export function canCopyAssistantMessage(message, { isLive = false } = {}) {
  if (isLive) return false;
  const status = message.toolCalls?.run?.status;
  return !status || status === 'completed';
}
