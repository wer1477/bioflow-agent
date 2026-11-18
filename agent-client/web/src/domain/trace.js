// Trace / message-flow 纯函数：把运行事件流构建成可渲染的 trace 项与消息片段。
// 无 React 依赖，保持纯函数可单测。

/**
 * 不进入对话流的后端自检事件。
 *
 * 这些行每轮开局必发、措辞固定、与其他轮次没有任何区别：一次三步的问答能铺出 8 行
 * `Run:` / `Context:` / `MCP connection status`，把真正的工具行挤到下面。用户要的是
 * "agent 做了什么"，不是"agent 自检通过了什么"。
 *
 * 判据写成**白名单**（藏谁要点名），不是黑名单：将来新增的 `loop_health` reason 默认
 * 可见。宁可多显示一条，也不要让"上下文被压缩了""响应被截断了"这类信号因为没被登记
 * 而静默消失。同族的异常因此仍然留在流里——`context_compaction_*`（历史真被改写，
 * 模型会忘事）、`model_response_truncated`、`repeated_tool_failure*`、
 * `context_hard_watermark_guard`、`checkpoint` 都不在下面这张表里。
 */
const HIDDEN_LOOP_REASONS = new Set([
  // 装配完历史算一次预算，永远是同一句话，且只描述"还没超"。
  'context_watermark_checked',
  // 每个模型请求一次；同一份数据在 composer 下的会话统计里已经有一份。
  'token_usage_observed',
  // 只是跨过软水位线，历史没动，压缩与否由 compaction 事件另说。
  'context_watermark_exceeded',
]);

/**
 * run 的第一条事件：`Agent: …; CoreTools: …; Skills: …; MCP: …; Workspace: …`
 * （backend 的 `formatRuntimeInfo`）。它只存在于事件流，不在 `message.content` 里。
 *
 * 认形状而不认位置：位置会随 resume / 重放变，而这行文案的骨架由后端一处拼装。
 */
function isRuntimeBanner(content) {
  const text = String(content || '');
  return text.startsWith('Agent: ') && text.includes('; CoreTools: ');
}

/**
 * 这行是否属于"后端自检"，不该出现在对话流里。
 *
 * `mcp_status` 只在**全部连上**时藏：有 server 连不上意味着某个工具缺失，那是解释
 * "它为什么不用那个工具"的唯一线索。`run_status` 全藏——它本来就只在直播态出现
 * （不在 `TRANSCRIPT_MIRRORED_EVENT_TYPES` 里，刷新即消失），藏掉反而是把直播与回放
 * 对齐；终态由折叠行/状态提示承担。
 */
export function isBackendStatusEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'run_status') return true;
  if (event.type === 'mcp_status') return !(event.failed?.length > 0);
  if (event.type === 'loop_health') return HIDDEN_LOOP_REASONS.has(event.reason);
  if (event.type === 'info') return isRuntimeBanner(event.content);
  return false;
}

/**
 * 一条直播事件会不会在对话流里产出一行可见内容。
 *
 * `buildMessageParts` 是渲染的唯一投影入口：被它丢弃的事件不会出现在界面上。
 * 「有没有东西可看」在占位行和渲染层必须是同一份判据，否则会出现两种口径：
 * 占位行以为有过程已经显示，或者过程已经显示但占位行还赖着不走。
 */
export function isVisibleLiveEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (isBackendStatusEvent(event)) return false;
  switch (event.type) {
    case 'info':
    case 'thinking':
      return Boolean(event.content);
    case 'plan_update':
      return Boolean(event.steps?.length);
    case 'planning_panel':
    case 'security_approval_request':
    case 'tool_call_start':
    case 'tool_call_result':
    case 'mcp_status':
    case 'workspace_artifact':
    case 'loop_health':
    case 'error':
      return true;
    default:
      // route_decision / role_switch / goal_round 等只被折叠进状态，
      // 不单独成行，所以也不该让占位行提前让位。
      return false;
  }
}

/** 事件流里是否已经有第一条可见过程行；等待态据此让位。 */
export function hasVisibleLiveContent(events = []) {
  return (Array.isArray(events) ? events : []).some(isVisibleLiveEvent);
}

/**
 * 这一轮是否已经走完——工具行停在「运行中」的唯一判据。
 *
 * 用户中断时客户端会立刻断开事件流，服务端随后补的占位结果再也送不到；读侧的历史
 * 事件流也一样：取消只落一条 `error`，没有对应的 `tool_call_result`。若按「没有结果
 * 就是还在跑」渲染，这张工具卡会一直扫光。判据只认真正的终态信号：失败事件，或一条
 * 终态 run_status；两者都没有，就说明工具确实还在执行。
 */
const SETTLED_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'error']);

function settledRunOutcome(events = []) {
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'error') return 'cancelled';
    if (event.type !== 'run_status' || !event.status) continue;
    if (!SETTLED_RUN_STATUSES.has(event.status)) continue;
    return event.status === 'completed' ? 'completed' : 'cancelled';
  }
  return '';
}

/**
 * 给没有结果的工具行收尾。
 *
 * 终态是 completed 时保留「已完成」（缺结果只可能是记录残缺）；其余终态标记成
 * cancelled——行停止扫描动画，但不会被误判成执行失败。
 */
function settlePendingTools(pendingTools, outcome) {
  if (!outcome) return;
  for (const queue of pendingTools.values()) {
    for (const item of queue) {
      item.status = outcome;
      item.statusLabel = outcome === 'completed' ? 'done' : 'stopped';
    }
    queue.length = 0;
  }
}

export function appendLiveNarration(events, content) {
  if (!content) return events;
  const next = events.slice();
  const last = next[next.length - 1];
  if (last?.type === 'info' && last.live) {
    next[next.length - 1] = { ...last, content: `${last.content || ''}${content}` };
  } else {
    next.push({ type: 'info', content, live: true });
  }
  return next;
}

export function discardLiveNarration(events, count) {
  if (!count) return events;
  const next = events.slice();
  const last = next[next.length - 1];
  if (last?.type !== 'info' || !last.live) return next;
  const content = String(last.content || '');
  const remaining = content.slice(0, Math.max(0, content.length - count));
  if (remaining) next[next.length - 1] = { ...last, content: remaining };
  else next.pop();
  return next;
}

/**
 * 直播侧的思维链 delta 合并。
 *
 * 与叙事同一套规则：连续 delta 合成一段，遇到别的类型就断开。读侧从 transcript 重建时
 * 本来就是「每个请求一段」，所以两边最终形状一致，渲染层只需要认识一种。
 *
 * 思维链**不参与** `discardLiveNarration`：被截断丢弃的是"没写完的答案"，而推理确实
 * 发生过，两侧都保留它。
 */
export function appendLiveThinking(events, content) {
  if (!content) return events;
  const next = events.slice();
  const last = next[next.length - 1];
  if (last?.type === 'thinking' && last.live) {
    next[next.length - 1] = { ...last, content: `${last.content || ''}${content}` };
  } else {
    next.push({ type: 'thinking', content, live: true });
  }
  return next;
}

export function findUnrenderedNarration(content = '', parts = []) {
  let remaining = String(content || '');
  for (const part of parts) {
    if (part.type !== 'text' || !part.content) continue;
    const index = remaining.indexOf(part.content);
    if (index < 0) continue;
    remaining = `${remaining.slice(0, index)}${remaining.slice(index + part.content.length)}`;
  }
  return remaining.trim();
}

/**
 * 工具调用的稳定标识：同一次 run 在 live 与持久化两侧算出同一个值。
 *
 * 后端事件里没有稳定的调用 id（tool_call_start / tool_call_result 只有
 * tool_name / arguments / result），身份只能从「该 run 内第几个 tool_call_start」
 * 派生。runId 两侧同源：live 取首个 run_status 事件，历史取
 * message.toolCalls.run.runId。
 *
 * 序号后面拼上工具名是有意的 fail-safe：审批被拒、或审批期间中断时，持久化会
 * 比 live 多出 tool_call_start，序号会整体错位——带上工具名后错位的 id 匹配
 * 不到任何一行，表现为「收起」，而不是「错误地展开另一个工具」。
 */
function toolCallId(runId, segment, ordinal, toolName, fallback) {
  if (!runId) return fallback;
  return `${runId}:${segment}:${ordinal}:${toolName}`;
}

/** live 事件流里的 runId：run_status 是运行时最先发出的事件，早于任何工具调用。 */
export function findRunId(events = []) {
  for (const event of events) {
    if (event?.type === 'run_status' && event.runId) return event.runId;
  }
  return '';
}

export function buildMessageParts(events = [], plan, namespace = 'trace', runId = '') {
  const parts = [];
  const pendingTools = new Map();
  let toolOrdinal = 0;
  let orphanResultOrdinal = 0;
  const securityDecisions = new Map(
    events
      .filter((event) => event?.type === 'security_approval_result' && event.approvalId)
      .map((event) => [event.approvalId, event.decision]),
  );
  if (plan?.steps?.length) {
    const item = planTraceItem(plan, `${namespace}-plan`);
    parts.push({ type: 'trace', key: item.key, item });
  }

  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') return;
    // 自检行与不产生可见行的事件在这里就出局：折叠边界、步数、渲染都只看得到
    // "agent 做了什么"。占位行复用同一道闸（见 isVisibleLiveEvent）。
    if (!isVisibleLiveEvent(event)) return;
    if (event.type === 'info' && event.content) {
      parts.push({ type: 'text', key: `${namespace}-info-${index}`, content: String(event.content) });
      return;
    }

    // 思维链是独立 part：它不属于 message.content，所以既不能当叙事渲染，也不能参与
    // findUnrenderedNarration 的相减（那里只看 type === 'text'）。
    if (event.type === 'thinking' && event.content) {
      parts.push({ type: 'thinking', key: `${namespace}-thinking-${index}`, content: String(event.content) });
      return;
    }

    if (event.type === 'plan_update' && event.steps?.length) {
      const item = planTraceItem(event, `${namespace}-plan-${index}`);
      parts.push({ type: 'trace', key: item.key, item });
      return;
    }

    if (event.type === 'planning_panel') {
      parts.push({ type: 'planning', key: `${namespace}-planning-${index}`, panel: event });
      return;
    }

    if (event.type === 'security_approval_request') {
      parts.push({
        type: 'security_approval',
        key: `${namespace}-security-approval-${index}`,
        request: { ...event, decision: securityDecisions.get(event.approvalId) || '' },
      });
      return;
    }

    if (event.type === 'tool_call_start') {
      const toolName = event.tool_name || 'tool';
      const key = `${namespace}-tool-${index}`;
      const item = {
        key,
        callId: toolCallId(runId, 'tool', toolOrdinal, toolName, key),
        kind: classifyToolKind(event),
        title: toolName,
        subtitle: toolSubtitle(event),
        status: 'running',
        statusLabel: 'running',
        input: event.arguments || {},
        output: null,
        raw: event,
      };
      toolOrdinal += 1;
      parts.push({ type: 'trace', key: item.key, item });
      const pendingKey = `${event.type}:${toolName}`;
      const queue = pendingTools.get(pendingKey) || [];
      queue.push(item);
      pendingTools.set(pendingKey, queue);
      return;
    }

    if (event.type === 'tool_call_result') {
      const queue = pendingTools.get(`tool_call_start:${event.tool_name}`) || [];
      const item = queue.shift();
      if (item) {
        item.kind = classifyToolKind(event, item.kind);
        item.status = 'completed';
        item.statusLabel = 'done';
        item.output = event.rawResult || event.result || event.observation || null;
        item.raw = { start: item.raw, result: event };
        return;
      }
      const fallbackKey = `${namespace}-tool-result-${index}`;
      const fallback = toolResultTraceItem(
        event,
        fallbackKey,
        toolCallId(runId, 'toolResult', orphanResultOrdinal, event.tool_name || 'tool', fallbackKey),
      );
      orphanResultOrdinal += 1;
      parts.push({ type: 'trace', key: fallback.key, item: fallback });
      return;
    }

    if (event.type === 'mcp_status') {
      const item = mcpStatusTraceItem(event, `${namespace}-mcp-${index}`);
      parts.push({ type: 'trace', key: item.key, item });
      return;
    }

    if (event.type === 'workspace_artifact' || event.type === 'loop_health' || event.type === 'run_status' || event.type === 'error') {
      const item = genericTraceItem(event, `${namespace}-event-${index}`);
      parts.push({ type: 'trace', key: item.key, item });
    }
  });
  settlePendingTools(pendingTools, settledRunOutcome(events));
  return parts;
}

export function planTraceItem(plan, key) {
  return {
    key,
    kind: 'plan',
    title: plan.title || 'Execution plan',
    subtitle: `${plan.steps.length} steps`,
    status: 'completed',
    statusLabel: 'done',
    input: plan,
    output: plan.steps.join('\n'),
    raw: plan,
  };
}

export function toolResultTraceItem(event, key, callId = key) {
  return {
    key,
    callId,
    kind: classifyToolKind(event),
    title: event.tool_name || 'tool result',
    subtitle: toolSubtitle(event),
    status: 'completed',
    statusLabel: 'done',
    input: null,
    output: event.rawResult || event.result || event.observation || null,
    raw: event,
  };
}

export function mcpStatusTraceItem(event, key) {
  return {
    key,
    kind: 'mcp',
    title: 'MCP connection status',
    subtitle: `connected=${event.connected?.length || 0}, failed=${event.failed?.length || 0}`,
    status: (event.failed?.length || 0) ? 'warning' : 'completed',
    statusLabel: (event.failed?.length || 0) ? 'warn' : 'done',
    input: null,
    output: event,
    raw: event,
  };
}

export function buildTraceItems(events = [], plan, namespace = 'trace', runId = '') {
  const items = [];
  if (plan?.steps?.length) {
    items.push({
      key: `${namespace}-plan`,
      kind: 'plan',
      title: plan.title || 'Execution plan',
      subtitle: `${plan.steps.length} steps`,
      status: 'completed',
      statusLabel: 'done',
      input: plan,
      output: plan.steps.join('\n'),
      raw: plan,
    });
  }

  const pendingTools = new Map();
  let toolOrdinal = 0;
  let orphanResultOrdinal = 0;
  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') return;
    // 与 buildMessageParts 同一道闸：两个投影入口不许分叉，否则直播与回放的行数不一样。
    if (!isVisibleLiveEvent(event)) return;
    if (event.type === 'plan_update' && event.steps?.length) {
      items.push({
        key: `${namespace}-plan-${index}`,
        kind: 'plan',
        title: event.title || 'Execution plan',
        subtitle: `${event.steps.length} steps`,
        status: 'completed',
        statusLabel: 'done',
        input: event,
        output: event.steps.join('\n'),
        raw: event,
      });
      return;
    }

    if (event.type === 'tool_call_start') {
      const toolName = event.tool_name || 'tool';
      const key = `${namespace}-tool-${index}`;
      const item = {
        key,
        callId: toolCallId(runId, 'tool', toolOrdinal, toolName, key),
        kind: classifyToolKind(event),
        title: toolName,
        subtitle: toolSubtitle(event),
        status: 'running',
        statusLabel: 'running',
        input: event.arguments || {},
        output: null,
        raw: event,
      };
      toolOrdinal += 1;
      items.push(item);
      const pendingKey = `${event.type}:${toolName}`;
      const queue = pendingTools.get(pendingKey) || [];
      queue.push(item);
      pendingTools.set(pendingKey, queue);
      return;
    }

    if (event.type === 'tool_call_result') {
      const queue = pendingTools.get(`tool_call_start:${event.tool_name}`) || [];
      const item = queue.shift();
      if (item) {
        item.kind = classifyToolKind(event, item.kind);
        item.status = 'completed';
        item.statusLabel = 'done';
        item.output = event.rawResult || event.result || event.observation || null;
        item.raw = { start: item.raw, result: event };
        return;
      }
      const fallbackKey = `${namespace}-tool-result-${index}`;
      items.push(toolResultTraceItem(
        event,
        fallbackKey,
        toolCallId(runId, 'toolResult', orphanResultOrdinal, event.tool_name || 'tool', fallbackKey),
      ));
      orphanResultOrdinal += 1;
      return;
    }

    if (event.type === 'mcp_status') {
      items.push({
        key: `${namespace}-mcp-${index}`,
        kind: 'mcp',
        title: 'MCP connection status',
        subtitle: `connected=${event.connected?.length || 0}, failed=${event.failed?.length || 0}`,
        status: (event.failed?.length || 0) ? 'warning' : 'completed',
        statusLabel: (event.failed?.length || 0) ? 'warn' : 'done',
        input: null,
        output: event,
        raw: event,
      });
      return;
    }

    if (event.type === 'workspace_artifact' || event.type === 'loop_health' || event.type === 'run_status' || event.type === 'error') {
      items.push(genericTraceItem(event, `${namespace}-event-${index}`));
    }
  });
  settlePendingTools(pendingTools, settledRunOutcome(events));
  return items;
}

export function genericTraceItem(event, key) {
  const runStatus = event.type === 'run_status' ? event.status : '';
  const failed = event.type === 'error' || runStatus === 'failed' || runStatus === 'cancelled';
  const running = Boolean(runStatus) && !['completed', 'failed', 'cancelled'].includes(runStatus);
  return {
    key,
    kind: event.type === 'workspace_artifact' ? 'artifact' : 'runtime',
    title: eventTitle(event),
    subtitle: eventSubtitle(event),
    status: failed ? 'failed' : running ? 'running' : 'completed',
    statusLabel: failed ? (runStatus || 'error') : running ? runStatus : 'done',
    input: null,
    output: event,
    raw: event,
  };
}

export function classifyToolKind(event, fallback = 'tool') {
  const toolName = String(event?.tool_name || '').toLowerCase();
  const args = event?.arguments || {};
  const loaded = event?.observation?.loadedCapability || {};
  // toolload reports which capability it loaded; the reported kind wins over the tool name.
  if (loaded.kind === 'skill') return 'skill';
  if (loaded.kind === 'coretool' || loaded.kind === 'mcp') return loaded.kind;
  if (toolName === 'toollibrary') return 'coretool';
  if (toolName === 'toolload') {
    if (String(args.resource || '').trim()) return 'mcp';
    return String(args.id || '').includes('__') ? 'mcp' : 'skill';
  }
  if (toolName === 'knowledgebase') return 'knowledge';
  if (toolName.startsWith('mcp') || toolName.includes('__')) return 'mcp';
  if (toolName.includes('skill')) return 'skill';
  return fallback;
}

export function toolSubtitle(event) {
  const parts = [];
  if (event.arguments?.name) parts.push(String(event.arguments.name));
  if (event.arguments?.id) parts.push(String(event.arguments.id));
  if (event.arguments?.kind) parts.push(String(event.arguments.kind));
  return parts.join(' · ') || capabilityLabel(classifyToolKind(event));
}

export function eventTitle(event) {
  if (event.type === 'workspace_artifact') return `Artifact: ${event.artifact?.title || event.artifact?.path || ''}`;
  if (event.type === 'loop_health') return `Context: ${event.reason || ''}`;
  if (event.type === 'run_status') return `Run: ${event.status || 'unknown'}`;
  if (event.type === 'error') return 'Runtime error';
  return event.type || 'Runtime event';
}

export function eventSubtitle(event) {
  if (event.type === 'workspace_artifact') return event.artifact?.path || '';
  if (event.type === 'loop_health') return event.detail || '';
  if (event.type === 'run_status') return event.stopReason || '';
  if (event.type === 'error') return event.error || '';
  return '';
}

export function capabilityLabel(kind) {
  return ({
    coretool: 'CoreTool',
    mcp: 'MCP',
    skill: 'Skill',
    knowledge: 'Knowledge',
    artifact: 'Workspace',
    plan: 'Plan',
    runtime: 'Runtime',
  })[kind] || 'Tool';
}
