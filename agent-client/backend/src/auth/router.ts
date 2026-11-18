import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import type { AuthConfig } from './config.js';
import type { AuthService } from './service.js';
import { AuthError } from './errors.js';
import type { CodePurpose } from './types.js';
import { clearSessionCookie, setSessionCookie } from './cookies.js';

/**
 * `/api/auth/*`。
 *
 * 匿名端点（mode/code/register/login/password/forgot/password/reset）不经过
 * 鉴权中间件；其余端点由 server 在路由之前挂载的中间件填充 `req.authUser`。
 */
export function createAuthRouter(service: AuthService, config: AuthConfig): Router {
  const router = express.Router();

  router.get('/mode', (_req: Request, res: Response) => {
    res.json({ enabled: true });
  });

  router.post('/code', handle(async (req, res) => {
    const purpose = parsePurpose(req.body?.purpose);
    await service.requestCode({
      email: stringField(req.body, 'email'),
      purpose,
      ip: clientIp(req),
    });
    res.json({ ok: true });
  }));

  router.post('/register', handle(async (req, res) => {
    const result = await service.register({
      email: stringField(req.body, 'email'),
      password: stringField(req.body, 'password'),
      code: stringField(req.body, 'code'),
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    setSessionCookie(res, config, result.session.token, result.session.maxAgeSeconds);
    res.status(201).json({ user: result.user });
  }));

  router.post('/login', handle(async (req, res) => {
    const result = await service.login({
      email: stringField(req.body, 'email'),
      password: stringField(req.body, 'password'),
      remember: req.body?.remember === true,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    setSessionCookie(res, config, result.session.token, result.session.maxAgeSeconds);
    res.json({ user: result.user });
  }));

  router.post('/logout', (req: Request, res: Response) => {
    service.logout(req.authSessionId);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  router.get('/me', (req: Request, res: Response) => {
    if (!req.authUser) {
      res.status(401).json({ error: '未登录或登录已过期。' });
      return;
    }
    res.json({ user: req.authUser });
  });

  router.post('/password/forgot', handle(async (req, res) => {
    await service.requestCode({
      email: stringField(req.body, 'email'),
      purpose: 'reset',
      ip: clientIp(req),
    });
    // 无论邮箱是否注册都返回同一响应，避免枚举。
    res.json({ ok: true });
  }));

  router.post('/password/reset', handle(async (req, res) => {
    await service.resetPassword({
      email: stringField(req.body, 'email'),
      code: stringField(req.body, 'code'),
      password: stringField(req.body, 'password'),
    });
    res.json({ ok: true });
  }));

  router.post('/password/change', handle(async (req, res) => {
    if (!req.authUser) throw new AuthError(401, '未登录或登录已过期。');
    await service.changePassword(
      req.authUser.id,
      stringField(req.body, 'currentPassword'),
      stringField(req.body, 'newPassword'),
      req.authSessionId,
    );
    res.json({ ok: true });
  }));

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('[auth] unexpected error:', error);
    res.status(500).json({ error: '服务暂时不可用，请稍后再试。' });
  });

  return router;
}

function handle(work: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(work(req, res)).catch(next);
  };
}

function stringField(body: unknown, name: string): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function parsePurpose(value: unknown): CodePurpose {
  if (value === 'register' || value === 'reset') return value;
  throw new AuthError(400, '验证码用途不正确。');
}

function clientIp(req: Request): string | null {
  return req.ip || req.socket.remoteAddress || null;
}

function userAgent(req: Request): string | null {
  const value = req.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, 400) : null;
}
