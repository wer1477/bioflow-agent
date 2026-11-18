import { useCallback, useState } from 'react';
import { toggleToolExpansion } from '../domain/tool_expansion.js';

const NOTHING_EXPANDED = new Set();

/**
 * 工具行的展开集合：一条会话内共享（多个工具可以同时展开），切换会话即重置。
 *
 * 不持久化——刷新页面后所有工具回到折叠态。重置用会话 id 在渲染期比对完成，
 * 而不是 useEffect：effect 会先提交一帧仍带着上一个会话展开态的 DOM，随后才收起。
 */
export function useToolExpansion(conversationId) {
  const [state, setState] = useState(() => ({ conversationId, ids: NOTHING_EXPANDED }));
  const expandedIds = state.conversationId === conversationId ? state.ids : NOTHING_EXPANDED;
  if (state.conversationId !== conversationId) {
    setState({ conversationId, ids: NOTHING_EXPANDED });
  }

  const toggle = useCallback((id) => {
    setState((current) => ({ ...current, ids: toggleToolExpansion(current.ids, id) }));
  }, []);

  return { expandedIds, toggle };
}
