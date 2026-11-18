import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mcpManager } from '../agent/mcp_manager.js';
import { analysisKernelManager } from '../agent/core_tools/analysis_kernel_manager.js';
import { shellTaskManager } from '../agent/core_tools/shell_tasks.js';
import { loadBackendConfig } from '../agent/config/backend_config_loader.js';
import { biodService } from '../agent/biod/index.js';
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from '../single_instance_lock.js';
import { createAuthModule, type AuthModule } from '../auth/index.js';
import { setAuthModule } from '../auth/runtime.js';
import { requireAdmin } from '../auth/middleware.js';
import meLlmRouter from './routes/me_llm.js';
import { createAdminRouter } from './routes/admin.js';
import healthRouter from './routes/health.js';
import conversationsRouter from './routes/conversations.js';
import projectsRouter from './routes/projects.js';
import settingsRouter from './routes/settings.js';
import configFilesRouter from './routes/config_files.js';
import configManageRouter from './routes/config_manage.js';
import knowledgebaseRouter from './routes/knowledgebase.js';
import feedbackAdminRouter from './routes/feedback_admin.js';
import { mountFeedbackRoute } from './routes/feedback.js';
import { AGENT_CLIENT_ROOT, WORKSPACE_ROOT, ensureStateRoots } from '../paths.js';
import { runInWorkspaceScope } from '../workspace_scope.js';
import { sweepExpiredUploads } from '../services/upload_service.js';

const WEB_SOURCE_ROOT = path.join(AGENT_CLIENT_ROOT, 'web');
const WEB_DIST_ROOT = path.join(WEB_SOURCE_ROOT, 'dist');
const WEB_ROOT = process.env.WEB_ROOT || WEB_DIST_ROOT;
let httpServer: Server | null = null;
let authModule: AuthModule | null = null;

export async function startHttpServer(): Promise<void> {
  const app = express();
  const port = parseInt(process.env.PORT || '3000', 10);

  acquireSingleInstanceLock(WORKSPACE_ROOT);
  ensureStateRoots();
  // Abandoned chunk sessions must not accumulate across restarts.
  void sweepExpiredUploads().catch((error: unknown) => {
    console.warn(`[uploads] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await analysisKernelManager.recoverOrphans();
  await shellTaskManager.recoverOrphans();
  const configResult = loadBackendConfig();
  // The decision sidecar is started in the background: a cold model load must never delay
  // the HTTP listener, and every decision call fails open until it is ready.
  void biodService.start().catch((error: unknown) => {
    console.warn(`[biod] start failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  app.use(express.json({ limit: '5mb' }));

  // 登录鉴权只在部署实例打开（BIOFLOW_AUTH_ENABLED=1）。关闭时中间件与数据库
  // 都不会加载，开发实例的 API 行为与未引入登录前完全一致。
  authModule = await createAuthModule();
  setAuthModule(authModule);
  if (authModule.middleware) {
    // nginx 经 frp 反代到本机 127.0.0.1；信任回环跳数后才能拿到真实客户端 IP。
    app.set('trust proxy', 'loopback');
    app.use(authModule.middleware);
  }
  app.use('/api/auth', authModule.router);
  if (authModule.enabled) {
    console.log(`[auth] enabled (db: ${authModule.config.dbPath})`);
    // 每用户 LLM 配置：用户自己的 provider + 系统预置只读。
    app.use('/api/me/llm', meLlmRouter);
    // 管理员最小能力面：用户管理 + 审计查询。
    if (authModule.service) {
      app.use('/api/admin', requireAdmin, createAdminRouter(authModule.service));
    }
    // 管理员反馈收件箱：只读列表，与用户管理同属管理员能力面。
    app.use('/api/admin/feedback', requireAdmin, feedbackAdminRouter);
    // 全局配置写操作只留给管理员；目录读取与端点探测是只读的，普通用户可用。
    app.use('/api/config/manage', restrictConfigManage);
    app.use('/api/config/files', requireAdmin);
    app.use('/api/settings/reload', requireAdmin);
    // 启动时的上传清理只扫进程默认根；登录版每个用户根各扫一次。
    void sweepUserUploads().catch((error: unknown) => {
      console.warn(`[uploads] per-user sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  app.use('/api/health', healthRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/config/files', configFilesRouter);
  app.use('/api/config/manage', configManageRouter);
  app.use('/api/knowledgebase', knowledgebaseRouter);
  // 反馈只随登录鉴权出现；开发实例没有入口，路由也不挂载。
  mountFeedbackRoute(app, authModule.enabled);
  const staticRoot = await resolveWebRoot();
  app.use(express.static(staticRoot, {
    etag: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
    },
  }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(staticRoot, 'index.html'));
  });

  httpServer = app.listen(port, () => {
    console.log(`Bioflow agent server running at http://localhost:${port}`);
    console.log(`  Health: http://localhost:${port}/api/health`);
    console.log(`  Web: http://localhost:${port}/`);
    console.log(`  Web root: ${staticRoot}`);
    console.log(`  Config: ${configResult.loaded.length ? configResult.loaded.join(', ') : 'none'}`);
  });
}

async function resolveWebRoot(): Promise<string> {
  if (await fileExists(path.join(WEB_ROOT, 'index.html'))) return WEB_ROOT;
  return WEB_SOURCE_ROOT;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 登录版：全局配置写操作仅管理员；目录读取与端点探测保持只读可用。 */
function restrictConfigManage(req: Request, res: Response, next: NextFunction): void {
  if (req.authUser?.role === 'admin') {
    next();
    return;
  }
  const readOnly = (req.method === 'GET' && req.path.startsWith('/llm/catalog'))
    || (req.method === 'POST' && (req.path === '/llm/probe' || req.path === '/llm/verify'));
  if (readOnly) {
    next();
    return;
  }
  res.status(403).json({ error: '需要管理员权限。' });
}

/** 登录版：为每个已有用户根清理过期上传（默认根由启动时的 sweep 处理）。 */
async function sweepUserUploads(): Promise<void> {
  const usersRoot = path.join(WORKSPACE_ROOT, 'users');
  let entries;
  try {
    entries = await fs.readdir(usersRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(usersRoot, entry.name);
    ensureStateRoots(root);
    await runInWorkspaceScope({ root, userId: entry.name }, () => sweepExpiredUploads());
  }
}

async function shutdown() {
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer?.close(() => resolve());
    });
    httpServer = null;
  }
  await biodService.stop();
  await mcpManager.cleanup();
  await analysisKernelManager.cleanupAll();
  await shellTaskManager.cleanupAll();
  setAuthModule(null);
  authModule?.close();
  authModule = null;
  releaseSingleInstanceLock();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
