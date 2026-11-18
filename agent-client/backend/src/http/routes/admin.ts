import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AuthError } from '../../auth/errors.js';
import type { AdminActor, AuthService } from '../../auth/service.js';

/**
 * 管理员最小能力面：用户列表 / 禁用启用 / 强制下线 / 发重置邮件 / 审计查询。
 *
 * 只挂在 `/api/admin` 且前置 `requireAdmin`；不提供查看用户 provider 明文或
 * 跨用户数据的能力。
 */
export function createAdminRouter(service: AuthService): express.Router {
  const router = express.Router();

  router.get('/users', (req: Request, res: Response) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(service.listUsers({
      query,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    }));
  });

  router.post('/users/:id/disable', (req: Request, res: Response) => {
    res.json({ user: service.setUserStatus(String(req.params.id), 'disabled', actor(req)) });
  });

  router.post('/users/:id/enable', (req: Request, res: Response) => {
    res.json({ user: service.setUserStatus(String(req.params.id), 'active', actor(req)) });
  });

  router.post('/users/:id/sessions/revoke', (req: Request, res: Response) => {
    res.json({ revoked: service.revokeUserSessions(String(req.params.id), actor(req)) });
  });

  router.post('/users/:id/password-reset', handle(async (req: Request, res: Response) => {
    await service.adminSendPasswordReset(String(req.params.id), actor(req));
    res.json({ ok: true });
  }));

  router.get('/audit', (req: Request, res: Response) => {
    res.json({
      entries: service.listAudit({
        limit: Number(req.query.limit) || 100,
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
        event: typeof req.query.event === 'string' ? req.query.event : undefined,
        userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
      }),
    });
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('[admin] unexpected error:', error);
    res.status(500).json({ error: '服务暂时不可用，请稍后再试。' });
  });

  return router;
}

function actor(req: Request): AdminActor {
  if (!req.authUser) throw new AuthError(401, '未登录或登录已过期。');
  return {
    id: req.authUser.id,
    email: req.authUser.email,
    ip: req.ip || req.socket.remoteAddress || null,
  };
}

function handle(work: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(work(req, res)).catch(next);
  };
}
