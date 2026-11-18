import express from 'express';
import type { Request, Response } from 'express';
import { countFeedback, listFeedback } from '../../services/feedback_store.js';

/**
 * 管理员反馈收件箱：只读分页列表。
 *
 * 路由挂在 `/api/admin/feedback` 且由 server 前置 `requireAdmin`；不提供修改/删除，
 * 反馈内容属于用户原始输入，管理员只做查看与线下处理。
 */
const router = express.Router();

router.get('/', async (req: Request, res: Response) => {
  const limit = clamp(Number(req.query.limit) || 50, 1, 100);
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  try {
    const [items, total] = await Promise.all([listFeedback(limit, offset), countFeedback()]);
    res.json({ items, total, limit, offset });
  } catch (error) {
    console.error('[feedback] admin list failed:', error);
    res.status(503).json({ error: '反馈存储暂不可用，请稍后再试。' });
  }
});

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export default router;
