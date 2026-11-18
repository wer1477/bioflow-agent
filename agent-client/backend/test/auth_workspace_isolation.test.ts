import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test, { after, before } from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import projectsRouter from '../src/http/routes/projects.js';
import { createAuthModule } from '../src/auth/index.js';
import { readAuthConfig } from '../src/auth/config.js';
import { createMemoryMailer, type MemoryMailer } from '../src/auth/mailer.js';
import { currentWorkspaceRoot, sessionsRoot, uploadsRoot, WORKSPACE_ROOT } from '../src/paths.js';
import { runInWorkspaceScope } from '../src/workspace_scope.js';
import { getUpload, initUpload, UploadError } from '../src/services/upload_service.js';

interface TestApp {
  origin: string;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

const temporaryDirectories: string[] = [];
let app: TestApp;

before(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bioflow-isolation-'));
  temporaryDirectories.push(directory);
  const config = {
    ...readAuthConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    dbPath: path.join(directory, 'auth.sqlite'),
    cookieSecure: false,
  };
  const mailer = createMemoryMailer();
  const auth = await createAuthModule({ config, mailer });
  assert.ok(auth.middleware, 'enabled auth module must expose middleware');
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use(auth.middleware);
  expressApp.use('/api/auth', auth.router);
  expressApp.use('/api/conversations', conversationsRouter);
  expressApp.use('/api/projects', projectsRouter);

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listening = expressApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no port');
  app = {
    origin: `http://127.0.0.1:${address.port}`,
    mailer,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        auth.close();
        if (error) reject(error);
        else resolve();
      });
    }),
  };
});

after(async () => {
  await app.close();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function expectJson<T>(response: Response, status: number): Promise<T> {
  if (response.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function postJson(pathname: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${app.origin}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getJson(pathname: string, cookie: string): Promise<Response> {
  return fetch(`${app.origin}${pathname}`, { headers: { cookie } });
}

function sessionCookie(response: Response): string {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const raw = cookies.find((cookie) => cookie.startsWith('bioflow_session='));
  if (!raw) throw new Error('missing session cookie');
  return raw.split(';')[0];
}

async function register(email: string): Promise<TestUser> {
  await expectJson(await postJson('/api/auth/code', { email, purpose: 'register' }), 200);
  const code = app.mailer.lastCode();
  assert.ok(code);
  const response = await postJson('/api/auth/register', { email, password: 'correct horse battery', code });
  const body = await expectJson<{ user: { id: string; email: string } }>(response, 201);
  return { id: body.user.id, email: body.user.email, cookie: sessionCookie(response) };
}

test('workspace getters fall back to the process root and honour the active scope', () => {
  assert.equal(currentWorkspaceRoot(), WORKSPACE_ROOT);
  runInWorkspaceScope({ root: '/tmp/bioflow-scope-x', userId: 'user-x' }, () => {
    assert.equal(currentWorkspaceRoot(), '/tmp/bioflow-scope-x');
    assert.equal(sessionsRoot(), path.join('/tmp/bioflow-scope-x', '.sessions'));
    assert.equal(uploadsRoot(), path.join('/tmp/bioflow-scope-x', '.runtime', 'uploads'));
  });
  assert.equal(currentWorkspaceRoot(), WORKSPACE_ROOT);
});

test('two users cannot see each other projects, conversations or uploads', async () => {
  const alice = await register('alice@example.test');
  const bob = await register('bob@example.test');

  const projectBody = await expectJson<{ project: { key: string } }>(
    await postJson('/api/projects', { name: 'iso-project' }, alice.cookie),
    201,
  );
  const projectKey = projectBody.project.key;

  const conversationBody = await expectJson<{ conversation: { id: string } }>(
    await postJson('/api/conversations', { project: projectKey, title: 'alice session' }, alice.cookie),
    201,
  );
  const aliceConversationId = conversationBody.conversation.id;

  const aliceRoot = path.join(WORKSPACE_ROOT, 'users', alice.id);
  const bobRoot = path.join(WORKSPACE_ROOT, 'users', bob.id);
  assert.ok(fs.existsSync(path.join(aliceRoot, 'iso-project')), 'project must live under the owner workspace root');
  assert.ok(!fs.existsSync(path.join(WORKSPACE_ROOT, 'iso-project')), 'project must not leak into the shared root');

  const aliceList = await expectJson<{ conversations: Array<{ id: string }> }>(
    await getJson('/api/conversations', alice.cookie),
    200,
  );
  assert.ok(aliceList.conversations.some((row) => row.id === aliceConversationId));

  const bobProjectBody = await expectJson<{ projects: unknown[] }>(
    await getJson('/api/projects', bob.cookie),
    200,
  );
  assert.equal(bobProjectBody.projects.length, 0);

  const bobList = await expectJson<{ conversations: Array<{ id: string }> }>(
    await getJson('/api/conversations', bob.cookie),
    200,
  );
  assert.equal(bobList.conversations.length, 0);

  const crossConversation = await getJson(`/api/conversations/${encodeURIComponent(aliceConversationId)}`, bob.cookie);
  assert.equal(crossConversation.status, 404);

  const crossFiles = await getJson(`/api/projects/${encodeURIComponent(projectKey)}/files`, bob.cookie);
  assert.equal(crossFiles.status, 404);

  // 同名项目在另一个用户根下是独立的一份，不属于跨用户访问。
  await expectJson(await postJson('/api/projects', { name: 'iso-project' }, bob.cookie), 201);
  assert.ok(fs.existsSync(path.join(bobRoot, 'iso-project')));

  const uploadId = await runInWorkspaceScope({ root: aliceRoot, userId: alice.id }, async () => {
    const view = await initUpload({ projectKey, targetPath: 'data.bin', size: 16 });
    return view.id;
  });
  assert.ok(fs.existsSync(path.join(aliceRoot, '.runtime', 'uploads', uploadId)));

  await runInWorkspaceScope({ root: bobRoot, userId: bob.id }, async () => {
    await assert.rejects(
      () => getUpload(projectKey, uploadId),
      (error: unknown) => error instanceof UploadError && error.status === 404,
    );
  });
});

test('authentication off keeps the original shared workspace root', () => {
  assert.equal(currentWorkspaceRoot(), WORKSPACE_ROOT);
  assert.equal(sessionsRoot(), path.join(WORKSPACE_ROOT, '.sessions'));
});
