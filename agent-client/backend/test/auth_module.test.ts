import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test, { after } from 'node:test';
import { readAuthConfig, type AuthConfig } from '../src/auth/config.js';
import { createAuthModule } from '../src/auth/index.js';
import { createMemoryMailer, type MemoryMailer } from '../src/auth/mailer.js';

interface TestApp {
  origin: string;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createTestConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bioflow-auth-test-'));
  temporaryDirectories.push(directory);
  return {
    ...readAuthConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    dbPath: path.join(directory, 'auth.sqlite'),
    adminEmails: new Set(['boss@example.test']),
    cookieSecure: false,
    ...overrides,
  };
}

async function startTestApp(options: {
  config: AuthConfig;
  mailer?: MemoryMailer;
  now?: () => Date;
}): Promise<TestApp> {
  const mailer = options.mailer ?? createMemoryMailer();
  const auth = await createAuthModule({ config: options.config, mailer, now: options.now });
  const app = express();
  app.use(express.json());
  if (auth.middleware) app.use(auth.middleware);
  app.use('/api/auth', auth.router);
  app.get('/api/protected', (req, res) => {
    res.json({ email: req.authUser?.email ?? null });
  });
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no port');
  return {
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
}

async function postJson(app: TestApp, pathname: string, body: unknown, cookie?: string) {
  return fetch(`${app.origin}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const prefix = 'bioflow_session=';
  const raw = cookies.find((cookie) => cookie.startsWith(prefix));
  if (!raw) throw new Error(`missing session cookie, got: ${JSON.stringify(cookies)}`);
  return raw.split(';')[0];
}

function cookieMaxAgeSeconds(response: Response): number {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const raw = cookies.find((cookie) => cookie.startsWith('bioflow_session=')) || '';
  const match = /Max-Age=(\d+)/i.exec(raw);
  return match ? Number(match[1]) : 0;
}

async function requestCode(app: TestApp, email: string, purpose: 'register' | 'reset') {
  const response = await postJson(app, '/api/auth/code', { email, purpose });
  assert.equal(response.status, 200, `code request failed: ${await response.text()}`);
  const code = app.mailer.lastCode();
  assert.ok(code, 'memory mailer should have captured a code');
  return code;
}

async function registerUser(app: TestApp, email: string, password = 'correct horse battery') {
  const code = await requestCode(app, email, 'register');
  const response = await postJson(app, '/api/auth/register', { email, password, code });
  if (response.status !== 201) {
    throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { user: { email: string; role: string } };
  return { response, cookie: sessionCookie(response), body };
}

test('flag off keeps every API anonymous and reports auth disabled', async () => {
  const app = await startTestApp({ config: createTestConfig({ enabled: false }) });
  try {
    const mode = await fetch(`${app.origin}/api/auth/mode`);
    assert.deepEqual(await mode.json(), { enabled: false });

    const protectedResponse = await fetch(`${app.origin}/api/protected`);
    assert.equal(protectedResponse.status, 200);
    assert.deepEqual(await protectedResponse.json(), { email: null });

    const login = await postJson(app, '/api/auth/login', { email: 'a@b.co', password: 'x' });
    assert.equal(login.status, 404);
  } finally {
    await app.close();
  }
});

test('registration requires the emailed code, then signs the user in', async () => {
  const app = await startTestApp({ config: createTestConfig() });
  try {
    const email = 'alice@example.test';
    const code = await requestCode(app, email, 'register');

    const wrong = await postJson(app, '/api/auth/register', {
      email,
      password: 'correct horse battery',
      code: code === '000000' ? '111111' : '000000',
    });
    assert.equal(wrong.status, 400);

    const response = await postJson(app, '/api/auth/register', {
      email,
      password: 'correct horse battery',
      code,
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { user: { email: string; role: string } };
    assert.equal(body.user.email, email);
    assert.equal(body.user.role, 'user');
    const cookie = sessionCookie(response);

    const me = await fetch(`${app.origin}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { user: { email: string } }).user.email, email);

    const protectedResponse = await fetch(`${app.origin}/api/protected`, { headers: { cookie } });
    assert.deepEqual(await protectedResponse.json(), { email });

    const duplicateCode = await postJson(app, '/api/auth/code', { email, purpose: 'register' });
    assert.equal(duplicateCode.status, 409);
  } finally {
    await app.close();
  }
});

test('login rejects wrong passwords, locks after repeated failures, and honours remember me', async () => {
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  const app = await startTestApp({
    config: createTestConfig({ loginMaxFailures: 5, loginLockMinutes: 15 }),
    now: () => new Date(nowMs),
  });
  try {
    const email = 'bob@example.test';
    await registerUser(app, email);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await postJson(app, '/api/auth/login', { email, password: 'wrong-password' });
      assert.equal(response.status, 401, `attempt ${attempt} should be 401`);
    }
    const fifth = await postJson(app, '/api/auth/login', { email, password: 'wrong-password' });
    assert.equal(fifth.status, 401);
    const locked = await postJson(app, '/api/auth/login', { email, password: 'correct horse battery' });
    assert.equal(locked.status, 429);

    nowMs += 16 * 60_000;
    const success = await postJson(app, '/api/auth/login', {
      email,
      password: 'correct horse battery',
      remember: true,
    });
    assert.equal(success.status, 200);
    // 记住我：30 天。
    assert.equal(cookieMaxAgeSeconds(success), 30 * 86_400);
  } finally {
    await app.close();
  }
});

test('password reset consumes the emailed code and revokes every session', async () => {
  const app = await startTestApp({ config: createTestConfig() });
  try {
    const email = 'carol@example.test';
    const { cookie } = await registerUser(app, email);

    const code = await requestCode(app, email, 'reset');
    const reset = await postJson(app, '/api/auth/password/reset', {
      email,
      code,
      password: 'a brand new password',
    });
    assert.equal(reset.status, 200);

    const oldSession = await fetch(`${app.origin}/api/auth/me`, { headers: { cookie } });
    assert.equal(oldSession.status, 401);

    const oldPassword = await postJson(app, '/api/auth/login', {
      email,
      password: 'correct horse battery',
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await postJson(app, '/api/auth/login', {
      email,
      password: 'a brand new password',
    });
    assert.equal(newPassword.status, 200);
  } finally {
    await app.close();
  }
});

test('verification codes expire and resend is rate limited', async () => {
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  const app = await startTestApp({
    config: createTestConfig({ codeTtlSeconds: 600, codeResendSeconds: 60 }),
    now: () => new Date(nowMs),
  });
  try {
    const email = 'dave@example.test';
    const code = await requestCode(app, email, 'register');

    const resend = await postJson(app, '/api/auth/code', { email, purpose: 'register' });
    assert.equal(resend.status, 429, 'resend within cooldown should be 429');

    nowMs += 11 * 60_000;
    const expired = await postJson(app, '/api/auth/register', {
      email,
      password: 'correct horse battery',
      code,
    });
    assert.equal(expired.status, 400);
  } finally {
    await app.close();
  }
});

test('admin emails from the environment are granted admin role', async () => {
  const app = await startTestApp({ config: createTestConfig() });
  try {
    const { body } = await registerUser(app, 'boss@example.test');
    assert.equal(body.user.role, 'admin');
  } finally {
    await app.close();
  }
});
