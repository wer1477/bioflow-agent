import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '../api.js';

/**
 * 会话统计探针：一次请求同时取回活动、token 用量与上下文占用。
 *
 * 与旧 `/context-budget` 刷新保持同样的节奏——debounce 由调用方声明，内部用请求序号
 * 丢弃过期响应，切换会话时不会把上一个会话的数字写进当前视图。
 */
export function useConversationStats({ currentConversationId, selectedAgentId }) {
  const [stats, setStats] = useState(null);
  const timerRef = useRef(null);
  const requestRef = useRef(0);

  const refreshStats = useCallback(async ({ debounce = false } = {}) => {
    if (debounce) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        refreshStats().catch(console.error);
      }, 300);
      return;
    }
    if (!currentConversationId) {
      setStats(null);
      return;
    }
    const requestId = ++requestRef.current;
    const params = new URLSearchParams();
    if (selectedAgentId) params.set('agentId', selectedAgentId);
    const query = params.toString();
    try {
      const data = await apiJson(
        `/api/conversations/${encodeURIComponent(currentConversationId)}/stats${query ? `?${query}` : ''}`,
      );
      if (requestId === requestRef.current) setStats(data);
    } catch (err) {
      if (requestId === requestRef.current) {
        setStats({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [currentConversationId, selectedAgentId]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 切换会话先清空。请求序号能挡住迟到的响应，但挡不住上一轮的号码在新会话的输入框下面
  // 停留一拍——那正是"统计看起来不对"的来由：数字属于别人，却出现在这里。
  useEffect(() => {
    setStats(null);
  }, [currentConversationId]);

  return { stats, refreshStats };
}
