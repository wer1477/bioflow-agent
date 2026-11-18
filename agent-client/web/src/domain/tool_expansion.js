// 工具展开态的纯逻辑：展开标识与集合切换。
// 无 React 依赖，保持可单测（与 domain/ 下其余模块同样的约定）。

/**
 * trace item 的展开标识。
 *
 * 工具行带跨 live→持久化稳定的 `callId`（见 domain/trace.js 的 toolCallId）；
 * 其余行（plan / mcp / runtime）没有跨阶段稳定的身份，退回位置派生的 key——
 * 这类行本就只在单侧存在（run_status 只出现在 live），切换即收起是可接受的。
 */
export function traceExpansionId(item) {
  return item?.callId || item?.key || '';
}

/** 切换单个展开项，返回新集合（不原地修改，便于 React 比较引用）。 */
export function toggleToolExpansion(ids, id) {
  const next = new Set(ids || []);
  if (!id) return next;
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
