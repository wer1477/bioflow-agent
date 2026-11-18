import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configManageRouter from '../src/http/routes/config_manage.js';

test('LLM management stores a submitted API key in the local environment file and persists only its reference', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-llm-config-test-'));
  const envDir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-llm-env-test-'));
  const envFile = path.join(envDir, '.env');
  const previousConfigDir = process.env.BIOFLOW_CONFIG_DIR;
  const previousEnvFile = process.env.BIOFLOW_ENV_FILE;
  process.env.BIOFLOW_CONFIG_DIR = configDir;
  process.env.BIOFLOW_ENV_FILE = envFile;

  const app = express();
  app.use(express.json());
  app.use('/api/config/manage', configManageRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  const secret = 'test-secret-must-not-enter-llm-json';
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config/manage/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://example.test/v1',
        apiKey: secret,
        model: 'test-model',
        contextWindowTokens: 8_192,
      }),
    });

    assert.equal(response.status, 201);
    assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(secret));
    const document = JSON.parse(await readFile(path.join(configDir, 'llm.json'), 'utf8'));
    const provider = document.providers[0];
    assert.match(provider.apiKey, /^\$\{BIOFLOW_LLM_API_KEY_[A-F0-9_]+\}$/);
    assert.doesNotMatch(JSON.stringify(document), new RegExp(secret));
    assert.match(await readFile(envFile, 'utf8'), new RegExp(`=${JSON.stringify(secret)}`));
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    delete process.env[provider.apiKey.slice(2, -1)];
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfigDir === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previousConfigDir;
    if (previousEnvFile === undefined) delete process.env.BIOFLOW_ENV_FILE;
    else process.env.BIOFLOW_ENV_FILE = previousEnvFile;
    await rm(configDir, { recursive: true, force: true });
    await rm(envDir, { recursive: true, force: true });
  }
});
