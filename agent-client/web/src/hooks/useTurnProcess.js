import { useCallback, useState } from 'react';

const NOTHING = new Map();

/**
 * 整轮过程的手动开合记忆：一条会话内共享，切换会话即重置。
 *
 * 键是 assistant 消息 id。重新跑同一个任务会产生**新的消息 id**，消息一旦完成内容也
 * 不再变，所以旧记录天然失配，不需要额外追踪 run 代次。
 *
 * 不持久化——刷新页面后所有轮次回到默认折叠态（与 useToolExpansion 一致）。
 * 重置用会话 id 在渲染期比对完成，而不是 useEffect：effect 会先提交一帧仍带着上一个
 * 会话开合态的 DOM，随后才收起。
 */
export function useTurnProcess(conversationId) {
  const [state, setState] = useState(() => ({ conversationId, overrides: NOTHING }));
  const overrides = state.conversationId === conversationId ? state.overrides : NOTHING;
  if (state.conversationId !== conversationId) {
    setState({ conversationId, overrides: NOTHING });
  }

  const setOpen = useCallback((messageId, open) => {
    if (!messageId) return;
    setState((current) => {
      const next = new Map(current.overrides);
      next.set(messageId, Boolean(open));
      return { ...current, overrides: next };
    });
  }, []);

  return { overrides, setOpen };
}
