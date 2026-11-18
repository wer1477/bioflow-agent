import { useCallback, useEffect, useState } from 'react';
import { fetchAuthMode, fetchMe, logout as logoutRequest } from '../auth/client.js';
import { AuthView } from '../components/auth/AuthView.jsx';
import { ChangePasswordDialog } from '../components/auth/ChangePasswordDialog.jsx';
import { FeedbackDialog } from '../components/layout/FeedbackDialog.jsx';
import { App } from './App.jsx';
import { navigate, useRoute } from './router.js';

const AUTH_ROUTES = new Set(['login', 'register', 'forgot']);

/**
 * 应用的鉴权外壳：
 *
 * - `BIOFLOW_AUTH_ENABLED` 关闭（开发实例）时，`/api/auth/mode` 返回 `{enabled:false}`，
 *   这里直接渲染原来的 App，界面与行为完全不变。
 * - 打开时先解析会话；未登录进入登录/注册/找回页，任何受保护 API 返回 401 都会
 *   触发 `bioflow:auth-expired` 事件，把用户送回登录页。
 */
export function Root() {
  const route = useRoute();
  const [auth, setAuth] = useState({ loading: true, enabled: false, user: null, error: null });
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mode = await fetchAuthMode();
        if (!mode?.enabled) {
          if (!cancelled) setAuth({ loading: false, enabled: false, user: null, error: null });
          return;
        }
        const me = await fetchMe();
        if (!cancelled) setAuth({ loading: false, enabled: true, user: me.user, error: null });
      } catch (error) {
        if (cancelled) return;
        if (error?.status === 401) {
          setAuth({ loading: false, enabled: true, user: null, error: null });
          return;
        }
        if (error?.status === 404) {
          // 老后端没有 /api/auth/mode：按「未启用鉴权」处理，开发实例不会被登录页挡住。
          setAuth({ loading: false, enabled: false, user: null, error: null });
          return;
        }
        setAuth({
          loading: false,
          enabled: false,
          user: null,
          error: error instanceof Error ? error.message : '无法连接服务',
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onExpired = () => setAuth((previous) => (previous.user ? { ...previous, user: null } : previous));
    window.addEventListener('bioflow:auth-expired', onExpired);
    return () => window.removeEventListener('bioflow:auth-expired', onExpired);
  }, []);

  // URL 是登录状态的镜像：未登录只允许认证路由，登录后认证路由回到项目页。
  useEffect(() => {
    if (auth.loading || !auth.enabled) return;
    if (!auth.user && !AUTH_ROUTES.has(route.name)) navigate({ name: 'login' });
    if (auth.user && AUTH_ROUTES.has(route.name)) navigate({ name: 'projects' });
  }, [auth, route.name]);

  const handleAuthenticated = useCallback((user) => {
    setAuth({ loading: false, enabled: true, user, error: null });
    navigate({ name: 'projects' });
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // 会话已过期时登出请求也会 401；对用户来说结果相同。
    }
    setAuth((previous) => ({ ...previous, user: null }));
    navigate({ name: 'login' });
  }, []);

  if (auth.loading) {
    return (
      <div className="auth-shell auth-shell-centered">
        <p className="auth-loading">正在连接 Bioflow…</p>
      </div>
    );
  }

  if (auth.error) {
    return (
      <div className="auth-shell auth-shell-centered">
        <div className="auth-card auth-error-card" role="alert">
          <h1>无法连接服务</h1>
          <p>{auth.error}</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>重试</button>
        </div>
      </div>
    );
  }

  const account = {
    enabled: auth.enabled,
    user: auth.user,
    onLogout: handleLogout,
    onChangePassword: () => setChangePasswordOpen(true),
    onFeedback: () => setFeedbackOpen(true),
  };

  // 反馈只属于登录态：开发实例不渲染弹窗，也不在账户菜单里生成入口。
  if (!auth.enabled) return <App account={account} />;
  if (!auth.user) {
    return (
      <AuthView
        route={route.name}
        onNavigate={navigate}
        onAuthenticated={handleAuthenticated}
      />
    );
  }
  return (
    <>
      <App account={account} />
      <ChangePasswordDialog open={changePasswordOpen} onClose={() => setChangePasswordOpen(false)} />
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} user={auth.user} />
    </>
  );
}
