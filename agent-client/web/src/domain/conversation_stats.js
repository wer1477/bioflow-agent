// 会话统计的展示口径：把 /api/conversations/:id/stats 的数字变成 composer 下方的
// 文本、提示与上下文分段。纯函数，无 React 依赖，便于单测。

import { formatCompactTime, formatTokenCount } from '../format.js';

const SEP = ' · ';

/** DSH 的 TPS 语法：≥10 取整，否则保留一位小数。 */
export function formatTokensPerSecond(value) {
  const tps = Number(value);
  if (!Number.isFinite(tps) || tps <= 0) return '';
  return tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10);
}

/** 缓存命中百分比：后端已按一位小数取整，这里只去掉多余的 `.0`。 */
export function formatCacheHitPercent(value) {
  if (value === null || value === undefined || value === '') return '';
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '';
  return String(Math.round(percent * 10) / 10).replace(/\.0$/, '');
}

/** 统计提示里的时长：一分钟内用 `12.3s`，更长用 `2m42s`。 */
export function formatStatDuration(ms) {
  const seconds = Number(ms) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** 预填充成本：每 1k prompt token 的首 token 延迟，越小说明前缀复用越好。 */
export function formatPrefillCost(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return `${Math.round(ms * 100) / 100} ms/ktok`;
}

/**
 * 缓存上报覆盖率。
 *
 * 「缓存命中 0%」和「服务端根本没上报」在旧口径下长得一模一样：只要有一次请求报了 0，
 * 整个会话的百分比就成立。覆盖率把这两件事分开——分母是全部模型请求，包括那些连
 * usage 都没返回的。
 */
export function cacheCoverage(usage) {
  const reported = Math.max(0, Number(usage?.cacheReportedSteps) || 0);
  const total = Math.max(0, Number(usage?.cacheTotalSteps) || 0);
  if (total <= 0) return null;
  return { reported, total, complete: reported >= total };
}

/** 活动药丸：`3 轮 37 步 · 187 tok/s`；没有步数也没有速度时为空。 */
export function activityLabel(activity) {
  if (!activity) return '';
  const turns = Math.max(0, Number(activity.turns) || 0);
  const steps = Math.max(0, Number(activity.steps) || 0);
  const speed = formatTokensPerSecond(activity.tokensPerSecond);
  const counts = steps > 0 ? `${turns} 轮 ${steps} 步` : '';
  return [counts, speed ? `${speed} tok/s` : ''].filter(Boolean).join(SEP);
}

/** 活动悬停提示：只列出实际测到的时间，避免出现一排 0。 */
export function activityDetail(activity) {
  if (!activity) return '';
  const lines = [];
  const llmMs = Number(activity.llmMs) || 0;
  const toolMs = Number(activity.toolMs) || 0;
  const ttftMs = Number(activity.ttftMs) || 0;
  const ttftSteps = Number(activity.ttftSteps) || 0;
  const speed = formatTokensPerSecond(activity.tokensPerSecond);
  if (llmMs > 0) lines.push(`模型用时 ${formatStatDuration(llmMs)}`);
  if (toolMs > 0) lines.push(`工具调用用时 ${formatStatDuration(toolMs)}`);
  if (ttftSteps > 0 && ttftMs > 0) lines.push(`首 token 平均 ${formatStatDuration(ttftMs / ttftSteps)}`);
  // 服务端不上报缓存命中时，这是唯一能反映前缀复用的数字：命中时它会塌缩一个数量级。
  const prefill = formatPrefillCost(activity.prefillMsPerKTok);
  if (prefill) lines.push(`预填充成本 ${prefill}`);
  if (speed) lines.push(`输出速度 ${speed} tok/s`);
  return lines.join('\n');
}

/**
 * 用量药丸：`2.7M tok · 缓存命中 90%`；没有 token 时不渲染。
 *
 * 覆盖率不足时必须把样本量写出来：3/64 步上报算出的 0% 与 64/64 步算出的 0% 是
 * 完全不同的两件事，只显示百分比会让前者冒充后者。一次都没上报时显示「缓存未上报」
 * 而不是省略——省略会让「没测」被读成「没问题」。
 */
export function usageLabel(usage) {
  if (!usage) return '';
  const total = Math.max(0, Number(usage.totalTokens) || 0);
  if (total <= 0) return '';
  const totalLabel = `${formatTokenCount(total)} tok`;
  const cache = formatCacheHitPercent(usage.cacheHitPercent);
  if (!cache) {
    return usage.cacheHitPercent === null || usage.cacheHitPercent === undefined
      ? `${totalLabel}${SEP}缓存未上报`
      : totalLabel;
  }
  const coverage = cacheCoverage(usage);
  const sample = coverage && !coverage.complete ? `（${coverage.reported}/${coverage.total} 步）` : '';
  return `${totalLabel}${SEP}缓存命中 ${cache}%${sample}`;
}

/** 用量悬停提示：三个计费桶分开显示，缓存未知时省略缓存行，不伪造 0。 */
export function usageDetail(usage) {
  if (!usage) return '';
  const lines = [`未缓存输入 ${formatTokenCount(usage.uncachedInputTokens)} tok`];
  if (usage.cacheHitPercent !== null && usage.cacheHitPercent !== undefined) {
    lines.push(`缓存读取 ${formatTokenCount(usage.cacheReadTokens)} tok`);
  }
  const coverage = cacheCoverage(usage);
  if (coverage) lines.push(`缓存上报 ${coverage.reported}/${coverage.total} 步`);
  lines.push(`输出 ${formatTokenCount(usage.outputTokens)} tok`);
  return lines.join('\n');
}

/**
 * 上下文三分类：系统提示词 / 工具定义 / 对话消息。
 *
 * `width` 是占整个窗口的百分点（三段之和等于 `percent`），直接作为分段条的宽度；
 * 分类 token 为 0 时宽度为 0，但仍保留一行，面板结构不跳动。
 */
export function contextSegments(context) {
  const percent = Math.max(0, Math.min(100, Number(context?.percent) || 0));
  const breakdown = context?.breakdown || {};
  const rows = [
    { key: 'system', label: '系统提示词', tokens: Math.max(0, Number(breakdown.system) || 0) },
    { key: 'tools', label: '工具定义', tokens: Math.max(0, Number(breakdown.tools) || 0) },
    { key: 'messages', label: '对话消息', tokens: Math.max(0, Number(breakdown.messages) || 0) },
  ];
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows.map((row) => ({
    ...row,
    width: total > 0 ? (percent * row.tokens) / total : 0,
  }));
}

/** 上下文面板脚注：压缩时间与水位状态。 */
export function contextNote(context) {
  if (!context) return '';
  const parts = [];
  if (context.checkpoint?.createdAt) parts.push(`已压缩 ${formatCompactTime(context.checkpoint.createdAt)}`);
  if (context.hardExceeded) parts.push('已超过硬阈值');
  else if (context.softExceeded) parts.push('已超过软阈值');
  return parts.join(SEP);
}
