// 本轮「第一条过程行出现之前」的等待态：纯逻辑，供 ChatView 决定是否渲染占位行。
// 只陈述后端真实发出的 run_status，不猜测进度或剩余时间。

import { hasVisibleLiveContent } from './trace.js';

/**
 * 后端 `run_status.status` → 等待行文案。
 *
 * `sending` 不是后端状态，而是「请求已发出、还没收到任何 run_status」的那一小段。
 * POST 在途与服务器受理之间可能只有几百毫秒，但网络慢时用户同样需要看到反馈，
 * 所以它单独成档，而不是直接复用 building_context 的文案。
 */
const PHASE_LABELS = {
  sending: '正在发送…',
  building_context: '已发送 · 准备上下文…',
  model_turn: '等待模型响应…',
  tool_execution: '正在执行工具…',
};

const TEAM_DISPATCH_LABEL = '正在分派给团队成员…';
const WORKING_LABEL = '正在运行…';

/** 事件流里最后一个 run_status 的 status；没有则空串。 */
export function latestRunStatus(events = []) {
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type === 'run_status' && event.status) return String(event.status);
  }
  return '';
}

/**
 * 当前是否该渲染等待行。
 *
 * @param {object} input
 * @param {boolean} input.running 本页发起的这一轮是否还在跑（不是「会话被占用」）。
 * @param {Array} input.events 直播事件流。
 * @param {boolean|null} [input.visible] 调用方已知的可见性；省略时按事件流派生。
 *   传 `false` 表示调用方已经确认没有可见行（例如 `buildMessageParts` 为空）。
 * @param {boolean} [input.teamMode] 团队根会话：拿到第一个 run_status 之前先在分派角色。
 * @param {string} [input.status] 本页 run state 里的最新状态；直播事件被清空时（切走再切回）
 *   它是唯一还能说明「卡在哪一步」的来源。
 * @returns {{ phase: string, label: string } | null}
 */
export function resolvePendingTurn({ running, events = [], visible = null, teamMode = false, status = '' } = {}) {
  if (!running) return null;
  if (visible === true || (visible !== false && hasVisibleLiveContent(events))) return null;
  const latest = latestRunStatus(events) || String(status || '');
  if (!latest || latest === 'starting') {
    return {
      phase: 'sending',
      label: teamMode ? TEAM_DISPATCH_LABEL : PHASE_LABELS.sending,
    };
  }
  return { phase: latest, label: PHASE_LABELS[latest] || WORKING_LABEL };
}
