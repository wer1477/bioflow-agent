import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiJson, notifyAuthExpired, readNdjson } from '../api.js';
import { navigate } from '../app/router.js';
import { mergeRunningIds } from '../domain/activity_view.js';
import { appendLiveNarration, appendLiveThinking, discardLiveNarration } from '../domain/trace.js';
import { resolveMessageDisposition } from '../domain/conversation_run_state.js';
import { applyRunStatus, isRunActive, removeRunState } from '../domain/run_lifecycle_state.js';
import { claimNextQueuedMessage } from '../domain/queue_scheduler.js';

/** 服务端拒绝并发 run 后，排队消息的退避间隔；活动快照每 2s 刷新一次，别更密。 */
const BUSY_RETRY_DELAY_MS = 2500;

/**
 * 等 run 落到终态的轮询节奏。
 *
 * 用户按下终止后客户端会立刻断开事件流，服务端要等当前工具/模型调用退出来才写终态
 * （可能是几十秒）。只查一次必有竞态：查到的往往还是 tool_execution，于是侧栏运行圈、
 * 输入框的终止按钮和工具行的扫描动画一起卡住——之后再也没有人把终态送回来。
 * 上限是兜底：真等不到也不能把 UI 永远钉在「运行中」。
 */
const RUN_SETTLE_POLL_MS = 1000;
const RUN_SETTLE_MAX_WAIT_MS = 60_000;
const NO_EXTERNAL_RUNS = new Set();

export function useRun({
  currentConversationId,
  projectKey = '',
  selectedAgentId,
  // 团队根走 /team/runs：由后端决定哪个角色回答；角色会话仍然走普通 /runs。
  teamMode = false,
  // 后端活动快照里的运行中会话：别的视图、团队运行、角色会话与委派子 Agent 发起的 run
  // 都不在本页的 runStates 里，但同样会占住这个会话。
  externalRunningIds = NO_EXTERNAL_RUNS,
  selectConversation,
  loadConversations,
  refreshStats,
  refreshWorkspace,
  selectedConversationIdRef,
  messageListShouldStickRef,
  setCurrentConversation,
  setMessages,
  // 本轮由哪个角色回答（团队路由事件）：让输入框的模型标签跟着角色走。
  onTeamRoute,
}) {
  const [runStates, setRunStates] = useState(() => new Map());
  const [completedConversationIds, setCompletedConversationIds] = useState(() => new Set());
  const [liveEvents, setLiveEvents] = useState([]);
  const [queuedMessages, setQueuedMessages] = useState([]);
  const [resumeAfterAbort, setResumeAfterAbort] = useState(null);
  const runHandlesRef = useRef(new Map());
  const liveEventsBuffersRef = useRef(new Map());
  const claimedQueuedConversationIdsRef = useRef(new Set());
  const queuedMessageSequenceRef = useRef(0);
  // 本页自己发起的 run：只有这些能终止，也只有它们在流式渲染。
  const localRunningIds = useMemo(() => new Set(
    [...runStates].filter(([, state]) => isRunActive(state)).map(([conversationId]) => conversationId),
  ), [runStates]);
  // 会话是否被占住 = 本页的 run ∪ 后端活动。
  const runningConversationIds = useMemo(
    () => mergeRunningIds(localRunningIds, externalRunningIds),
    [localRunningIds, externalRunningIds],
  );
  const running = resolveMessageDisposition(localRunningIds, currentConversationId) === 'queue';
  // 本轮开始等待的时刻：等待行的 elapsed 用它起算，切换会话再回来也仍是真实值。
  const runStartedAt = useMemo(
    () => (currentConversationId ? (runStates.get(currentConversationId)?.startedAt || 0) : 0),
    [currentConversationId, runStates],
  );
  // 本页 run state 的最新状态。切走再切回时直播事件已被清空，等待行只能靠它说明卡在哪一步。
  const runStatus = currentConversationId ? (runStates.get(currentConversationId)?.status || '') : '';
  // 忙但不在本页跑：只能排队，终止按钮不该出现（没有可终止的本地流）。
  const busy = resolveMessageDisposition(runningConversationIds, currentConversationId) === 'queue';

  // NDJSON 事件批量渲染：事件先进 buffer，由 50ms 定时器 flush 到 state，
  // 避免高频率事件（尤其 content chunk）触发整树重渲染。
  const flushLiveEvents = useCallback((conversationId) => {
    const buffered = liveEventsBuffersRef.current.get(conversationId) || [];
    if (!buffered.length) return;
    liveEventsBuffersRef.current.delete(conversationId);
    if (selectedConversationIdRef.current !== conversationId) return;
    setLiveEvents((rows) => {
      let next = rows;
      for (const event of buffered) {
        if (event.type === 'content') {
          next = appendLiveNarration(next, event.content);
        } else if (event.type === 'thinking') {
          next = appendLiveThinking(next, event.content);
        } else if (event.type === 'loop_health' && event.reason === 'model_response_truncated') {
          next = discardLiveNarration(next, Number(event.discardedContentChars || 0));
          next = [...next, event];
        } else {
          next = [...next, event];
        }
      }
      return next;
    });
  }, []);

  const recordRunStatus = useCallback((conversationId, status) => {
    setRunStates((states) => applyRunStatus(states, conversationId, status, Date.now()));
    if (isRunActive(status)) {
      setCompletedConversationIds((ids) => {
        if (!ids.has(conversationId)) return ids;
        const next = new Set(ids);
        next.delete(conversationId);
        return next;
      });
    } else if (status.status === 'completed' && selectedConversationIdRef.current !== conversationId) {
      setCompletedConversationIds((ids) => new Set([...ids, conversationId]));
    }
  }, [selectedConversationIdRef]);

  /**
   * 等这一轮真正走到终态。
   *
   * 只查一次不够（见 RUN_SETTLE_POLL_MS）：查到的中间态不能写回本地，否则会盖掉
   * 「用户已终止」之后已经清掉的运行态。`isCurrentRun` 挡住另一种情况——排队消息
   * 已经在新一轮里接管了这个会话，旧 run 的终态不该再写回视图。
   */
  const reconcileRun = useCallback(async (conversationId, runId, isCurrentRun = () => true) => {
    if (!conversationId || !runId) return;
    const deadline = Date.now() + RUN_SETTLE_MAX_WAIT_MS;
    for (;;) {
      if (!isCurrentRun()) return;
      try {
        const data = await apiJson(`/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}`);
        const run = data?.run;
        if (run?.status && !isRunActive(run)) {
          if (isCurrentRun()) recordRunStatus(conversationId, run);
          return;
        }
      } catch (error) {
        // 404 = run 已经不在了（会话被删、后端重启），没有可等的终态；其余错误继续重试。
        if (error?.status === 404) return;
      }
      if (Date.now() >= deadline) {
        if (isCurrentRun()) setRunStates((states) => removeRunState(states, conversationId));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RUN_SETTLE_POLL_MS));
    }
  }, [recordRunStatus]);

  const enqueueMessage = useCallback(({ conversationId, message, agentId, notBefore = 0 }) => {
    if (!conversationId || !message) return;
    const id = globalThis.crypto?.randomUUID?.() || `queued-${Date.now()}-${queuedMessageSequenceRef.current++}`;
    setQueuedMessages((rows) => [...rows, { id, conversationId, message, agentId, notBefore }]);
  }, []);

  const startRun = useCallback(async (message, agentId = selectedAgentId, requestedConversationId = currentConversationId) => {
    let conversationId = requestedConversationId;
    // 没有项目就没有工作目录：会话必须先归属一个项目，这里直接不启动。
    if (!conversationId && !projectKey) return;
    if (!conversationId) {
      const created = await apiJson('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'New conversation', project: projectKey }),
      });
      conversationId = created.conversation.id;
      setCurrentConversation(created.conversation);
      selectedConversationIdRef.current = conversationId;
      // 地址栏跟随新会话，刷新/前进后退不会丢掉它。
      navigate({ name: 'session', projectKey, sessionId: conversationId });
      await loadConversations();
    }

    recordRunStatus(conversationId, { runId: '', status: 'starting' });
    setCompletedConversationIds((ids) => {
      if (!ids.has(conversationId)) return ids;
      const next = new Set(ids);
      next.delete(conversationId);
      return next;
    });
    messageListShouldStickRef.current = true;
    const controller = new AbortController();
    runHandlesRef.current.set(conversationId, { controller, runId: '' });
    // 乐观回显的行要能取回：服务端拒绝时把它撤掉，改成排队（不能让用户看见一条没发出去的消息）。
    const optimisticRow = { role: 'user', content: message, toolCalls: null };
    if (selectedConversationIdRef.current === conversationId) {
      setMessages((rows) => [...rows, optimisticRow]);
      setLiveEvents([]);
    }
    const flushTimer = setInterval(() => flushLiveEvents(conversationId), 50);

    try {
      const runUrl = teamMode
        ? `/api/conversations/${encodeURIComponent(conversationId)}/team/runs`
        : `/api/conversations/${encodeURIComponent(conversationId)}/runs`;
      const response = await fetch(runUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(teamMode ? { message } : { message, agentId }),
        signal: controller.signal,
      });
      // 会话过期时 run 的 fetch 不经过 apiJson，也要广播一次登录失效。
      if (response.status === 401) notifyAuthExpired(401);
      // 会话被别人占用（团队正在这个角色会话里回答，或刚发起的 run 还没进活动快照）：
      // 不把 409 甩给用户，改成排队，等占用结束后由 queue pump 自动发出去。
      if (response.status === 409) {
        setMessages((rows) => rows.filter((row) => row !== optimisticRow));
        enqueueMessage({ conversationId, message, agentId, notBefore: Date.now() + BUSY_RETRY_DELAY_MS });
        return;
      }
      if (!response.ok || !response.body) throw new Error(await response.text());
      await readNdjson(response.body, (eventData) => {
        if (eventData.type === 'run_status') {
          const handle = runHandlesRef.current.get(conversationId);
          if (eventData.runId && handle?.controller === controller) handle.runId = eventData.runId;
          recordRunStatus(conversationId, eventData);
        }
        // 团队根的一轮可能先路由再换手：把最新的角色报给外层，输入框的模型标签跟着换。
        if (eventData.type === 'route_decision' || eventData.type === 'role_switch') {
          const routedRoleId = eventData.roleId || eventData.toRoleId;
          if (routedRoleId) onTeamRoute?.(routedRoleId);
        }
        if (selectedConversationIdRef.current === conversationId && eventData.type !== 'done') {
          const buffered = liveEventsBuffersRef.current.get(conversationId) || [];
          buffered.push(eventData);
          liveEventsBuffersRef.current.set(conversationId, buffered);
        }
        if (eventData.type !== 'content' && selectedConversationIdRef.current === conversationId) {
          refreshWorkspace({ debounce: true }).catch(console.error);
        }
      });
    } catch (err) {
      if (selectedConversationIdRef.current === conversationId) {
        const aborted = err?.name === 'AbortError';
        setLiveEvents((rows) => [
          ...rows,
          // 事件流一断就不会再有 run_status。补一条终态，让还在「运行中」的工具行
          // 立刻收尾；run_status 本身不渲染，只作为投影的结束信号。
          ...(aborted
            ? [{ type: 'run_status', runId: runHandlesRef.current.get(conversationId)?.runId || '', status: 'cancelled' }]
            : []),
          aborted
            ? 'stopped: 用户已终止执行'
            : `error: ${err instanceof Error ? err.message : String(err)}`,
        ]);
      }
    } finally {
      clearInterval(flushTimer);
      flushLiveEvents(conversationId);
      // 这一轮是否还是这个会话的「当前 run」：排队消息可能在等待期间已经接管了会话，
      // 那时旧 run 的终态与刷新都不能再写回视图。
      const ownsRun = () => runHandlesRef.current.get(conversationId)?.controller === controller;
      const handle = runHandlesRef.current.get(conversationId);
      const runId = handle?.controller === controller ? handle.runId : '';
      if (runId) {
        await reconcileRun(conversationId, runId, ownsRun).catch(console.error);
      } else if (ownsRun()) {
        setRunStates((states) => removeRunState(states, conversationId));
      }
      if (selectedConversationIdRef.current === conversationId && ownsRun()) {
        await selectConversation(conversationId).catch(console.error);
        await refreshStats().catch(console.error);
        await refreshWorkspace().catch(console.error);
      }
      await loadConversations().catch(console.error);
      if (ownsRun()) runHandlesRef.current.delete(conversationId);
    }
  }, [currentConversationId, enqueueMessage, flushLiveEvents, loadConversations, messageListShouldStickRef, onTeamRoute, reconcileRun, recordRunStatus, refreshStats, refreshWorkspace, selectConversation, selectedAgentId, selectedConversationIdRef, setCurrentConversation, setMessages, teamMode]);

  const runQueued = useCallback(async () => {
    if (resumeAfterAbort || queuedMessages.length === 0) return;
    const claim = claimNextQueuedMessage(
      queuedMessages,
      runningConversationIds,
      claimedQueuedConversationIdsRef.current,
    );
    if (!claim) return;
    setQueuedMessages((rows) => rows.filter((item) => item.id !== claim.item.id));
    try {
      await startRun(claim.item.message, claim.item.agentId, claim.item.conversationId);
    } finally {
      claimedQueuedConversationIdsRef.current.delete(claim.item.conversationId);
      // The previous effect may have observed the claim before it was released.
      // Refresh the queue identity so the next item is pumped after this run settles.
      setQueuedMessages((rows) => rows.slice());
    }
  }, [queuedMessages, resumeAfterAbort, runningConversationIds, startRun]);

  useEffect(() => {
    runQueued().catch(console.error);
  }, [runQueued]);

  const stopCurrentRun = useCallback(async () => {
    const conversationId = currentConversationId;
    const handle = conversationId ? runHandlesRef.current.get(conversationId) : null;
    const runId = handle?.runId;
    if (conversationId) {
      // 按下终止就把这一轮从「运行中」摘掉：cancel 要等服务端在下一个事件边界才生效，
      // 这几秒里侧栏还在转、输入框还是终止按钮，用户会以为根本没停下来。真正的终态
      // 由 startRun 的 finally 轮询补回（可能把状态纠正成 completed）。
      recordRunStatus(conversationId, { runId: runId || '', status: 'cancelled', stopReason: 'cancelled' });
    }
    if (conversationId && runId) {
      apiJson(`/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
      }).catch(console.error);
    }
    handle?.controller.abort();
  }, [currentConversationId, recordRunStatus]);

  const respondSecurityApproval = useCallback(async (request, decision) => {
    const conversationId = currentConversationId;
    const runId = request?.runId || (currentConversationId ? runHandlesRef.current.get(currentConversationId)?.runId : '');
    if (!conversationId || !runId || !request?.approvalId) throw new Error('Approval request is no longer active.');
    await apiJson(`/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/security-approvals/${encodeURIComponent(request.approvalId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
  }, [currentConversationId]);

  const removeCompleted = useCallback((id) => {
    setCompletedConversationIds((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  }, []);

  const resetForConversationSwitch = useCallback(() => {
    liveEventsBuffersRef.current.clear();
    setLiveEvents([]);
  }, []);

  return {
    running,
    busy,
    runStartedAt,
    runStatus,
    runStates,
    runningConversationIds,
    completedConversationIds,
    setCompletedConversationIds,
    liveEvents,
    setLiveEvents,
    queuedMessages,
    enqueueMessage,
    resumeAfterAbort,
    setResumeAfterAbort,
    startRun,
    stopCurrentRun,
    runQueued,
    respondSecurityApproval,
    removeCompleted,
    resetForConversationSwitch,
  };
}
