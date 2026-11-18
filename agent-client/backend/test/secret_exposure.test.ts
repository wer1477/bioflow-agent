import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configFilesRouter from '../src/http/routes/config_files.js';
import configManageRouter from '../src/http/routes/config_manage.js';
import settingsRouter from '../src/http/routes/settings.js';

test('settings endpoints and config file browser never expose API key values', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-secret-test-'));
  const previousConfigDir = process.env.BIOFLOW_CONFIG_DIR;
  const previousEnvironmentFile = process.env.BIOFLOW_ENV_FILE;
  const secret = 'test-secret-value';
  process.env.BIOFLOW_CONFIG_DIR = configDir;
  process.env.BIOFLOW_ENV_FILE = path.join(configDir, '.env');
  await writeFile(path.join(configDir, 'llm.json'), JSON.stringify([{ id: 'test', name: 'test', baseUrl: 'https://example.test', apiKey: secret, model: 'test-model' }]));
  await writeFile(path.join(configDir, 'mcp.json'), JSON.stringify({
    servers: [{ id: 'test-mcp', name: 'test-mcp', command: 'test', args: [], env: { TEST_API_KEY: secret }, headers: {}, enabled: true }],
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.use('/api/config/files', configFilesRouter);
  app.use('/api/config/manage', configManageRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const [settings, reload, llmConfigFile, mcpConfigFile, rawKeyWrite, rawConfigWrite, rawMcpWrite] = await Promise.all([
      fetch(`${origin}/api/settings`).then((response) => response.json()),
      fetch(`${origin}/api/settings/reload`, { method: 'POST' }).then((response) => response.json()),
      fetch(`${origin}/api/config/files/config/llm.json`),
      fetch(`${origin}/api/config/files/config/mcp.json`),
      fetch(`${origin}/api/config/manage/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'unsafe', baseUrl: 'https://example.test', apiKey: secret, model: 'test-model' }),
      }),
      fetch(`${origin}/api/config/files/config/llm.json`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: JSON.stringify([{ apiKey: secret }]) }),
      }),
      fetch(`${origin}/api/config/manage/mcp/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: JSON.stringify({ servers: [{ id: 'unsafe-mcp', name: 'unsafe-mcp', env: { TEST_API_KEY: secret } }] }) }),
      }),
    ]);

    assert.doesNotMatch(JSON.stringify(settings), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(reload), new RegExp(secret));
    assert.notEqual(settings.llmProviders[0].apiKey, secret);
    assert.notEqual(reload.settings.llmProviders[0].apiKey, secret);
    assert.notEqual(settings.mcpServers[0].env.TEST_API_KEY, secret);
    assert.notEqual(reload.settings.mcpServers[0].env.TEST_API_KEY, secret);
    assert.equal(llmConfigFile.status, 403);
    assert.equal(mcpConfigFile.status, 403);
    // A submitted key is accepted and relocated to the environment file; the contract is
    // that it is never echoed and never persisted in plain text. The context window is no
    // longer required at write time because it now comes from the model catalog or probe.
    assert.equal(rawKeyWrite.status, 201);
    assert.doesNotMatch(JSON.stringify(await rawKeyWrite.json()), new RegExp(secret), 'a submitted key is never echoed back');
    const persistedLlm = JSON.parse(await readFile(path.join(configDir, 'llm.json'), 'utf8'));
    const submittedProvider = persistedLlm.providers.find((provider: { name?: string }) => provider.name === 'unsafe');
    assert.ok(submittedProvider, 'the submitted provider was persisted');
    assert.match(submittedProvider.apiKey, /^\$\{BIOFLOW_LLM_API_KEY_[A-F0-9_]+\}$/, 'the key is stored as a reference');
    assert.equal(rawConfigWrite.status, 400);
    assert.equal(rawMcpWrite.status, 200);
    const persistedMcp = await readFile(path.join(configDir, 'mcp.json'), 'utf8');
    assert.doesNotMatch(persistedMcp, new RegExp(secret));
    assert.match(persistedMcp, /\$\{BIOFLOW_MCP_UNSAFE_MCP_TEST_API_KEY\}/);
    assert.match(await readFile(path.join(configDir, '.env'), 'utf8'), new RegExp(secret));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfigDir === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previousConfigDir;
    if (previousEnvironmentFile === undefined) delete process.env.BIOFLOW_ENV_FILE;
    else process.env.BIOFLOW_ENV_FILE = previousEnvironmentFile;
    delete process.env.BIOFLOW_MCP_UNSAFE_MCP_TEST_API_KEY;
    await rm(configDir, { recursive: true, force: true });
  }
});
