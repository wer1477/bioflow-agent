import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test, { after, before } from 'node:test';
import { readAuthConfig } from '../src/auth/config.js';
import { createAuthModule } from '../src/auth/index.js';
import { createMemoryMailer, type MemoryMailer } from '../src/auth/mailer.js';
import { hashPassword } from '../src/auth/password.js';
import { requireAdmin } from '../src/auth/middleware.js';
import { createAdminRouter } from '../src/http/routes/admin.js';

interface TestApp {
  origin: string;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

const temporaryDirectories: string[] = [];
let app: TestApp;
let closeModule: () => void;

const PASSWORD = 'correct horse battery';

before(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bioflow-admin-'));
  temporaryDirectories.push(directory);
  const config = {
    ...readAuthConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    dbPath: path.join(directory, 'auth.sqlite'),
    cookieSecure: false,
  };
  const mailer = createMemoryMailer();
  const module = await createAuthModule({ config, mailer, secretKeyPath: path.join(directory, 'auth-secret.key') });
  assert.ok(module.service && module.database);
  closeModule = () => module.close();

  const passwordHash = await hashPassword(PASSWORD);
  const now = new Date().toISOString();
  const insert = module.database.prepare(`
    INSERT INTO users
      (id, email, email_normalized, password_hash, role, status, created_at, created_ip, last_login_at, failed_login_count, locked_until)
    VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL, 0, NULL)
  `);
  insert.run('admin-1', 'admin@example.test', 'admin@example.test', passwordHash, 'admin', now);
  insert.run('user-1', 'user@example.test', 'user@example.test', passwordHash, 'user', now);
  insert.run('reset-1', 'reset@example.test', 'reset@example.test', passwordHash, 'user', now);

  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use(module.middleware);
  expressApp.use('/api/auth', module.router);
  expressApp.use('/api/admin', requireAdmin, createAdminRouter(module.service));

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
        if (error) reject(error);
        else resolve();
      });
    }),
  };
});

after(async () => {
  await app.close();
  closeModule();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function login(email: string, password = PASSWORD): Promise<string> {
  const response = await fetch(`${app.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, await response.text());
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const raw = cookies.find((cookie) => cookie.startsWith('bioflow_session='));
  assert.ok(raw, 'login must set a session cookie');
  return raw.split(';')[0];
}

function adminJson(pathname: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${app.origin}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers || {}) },
  });
}

test('only admins can list users and read the audit log', async () => {
  const userCookie = await login('user@example.test');
  const forbidden = await fetch(`${app.origin}/api/admin/users`, { headers: { cookie: userCookie } });
  assert.equal(forbidden.status, 403);
  assert.equal((await fetch(`${app.origin}/api/admin/audit`, { headers: { cookie: userCookie } })).status, 403);

  const adminCookie = await login('admin@example.test');
  const response = await adminJson('/api/admin/users', adminCookie);
  assert.equal(response.status, 200);
  const body = await response.json() as { users: Array<{ email: string; status: string; activeSessions: number }>; total: number };
  assert.equal(body.total, 3);
  assert.ok(body.users.some((row) => row.email === 'user@example.test'));
  assert.ok(body.users.every((row) => row.status === 'active'));
  assert.ok(body.users.some((row) => row.activeSessions > 0));
});

test('disabling a user revokes sessions and blocks login until re-enabled', async () => {
  const userCookie = await login('user@example.test');
  assert.equal((await fetch(`${app.origin}/api/auth/me`, { headers: { cookie: userCookie } })).status, 200);

  const adminCookie = await login('admin@example.test');
  const disabled = await adminJson('/api/admin/users/user-1/disable', adminCookie, { method: 'POST' });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json() as { user: { status: string } }).user.status, 'disabled');

  assert.equal((await fetch(`${app.origin}/api/auth/me`, { headers: { cookie: userCookie } })).status, 401);
  const blockedLogin = await fetch(`${app.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.test', password: PASSWORD }),
  });
  assert.equal(blockedLogin.status, 403);

  const enabled = await adminJson('/api/admin/users/user-1/enable', adminCookie, { method: 'POST' });
  assert.equal(enabled.status, 200);
  await login('user@example.test');
});

test('an admin cannot disable their own account', async () => {
  const adminCookie = await login('admin@example.test');
  const response = await adminJson('/api/admin/users/admin-1/disable', adminCookie, { method: 'POST' });
  assert.equal(response.status, 400);
});

test('force logout revokes every session of the target user', async () => {
  const userCookie = await login('user@example.test');
  const adminCookie = await login('admin@example.test');
  const response = await adminJson('/api/admin/users/user-1/sessions/revoke', adminCookie, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.ok((await response.json() as { revoked: number }).revoked >= 1);
  assert.equal((await fetch(`${app.origin}/api/auth/me`, { headers: { cookie: userCookie } })).status, 401);
});

test('an admin can send a reset code and the user can finish the reset', async () => {
  const adminCookie = await login('admin@example.test');
  const sent = await adminJson('/api/admin/users/reset-1/password-reset', adminCookie, { method: 'POST' });
  assert.equal(sent.status, 200, await sent.text());

  const code = app.mailer.lastCode();
  assert.ok(code && code.length === 6, 'reset email must contain a code');
  const reset = await fetch(`${app.origin}/api/auth/password/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'reset@example.test', code, password: 'brand new password' }),
  });
  assert.equal(reset.status, 200, await reset.text());
  await login('reset@example.test', 'brand new password');
});

test('the audit log records admin actions newest first', async () => {
  const adminCookie = await login('admin@example.test');
  const response = await adminJson('/api/admin/audit?limit=50', adminCookie);
  assert.equal(response.status, 200);
  const body = await response.json() as { entries: Array<{ event: string; email: string | null; at: string }> };
  const events = body.entries.map((entry) => entry.event);
  for (const event of ['admin_disable', 'admin_enable', 'admin_revoke_sessions', 'admin_password_reset_sent', 'password_reset']) {
    assert.ok(events.includes(event), `missing audit event ${event}`);
  }
  assert.equal(body.entries[0].event, 'login');
  const timestamps = body.entries.map((entry) => Date.parse(entry.at));
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));
});
