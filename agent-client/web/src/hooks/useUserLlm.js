import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../api.js';

/**
 * 普通用户的 LLM 配置（系统预置 + 自己的 provider + 角色绑定）。
 *
 * 只在登录鉴权启用且当前用户不是管理员时请求；管理员用全局配置接口，
 * 开发实例没有登录，也不会请求 `/api/me/llm`。
 */
export function useUserLlm(account) {
  const enabled = Boolean(account?.enabled && account?.user && account.user.role !== 'admin');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!enabled) {
      setData(null);
      return null;
    }
    setLoading(true);
    try {
      const next = await apiJson('/api/me/llm');
      setData(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  return { enabled, data, loading, reload, apply: setData };
}
