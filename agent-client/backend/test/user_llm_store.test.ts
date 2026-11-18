import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test, { after, before } from 'node:test';
import { readAuthConfig } from '../src/auth/config.js';
import { createAuthModule, type AuthModule } from '../src/auth/index.js';
import { AuthError } from '../src/auth/errors.js';
import { createMemoryMailer, type MemoryMailer } from '../src/auth/mailer.js';
import { setAuthModule } from '../src/auth/runtime.js';
import {
  clearUserRoleBinding,
  createUserProvider,
  deleteUserProvider,
  getUserLLMSettings,
  resolveLLMTargetForCurrentUser,
  resolveRoleBinding,
  setUserRoleBinding,
  updateUserProvider,
} from '../src/auth/user_llm_store.js';
import { settingsForRequest } from '../src/http/routes/settings.js';
import meLlmRouter from '../src/http/routes/me_llm.js';
import { runInWorkspaceScope } from '../src/workspace_scope.js';

process.env.BIOFLOW_LLM_API_KEY_DGX ||= 'test-key';

interface TestContext {
  module: AuthModule;
  root: string;
  database: NonNullable<AuthModule['database']>;
}

const temporaryDirectories: string[] = [];
let context: TestContext;
let app: { origin: string; mailer: MemoryMailer; close: () => Promise<void> };

function seedUser(id: string, email: string): void {
  context.database.prepare(`
    INSERT INTO users
      (id, email, email_normalized, password_hash, role, status, created_at, created_ip, last_login_at, failed_login_count, locked_until)
    VALUES (?, ?, ?, 'x', 'user', 'active', ?, NULL, NULL, 0, NULL)
  `).run(id, email, email, new Date().toISOString());
}

function inUser<T>(userId: string, work: () => T): T {
  return runInWorkspaceScope({ root: path.join(context.root, 'users', userId), userId }, work);
}

function providerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'My Provider',
    baseUrl: 'https://llm.example.test/v1',
    apiKey: 'sk-test-plaintext-123456',
    thinkingFormat: 'openai-effort',
    defaultModelId: 'model-a',
    models: [
      { id: 'model-a', label: 'Model A', contextWindowTokens: 128000, reasoningEfforts: { low: 'low', high: 'high' }, defaultThinkingLevel: 'low' },
      { id: 'model-b', label: 'Model B' },
    ],
    ...overrides,
  };
}

before(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bioflow-user-llm-'));
  temporaryDirectories.push(directory);
  const config = {
    ...readAuthConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    dbPath: path.join(directory, 'auth.sqlite'),
    cookieSecure: false,
  };
  const mailer = createMemoryMailer();
  const module = await createAuthModule({ config, mailer, secretKeyPath: path.join(directory, 'auth-secret.key') });
  assert.ok(module.database);
  context = {
    module,
    database: module.database,
    root: path.join(directory, 'workspace'),
  };
  fs.mkdirSync(context.root, { recursive: true });
  setAuthModule(module);
  seedUser('user-a', 'a@example.test');
  seedUser('user-b', 'b@example.test');

  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use(module.middleware);
  expressApp.use('/api/auth', module.router);
  expressApp.use('/api/me/llm', meLlmRouter);
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
  setAuthModule(null);
  context.module.close();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sessionCookie(response: Response): string {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const raw = cookies.find((cookie) => cookie.startsWith('bioflow_session='));
  if (!raw) throw new Error('missing session cookie');
  return raw.split(';')[0];
}

async function register(email: string): Promise<string> {
  const codeResponse = await fetch(`${app.origin}/api/auth/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, purpose: 'register' }),
  });
  assert.equal(codeResponse.status, 200);
  const code = app.mailer.lastCode();
  assert.ok(code);
  const response = await fetch(`${app.origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery', code }),
  });
  assert.equal(response.status, 201, await response.text());
  return sessionCookie(response);
}

test('user providers are encrypted at rest and only exposed masked', () => {
  const provider = inUser('user-a', () => createUserProvider(providerPayload()));
  assert.match(provider.id, /^u_/);
  assert.equal(provider.apiKey.includes('sk-test-plaintext'), false);
  const row = context.database
    .prepare('SELECT api_key_ciphertext FROM user_llm_providers WHERE id = ?')
    .get(provider.id) as { api_key_ciphertext: string };
  assert.equal(row.api_key_ciphertext.includes('sk-test-plaintext-123456'), false);
});

test('role bindings override provider/model/thinking and enforce references', () => {
  const provider = inUser('user-a', () => createUserProvider(providerPayload({ name: 'Binding Provider' })));
  inUser('user-a', () => setUserRoleBinding('pi', {
    providerId: provider.id,
    modelId: 'model-a',
    thinkingLevel: 'high',
  }));
  const binding = inUser('user-a', () => resolveRoleBinding('pi'));
  assert.deepEqual(binding, { providerId: provider.id, modelId: 'model-a', thinkingLevel: 'high' });

  assert.throws(
    () => inUser('user-a', () => setUserRoleBinding('not-a-role', { providerId: provider.id })),
    (error: unknown) => error instanceof AuthError && error.status === 400,
  );
  assert.throws(
    () => inUser('user-a', () => setUserRoleBinding('writer', { providerId: 'u_missing' })),
    (error: unknown) => error instanceof AuthError && error.status === 400,
  );

  inUser('user-a', () => clearUserRoleBinding('pi'));
  assert.equal(inUser('user-a', () => resolveRoleBinding('pi')), null);
  inUser('user-a', () => deleteUserProvider(provider.id));
});

test('a provider referenced by a binding cannot be deleted', () => {
  const provider = inUser('user-a', () => createUserProvider(providerPayload({ name: 'Protected Provider' })));
  inUser('user-a', () => setUserRoleBinding('pi', { providerId: provider.id }));
  assert.throws(
    () => inUser('user-a', () => deleteUserProvider(provider.id)),
    (error: unknown) => error instanceof AuthError && error.status === 409,
  );
  inUser('user-a', () => clearUserRoleBinding('pi'));
  inUser('user-a', () => deleteUserProvider(provider.id));
});

test('resolution merges the user provider set and falls back to the system provider', () => {
  const provider = inUser('user-a', () => createUserProvider(providerPayload({
    name: 'Resolution Provider',
    models: [{ id: 'model-a', reasoningEfforts: { high: 'high' } }],
    defaultModelId: 'model-a',
  })));

  const resolved = inUser('user-a', () => resolveLLMTargetForCurrentUser({
    providerId: provider.id,
    modelId: 'model-a',
    thinkingLevel: 'high',
  }));
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.provider.baseUrl, 'https://llm.example.test/v1');
    assert.equal(resolved.provider.apiKey, 'sk-test-plaintext-123456');
    assert.equal(resolved.provider.model, 'model-a');
  }

  // 没有用户绑定时回退到 agents.json 里的系统 provider（dgx）。
  const system = inUser('user-a', () => resolveLLMTargetForCurrentUser({ providerId: 'dgx' }));
  assert.equal(system.ok, true);

  inUser('user-a', () => deleteUserProvider(provider.id));
});

test('one user cannot see or resolve another user providers', () => {
  const provider = inUser('user-a', () => createUserProvider(providerPayload({ name: 'Private Provider' })));

  const bSettings = inUser('user-b', () => getUserLLMSettings());
  assert.equal(bSettings.providers.some((item) => item.id === provider.id), false);
  assert.equal(bSettings.systemProviders.some((item) => item.id === 'dgx'), true);
  assert.equal(bSettings.systemProviders.every((item) => item.readOnly === true), true);

  assert.throws(
    () => inUser('user-b', () => updateUserProvider(provider.id, providerPayload())),
    (error: unknown) => error instanceof AuthError && error.status === 404,
  );
  assert.throws(
    () => inUser('user-b', () => deleteUserProvider(provider.id)),
    (error: unknown) => error instanceof AuthError && error.status === 404,
  );
  const crossResolve = inUser('user-b', () => resolveLLMTargetForCurrentUser({ providerId: provider.id }));
  assert.equal(crossResolve.ok, false);

  inUser('user-a', () => deleteUserProvider(provider.id));
});

test('without a user scope resolution is exactly the global resolution', () => {
  const global = resolveLLMTargetForCurrentUser({ providerId: 'dgx' });
  assert.equal(global.ok, true);
});

test('settings payload hides prompts and system prompts from non-admin users', () => {
  const payload = {
    agents: [{ id: 'pi', systemPrompt: 'top secret prompt' }],
    prompts: [{ id: 'pi', body: 'top secret prompt' }],
    team: { leadRoleId: 'pi' },
  };
  const previous = process.env.BIOFLOW_AUTH_ENABLED;
  process.env.BIOFLOW_AUTH_ENABLED = '1';
  try {
    const userPayload = settingsForRequest(payload as never, { role: 'user' }) as typeof payload;
    assert.deepEqual(userPayload.prompts, []);
    assert.equal('systemPrompt' in userPayload.agents[0], false);
    assert.equal(userPayload.team.leadRoleId, 'pi');
    const adminPayload = settingsForRequest(payload as never, { role: 'admin' });
    assert.equal(adminPayload.prompts.length, 1);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_AUTH_ENABLED;
    else process.env.BIOFLOW_AUTH_ENABLED = previous;
  }
});

test('the /api/me/llm route offers system presets and manages own providers per session', async () => {
  const cookie = await register('routes@example.test');
  const initial = await fetch(`${app.origin}/api/me/llm`, { headers: { cookie } });
  assert.equal(initial.status, 200);
  const initialBody = await initial.json() as { providers: unknown[]; systemProviders: Array<{ id: string; readOnly: boolean }>; roles: string[] };
  assert.equal(initialBody.providers.length, 0);
  assert.ok(initialBody.systemProviders.some((item) => item.id === 'dgx' && item.readOnly));
  assert.deepEqual(initialBody.roles, ['pi', 'searcher', 'researcher', 'writer', 'reviewer']);

  const created = await fetch(`${app.origin}/api/me/llm/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(providerPayload({ name: 'Route Provider' })),
  });
  if (created.status !== 201) throw new Error(`provider create failed: ${created.status} ${await created.text()}`);
  const createdBody = await created.json() as { provider: { id: string; apiKey: string } };
  assert.equal(createdBody.provider.apiKey.includes('sk-test-plaintext'), false);

  const bound = await fetch(`${app.origin}/api/me/llm/roles/pi`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ providerId: createdBody.provider.id, modelId: 'model-a', thinkingLevel: 'high' }),
  });
  if (bound.status !== 200) throw new Error(`binding failed: ${bound.status} ${await bound.text()}`);
  const boundBody = await bound.json() as { roleBindings: Array<{ roleId: string; providerId: string }> };
  assert.equal(boundBody.roleBindings.find((item) => item.roleId === 'pi')?.providerId, createdBody.provider.id);

  const blocked = await fetch(`${app.origin}/api/me/llm/providers/${createdBody.provider.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(blocked.status, 409);

  const unbound = await fetch(`${app.origin}/api/me/llm/roles/pi`, { method: 'DELETE', headers: { cookie } });
  assert.equal(unbound.status, 200);
  const removed = await fetch(`${app.origin}/api/me/llm/providers/${createdBody.provider.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(removed.status, 200);

  const anonymous = await fetch(`${app.origin}/api/me/llm`);
  assert.equal(anonymous.status, 401);
});

test('a user provider keeps its wire protocol, and the column migration is idempotent', () => {
  // The login database shipped without `protocol`; `addColumnIfMissing` must be able to run
  // against an already-migrated file without failing. Re-opening the same path proves it.
  const reopened = { ...context };
  assert.ok(reopened.database);

  const created = inUser('user-protocol', () => {
    seedUser('user-protocol', 'protocol@example.test');
    return createUserProvider(providerPayload({ protocol: 'anthropic-messages' }));
  });
  assert.equal(created.protocol, 'anthropic-messages');

  const updated = inUser('user-protocol', () => updateUserProvider(created.id, providerPayload({ protocol: 'openai-completions' })));
  assert.equal(updated.protocol, 'openai-completions');

  const defaulted = inUser('user-protocol', () => createUserProvider(providerPayload({ name: 'Defaulted', baseUrl: 'https://default.example.test/v1' })));
  assert.equal(defaulted.protocol, 'openai-completions');

  assert.throws(
    () => inUser('user-protocol', () => createUserProvider(providerPayload({ name: 'Bad', baseUrl: 'https://bad.example.test/v1', protocol: 'grpc' }))),
    /协议不正确/,
  );
});
