const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isRunActive(run) {
  return Boolean(run?.status) && !TERMINAL_RUN_STATUSES.has(run.status);
}

/**
 * 记录一次 run 状态。`at` 是本次状态变更的本地时间（毫秒），只用于给新一轮起算等待时间。
 *
 * `startedAt` 的语义是「这一轮第一次进入 active 的时刻」：
 * - 同一轮内 building_context → model_turn → tool_execution 的切换保留首值；
 * - 上一轮已经结束（或没有记录）时重新起算，否则下一轮会继承上一轮的等待时长；
 * - 终态保留旧值，不影响渲染（active 判断已经为 false），只为状态表里留一份可读记录。
 */
export function applyRunStatus(states, conversationId, status, at = 0) {
  if (!conversationId || !status?.status) return states;
  const previous = states.get(conversationId);
  const active = isRunActive(status);
  const previousActive = isRunActive(previous);
  const startedAt = active
    ? (previousActive && previous?.startedAt ? previous.startedAt : (at || 0))
    : (previous?.startedAt || 0);
  const next = new Map(states);
  next.set(conversationId, {
    runId: status.runId || status.id || previous?.runId || '',
    status: status.status,
    stopReason: status.stopReason ?? previous?.stopReason ?? null,
    error: status.error ?? previous?.error ?? '',
    startedAt,
  });
  return next;
}

export function removeRunState(states, conversationId) {
  if (!states.has(conversationId)) return states;
  const next = new Map(states);
  next.delete(conversationId);
  return next;
}
