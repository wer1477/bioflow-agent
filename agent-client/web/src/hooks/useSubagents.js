import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '../api.js';

const POLL_INTERVAL_MS = 2000;

/**
 * 父会话的委派清单。
 *
 * 两个时机需要刷新：
 * 1. 父 run 还在跑——子 Agent 可能随时被创建或结束，标题右侧的计数必须跟上。
 * 2. 任一子会话还在跑——即使父 run 已结束（异步委派的常态），状态点也要变。
 * 另外都不满足时不轮询：静止的父会话只在切换进来时拉一次。
 */
export function useSubagents(parentConversationId, { parentRunning = false } = {}) {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ total: 0, running: 0 });
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const wasParentRunningRef = useRef(parentRunning);

  const load = useCallback(async () => {
    if (!parentConversationId) {
      setRows([]);
      setCounts({ total: 0, running: 0 });
      return [];
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const data = await apiJson(`/api/conversations/${encodeURIComponent(parentConversationId)}/subagents`);
      // 切会话后回来的旧响应不能写进当前视图。
      if (requestId !== requestRef.current) return [];
      const nextRows = Array.isArray(data?.subagents) ? data.subagents : [];
      setRows(nextRows);
      setCounts({
        total: Number(data?.total) || nextRows.length,
        running: Number(data?.running) || nextRows.filter((row) => row?.status === 'running').length,
      });
      return nextRows;
    } catch {
      // 父会话可能是子会话的父级但已被删除：入口消失即可，不要把错误抛到聊天界面。
      if (requestId === requestRef.current) {
        setRows([]);
        setCounts({ total: 0, running: 0 });
      }
      return [];
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [parentConversationId]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  // 父 run 在跑时子 Agent 可能刚被创建；任一跳子会话在跑时状态点会变。
  useEffect(() => {
    if (!parentConversationId || (!parentRunning && counts.running === 0)) return undefined;
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [counts.running, load, parentConversationId, parentRunning]);

  // run 结束再补一次：轮询刚被关掉，最后一次创建/完成可能还没进视图。
  useEffect(() => {
    const wasRunning = wasParentRunningRef.current;
    wasParentRunningRef.current = parentRunning;
    if (!wasRunning || parentRunning || !parentConversationId) return;
    load().catch(() => undefined);
  }, [load, parentConversationId, parentRunning]);

  return { rows, total: counts.total, running: counts.running, loading, refresh: load };
}
