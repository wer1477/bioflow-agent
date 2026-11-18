import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { RequestHandler } from 'express';
import { requireAdmin } from '../src/auth/middleware.js';
import type { AuthUser } from '../src/auth/types.js';
import feedbackAdminRouter from '../src/http/routes/feedback_admin.js';
import { mountFeedbackRoute } from '../src/http/routes/feedback.js';
import {
  APP_VERSION,
  closeFeedbackDatabase,
  countFeedback,
  listFeedback,
  saveFeedback,
} from '../src/services/feedback_store.js';

const ADMIN: AuthUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'admin',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

const USER: AuthUser = {
  ...ADMIN,
  id: 'user-1',
  email: 'account@example.com',
  role: 'user',
};

function asUser(user: AuthUser): RequestHandler {
  return (req, _res, next) => {
    req.authUser = user;
    next();
  };
}

async function withFeedbackDb<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-feedback-test-'));
  const previous = process.env.BIOFLOW_FEEDBACK_DB;
  process.env.BIOFLOW_FEEDBACK_DB = path.join(dir, 'feedback.sqlite');
  closeFeedbackDatabase();
  try {
    return await run(process.env.BIOFLOW_FEEDBACK_DB!);
  } finally {
    closeFeedbackDatabase();
    if (previous === undefined) delete process.env.BIOFLOW_FEEDBACK_DB;
    else process.env.BIOFLOW_FEEDBACK_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function listen(app: express.Express): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('feedback rows store account, page, version context and paginate', async () => {
  await withFeedbackDb(async () => {
    const first = await saveFeedback({
      content: '希望支持批量导出图片',
      category: 'feature',
      contact: 'user@example.com',
      page: '#/projects/demo',
      userId: 'user-1',
      email: 'account@example.com',
      userAgent: 'test-agent',
    });
    assert.ok(first.id > 0);
    assert.match(first.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const second = await saveFeedback({
      content: '无法打开项目文件',
      category: 'bug',
      page: '#/projects/other',
      userId: 'user-1',
      email: 'account@example.com',
    });
    assert.ok(second.id > first.id);
    assert.equal(await countFeedback(), 2);

    const newest = await listFeedback(1, 0);
    assert.equal(newest.length, 1);
    assert.equal(newest[0].id, second.id);
    assert.equal(newest[0].content, '无法打开项目文件');
    assert.equal(newest[0].status, 'open');
    assert.equal(newest[0].appVersion, APP_VERSION);

    const older = await listFeedback(1, 1);
    assert.equal(older.length, 1);
    assert.equal(older[0].id, first.id);
    assert.equal(older[0].category, 'feature');
    assert.equal(older[0].contact, 'user@example.com');
    assert.equal(older[0].page, '#/projects/demo');
    assert.equal(older[0].userId, 'user-1');
    assert.equal(older[0].email, 'account@example.com');
    assert.equal(older[0].userAgent, 'test-agent');
    assert.equal(older[0].appVersion, APP_VERSION);
  });
});

test('feedback is not mounted for the dev instance (auth disabled)', async () => {
  await withFeedbackDb(async (dbPath) => {
    const app = express();
    app.use(express.json());
    mountFeedbackRoute(app, false);
    const server = await listen(app);
    try {
      const response = await fetch(`${server.origin}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '开发实例不应该收到反馈' }),
      });
      assert.equal(response.status, 404);
      // 路由不存在，存储也不应被惰性打开，更不会创建数据库文件。
      assert.equal(existsSync(dbPath), false);
    } finally {
      await server.close();
    }
  });
});

test('the feedback route requires a session and validates content', async () => {
  await withFeedbackDb(async () => {
    const anonymousApp = express();
    anonymousApp.use(express.json());
    mountFeedbackRoute(anonymousApp, true);
    const anonymous = await listen(anonymousApp);
    try {
      const response = await fetch(`${anonymous.origin}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '没有登录' }),
      });
      assert.equal(response.status, 401);
    } finally {
      await anonymous.close();
    }

    const app = express();
    app.use(express.json());
    app.use(asUser(USER));
    mountFeedbackRoute(app, true);
    const server = await listen(app);
    try {
      const empty = await fetch(`${server.origin}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '   ' }),
      });
      assert.equal(empty.status, 400);

      const tooLong = await fetch(`${server.origin}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x'.repeat(5001) }),
      });
      assert.equal(tooLong.status, 400);

      const valid = await fetch(`${server.origin}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'feedback-test' },
        body: JSON.stringify({
          content: '  无法打开项目文件  ',
          category: 'not-a-category',
          contact: 'contact@example.com',
          page: '#/projects/demo',
        }),
      });
      assert.equal(valid.status, 201);
      const payload = await valid.json();
      assert.ok(payload.feedback.id > 0);
      assert.equal(payload.feedback.appVersion, APP_VERSION);

      const rows = await listFeedback();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, '无法打开项目文件');
      assert.equal(rows[0].category, 'other');
      assert.equal(rows[0].contact, 'contact@example.com');
      assert.equal(rows[0].page, '#/projects/demo');
      assert.equal(rows[0].userId, USER.id);
      assert.equal(rows[0].email, USER.email);
      assert.equal(rows[0].userAgent, 'feedback-test');
    } finally {
      await server.close();
    }
  });
});

test('the admin feedback inbox is read-only and admin-only', async () => {
  await withFeedbackDb(async () => {
    await saveFeedback({ content: '第一条反馈', category: 'bug', userId: USER.id, email: USER.email });
    await saveFeedback({ content: '第二条反馈', category: 'feature', userId: USER.id, email: USER.email });

    const app = express();
    app.use(express.json());
    app.use(asUser(USER));
    app.use('/api/admin/feedback', requireAdmin, feedbackAdminRouter);
    const server = await listen(app);
    try {
      const forbidden = await fetch(`${server.origin}/api/admin/feedback`);
      assert.equal(forbidden.status, 403);
    } finally {
      await server.close();
    }

    const anonymousApp = express();
    anonymousApp.use(express.json());
    anonymousApp.use('/api/admin/feedback', requireAdmin, feedbackAdminRouter);
    const anonymous = await listen(anonymousApp);
    try {
      const unauthorized = await fetch(`${anonymous.origin}/api/admin/feedback`);
      assert.equal(unauthorized.status, 401);
    } finally {
      await anonymous.close();
    }

    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use(asUser(ADMIN));
    adminApp.use('/api/admin/feedback', requireAdmin, feedbackAdminRouter);
    const admin = await listen(adminApp);
    try {
      const response = await fetch(`${admin.origin}/api/admin/feedback?limit=1&offset=0`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.total, 2);
      assert.equal(payload.limit, 1);
      assert.equal(payload.offset, 0);
      assert.equal(payload.items.length, 1);
      assert.equal(payload.items[0].content, '第二条反馈');
      assert.equal(payload.items[0].appVersion, APP_VERSION);

      const negative = await fetch(`${admin.origin}/api/admin/feedback?limit=999&offset=-5`);
      assert.equal(negative.status, 200);
      const clamped = await negative.json();
      assert.equal(clamped.limit, 100);
      assert.equal(clamped.offset, 0);
      assert.equal(clamped.items.length, 2);
    } finally {
      await admin.close();
    }
  });
});
