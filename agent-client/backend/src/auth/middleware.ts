import type { NextFunction, Request, RequestHandler, Response } from 'express';
import path from 'node:path';
import type { AuthConfig } from './config.js';
import type { AuthService } from './service.js';
import { clearSessionCookie, readCookie, setSessionCookie } from './cookies.js';
import { WORKSPACE_ROOT, ensureStateRoots } from '../paths.js';
import { runInWorkspaceScope } from '../workspace_scope.js';

/** 匿名可访问的 API：健康检查、登录/注册/找回本身。 */
const ANONYMOUS_API_PATHS = new Set([
  '/api/health',
  '/api/auth/mode',
  '/api/auth/code',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/password/forgot',
  '/api/auth/password/reset',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 已经建过内部目录的用户根，避免每个请求都 mkdir。 */
const preparedWorkspaceRoots = new Set<string>();

/**
 * 部署版每个用户独占 `WORKSPACE_ROOT/users/<userId>/`：
 * 会话、项目、回收站、上传都在这个根下，开发实例（鉴权关闭）不进入这里。
 */
export function userWorkspaceRoot(userId: string): string {
  return path.join(WORKSPACE_ROOT, 'users', userId);
}

function prepareUserWorkspace(userId: string): string {
  const root = userWorkspaceRoot(userId);
  if (!preparedWorkspaceRoots.has(root)) {
    ensureStateRoots(root);
    preparedWorkspaceRoots.add(root);
  }
  return root;
}

/**
 * 部署版的统一鉴权入口：挂载在根路径，只拦截 `/api/*`。
 *
 * - 静态资源与 SPA 必须匿名可加载，否则登录页本身打不开。
 * - 未登录访问受保护 API 一律 401，由前端跳到登录页。
 * - 非安全方法校验同源 Origin，配合 SameSite=Lax 挡住 CSRF。
 */
export function createAuthMiddleware(service: AuthService, config: AuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith('/api')) {
      next();
      return;
    }

    if (!SAFE_METHODS.has(req.method) && !isSameOrigin(req)) {
      res.status(403).json({ error: '跨站请求被拒绝。' });
      return;
    }

    const token = readCookie(req.headers.cookie, config.cookieName);
    if (token) {
      const session = service.getSession(token);
      if (session) {
        req.authUser = session.user;
        req.authSessionId = session.sessionId;
        if (session.extended) {
          setSessionCookie(res, config, token, session.maxAgeSeconds);
        }
        // 下游所有数据访问都通过 AsyncLocalStorage 解析到该用户自己的根；
        // Express 在 next() 内同步分发，异步处理链会继承这个上下文。
        const root = prepareUserWorkspace(session.user.id);
        runInWorkspaceScope({ root, userId: session.user.id }, () => {
          next();
        });
        return;
      }
      clearSessionCookie(res, config);
    }

    if (ANONYMOUS_API_PATHS.has(req.path)) {
      next();
      return;
    }
    res.status(401).json({ error: '未登录或登录已过期。' });
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: '未登录或登录已过期。' });
    return;
  }
  if (req.authUser.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限。' });
    return;
  }
  next();
}

function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  // 非浏览器客户端不带 Origin；它们本来也不受 CSRF 威胁。
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = String(Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers.host || '');
    return parsed.host === host;
  } catch {
    return false;
  }
}
