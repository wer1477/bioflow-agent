import express from 'express';
import type { Express, Request, Response } from 'express';
import { saveFeedback } from '../../services/feedback_store.js';

const router = express.Router();

/** Keep the stored categories closed so the DB does not accumulate free-form labels. */
const CATEGORIES = new Set(['bug', 'feature', 'other']);
const MAX_CONTENT = 5000;
const MAX_CONTACT = 200;
const MAX_PAGE = 500;

router.post('/', async (req: Request, res: Response) => {
  const user = req.authUser;
  if (!user) {
    res.status(401).json({ error: '请先登录。' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    res.status(400).json({ error: '反馈内容不能为空。' });
    return;
  }
  if (content.length > MAX_CONTENT) {
    res.status(400).json({ error: `反馈内容不能超过 ${MAX_CONTENT} 个字符。` });
    return;
  }

  const category = typeof body.category === 'string' && CATEGORIES.has(body.category) ? body.category : 'other';
  const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, MAX_CONTACT) : '';
  const page = typeof body.page === 'string' ? body.page.trim().slice(0, MAX_PAGE) : '';

  try {
    const feedback = await saveFeedback({
      content,
      category,
      contact,
      page,
      userId: user.id,
      email: user.email,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
    });
    res.status(201).json({ feedback });
  } catch (error) {
    console.error('[feedback] failed to persist:', error);
    res.status(503).json({ error: '反馈存储暂不可用，请稍后再试。' });
  }
});

/**
 * 反馈端点只随登录鉴权一起出现：开发实例（`BIOFLOW_AUTH_ENABLED` 未开）不挂载，
 * 请求自然落到 Express 的 404，而不是留下一个可匿名写入的入口。
 */
export function mountFeedbackRoute(app: Express, enabled: boolean): void {
  if (!enabled) return;
  app.use('/api/feedback', router);
}

export default router;
