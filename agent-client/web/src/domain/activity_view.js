// 侧栏活动指示器的纯逻辑：运行圈与完成点都从后端活动快照 + 本地"已看过"标记推导。
// 无 React 依赖，保持可单测（与 src/domain/* 其余模块一致）。

/**
 * 合并多份"正在运行"的会话 id。
 *
 * 一份是本地 run 状态（请求发出的瞬间就有值），一份是后端活动快照（能看到别的视图、
 * 角色会话与委派子 Agent 发起的 run）。两份都算忙：取并集，圈不会晚一个轮询周期。
 */
export function mergeRunningIds(...sources) {
  const ids = new Set();
  for (const source of sources) {
    for (const conversationId of source || []) {
      if (conversationId) ids.add(conversationId);
    }
  }
  return ids;
}

/** 某个会话已被看到的最新完成序号。 */
export function seenSequence(seen, conversationId) {
  return Number(seen?.seen?.[conversationId] || 0);
}

/**
 * 未读完成 = 会话最后一个 run 已结束、成功、且不是当前正在看的会话，并且序号比已看过的更新。
 *
 * 用序号而不是时间：浏览器和后端不一定共用一个时钟，比较挂钟会漏点或留点。
 */
export function unseenCompletions(conversations, seen, currentConversationId = '') {
  const ids = new Set();
  for (const [conversationId, entry] of Object.entries(conversations || {})) {
    if (!entry || conversationId === currentConversationId) continue;
    if (entry.running || !entry.finishedAt || !entry.seq) continue;
    if (entry.status !== 'completed') continue;
    if (seenSequence(seen, conversationId) >= Number(entry.seq)) continue;
    ids.add(conversationId);
  }
  return ids;
}

/**
 * 记下"这个会话的记录我已经看到第 seq 条"。
 *
 * `epoch` 在每次后端进程启动时变化；序号不跨进程比较，否则重启后会长时间不再出点。
 * 返回原对象表示没有变化，调用方据此跳过状态更新与写盘。
 */
export function acknowledgeSeen(seen, { epoch = '', conversationId = '', seq = 0 } = {}) {
  if (!conversationId || !Number(seq)) return seen;
  const sameEpoch = Boolean(seen?.epoch) && seen.epoch === epoch;
  const base = sameEpoch ? (seen.seen || {}) : {};
  if (Number(base[conversationId] || 0) >= Number(seq)) return seen;
  return { epoch, seen: { ...base, [conversationId]: Number(seq) } };
}

/** 只保留当前仍存在的会话，避免 localStorage 里的标记无限增长。 */
export function pruneSeen(seen, conversationIds) {
  const keep = conversationIds instanceof Set ? conversationIds : new Set(conversationIds || []);
  const rows = Object.entries(seen?.seen || {}).filter(([conversationId]) => keep.has(conversationId));
  if (rows.length === Object.keys(seen?.seen || {}).length) return seen;
  return { epoch: seen?.epoch || '', seen: Object.fromEntries(rows) };
}

/**
 * 活动快照里某个会话刚结束时，该不该重新拉它的消息。
 *
 * `previous` 是上一次看到的序号（运行中也会记）。第一次见到某个会话（undefined）不重拉：
 * 打开会话时消息本来就是新的；只有「看着它从运行走到结束、序号前进」才需要重拉，
 * 否则视图会停在半截——工具行没有结果、正文只写了一半。
 */
export function shouldReloadSettledConversation(previous, entry) {
  if (!entry || entry.running || !entry.finishedAt) return false;
  if (previous === undefined || previous === null) return false;
  return Number(entry.seq) > Number(previous);
}
