import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { probeModels } from '../../agent/llm_probe.js';
import { AuthError } from '../../auth/errors.js';
import {
  clearUserRoleBinding,
  createUserProvider,
  deleteUserProvider,
  getStoredProviderEndpoint,
  getUserLLMSettings,
  setUserRoleBinding,
  updateUserProvider,
} from '../../auth/user_llm_store.js';

/**
 * 当前用户的 LLM 配置（`/api/me/llm`，只在鉴权启用时挂载）。
 *
 * 系统预置（DGX）只读；用户自己的 provider 可增删改，API key 在服务端加密保存，
 * 响应里只出现掩码。探测请求使用用户已保存的 key 或编辑器里刚输入的 key。
 */
const router = express.Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(getUserLLMSettings());
});

router.post('/providers', (req: Request, res: Response) => {
  const provider = createUserProvider(req.body);
  res.status(201).json({ provider, settings: getUserLLMSettings() });
});

router.put('/providers/:id', (req: Request, res: Response) => {
  const provider = updateUserProvider(param(req.params.id), req.body);
  res.json({ provider, settings: getUserLLMSettings() });
});

router.delete('/providers/:id', (req: Request, res: Response) => {
  deleteUserProvider(param(req.params.id));
  res.json({ settings: getUserLLMSettings() });
});

router.post('/providers/:id/probe', handle(async (req: Request, res: Response) => {
  const endpoint = getStoredProviderEndpoint(param(req.params.id));
  const source = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  res.json(await probeModels(endpoint, {
    model: typeof source.model === 'string' ? source.model : undefined,
    probeThinkingLevels: source.probeThinkingLevels === true,
  }));
}));

router.post('/probe', handle(async (req: Request, res: Response) => {
  const source = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  if (!baseUrl) throw new AuthError(400, '缺少 Base URL。');
  if (!apiKey) throw new AuthError(400, '缺少 API Key。');
  const protocol = source.protocol === 'anthropic-messages' || source.protocol === 'openai-responses' ? source.protocol : 'openai-completions';
  res.json(await probeModels({ baseUrl, apiKey, protocol }, {
    model: typeof source.model === 'string' ? source.model : undefined,
    probeThinkingLevels: source.probeThinkingLevels === true,
  }));
}));

router.put('/roles/:roleId', (req: Request, res: Response) => {
  setUserRoleBinding(param(req.params.roleId), req.body);
  res.json(getUserLLMSettings());
});

router.delete('/roles/:roleId', (req: Request, res: Response) => {
  clearUserRoleBinding(param(req.params.roleId));
  res.json(getUserLLMSettings());
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
  console.error('[me/llm] unexpected error:', error);
  res.status(500).json({ error: error instanceof Error ? error.message : '服务暂时不可用。' });
});

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] || '' : value;
}

function handle(work: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(work(req, res)).catch(next);
  };
}

export default router;
