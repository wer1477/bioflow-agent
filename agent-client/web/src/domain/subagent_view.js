/**
 * 子 Agent 视图的纯逻辑：状态映射、计数、行文案。
 *
 * 组件只负责渲染；这些函数可以在 node --test 里直接断言，不需要 React。
 * 状态词表由后端 `subagent_catalog` 决定（running / completed / failed /
 * cancelled / unknown），这里只做展示映射，不引入第二套语义。
 */

/** 后端状态 → StateDot 的 state 与中文标签。 */
export function subagentStatusMeta(status) {
  switch (status) {
    case 'running':
      return { state: 'running', label: '运行中' };
    case 'completed':
      return { state: 'done', label: '已完成' };
    case 'failed':
      return { state: 'error', label: '失败' };
    case 'cancelled':
      return { state: 'warning', label: '已取消' };
    default:
      return { state: 'idle', label: '状态未知' };
  }
}

/** 下拉/列表里的一行标题：委派描述优先，其次会话标题。 */
export function subagentRowLabel(row) {
  const description = String(row?.description || '').trim();
  if (description) return description;
  const title = String(row?.title || '').trim();
  if (title) return title.replace(/^Subagent · /, '');
  return '子 Agent';
}

/** 毫秒 → `45s` / `2m10s` / `1h05m`；负值与非数字按 0 处理。 */
export function formatSubagentDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** 行内附加信息：消息条数 + 已运行时长。 */
export function subagentRowMeta(row) {
  const parts = [];
  const count = Number(row?.messageCount);
  if (Number.isFinite(count) && count > 0) parts.push(`${count} 条消息`);
  if (row?.status === 'running') parts.push(`已运行 ${formatSubagentDuration(row?.durationMs)}`);
  else if (Number(row?.durationMs) > 0) parts.push(formatSubagentDuration(row.durationMs));
  return parts.join(' · ');
}

/** 父会话标题旁的触发器文案：`子 Agent 2`，有运行中的再补一段。 */
export function subagentTriggerLabel(counts) {
  const total = Math.max(0, Number(counts?.total) || 0);
  const running = Math.max(0, Number(counts?.running) || 0);
  if (!total) return '';
  return running ? `子 Agent ${total} · ${running} 运行中` : `子 Agent ${total}`;
}

/** 当前会话是否是委派子会话；父标题在 `conversation.parent` 上。 */
export function isSubagentConversation(conversation) {
  return Boolean(conversation?.parentConversationId);
}

/** 在父会话的子列表里找到当前会话自己的那一行（子会话视图用）。 */
export function findSubagentRow(rows, conversationId) {
  if (!conversationId) return null;
  return (rows || []).find((row) => row?.conversationId === conversationId) || null;
}
