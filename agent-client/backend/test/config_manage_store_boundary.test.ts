import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configManageRouter from '../src/http/routes/config_manage.js';

test('configuration management writes runtime configuration through canonical stores', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-config-store-test-'));
  const previousConfigDir = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = configDir;
  const keyReference = '${TEST_LLM_API_KEY}';
  await writeFile(path.join(configDir, 'llm.json'), JSON.stringify({
    providers: [{
      id: 'provider-1',
      base_url: 'https://old.example.test/v1',
      api_key: keyReference,
      model: 'old-model',
      context_window_tokens: 1_024,
      customLegacyField: 'must-not-survive-a-save',
      isDefault: true,
    }],
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/config/manage', configManageRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config/manage/llm/provider-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://new.example.test/v1',
        apiKey: keyReference,
        model: 'new-model',
        contextWindowTokens: 8_192,
        thinkingLevel: 'high',
        isDefault: true,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const persisted = JSON.parse(await readFile(path.join(configDir, 'llm.json'), 'utf8'));

    assert.equal(persisted.schemaVersion, 2, 'the store owns the canonical v2 document shape');
    assert.equal(persisted.defaultProviderId, 'provider-1', 'a default provider is one pointer, not a flag per row');
    const provider = persisted.providers[0];
    assert.equal(provider.id, 'provider-1');
    assert.equal(provider.baseUrl, 'https://new.example.test/v1');
    assert.equal(provider.apiKey, keyReference);
    assert.equal(provider.thinkingFormat, 'openai-effort');
    assert.equal(provider.models[0].id, 'new-model');
    assert.equal(provider.models[0].contextWindowTokens, 8_192);
    assert.deepEqual(provider.models[0].reasoningEfforts, { high: 'high' });
    assert.equal('customLegacyField' in provider, false);
    assert.equal(body.provider.model, 'new-model');

    const agentResponse = await fetch(`http://127.0.0.1:${address.port}/api/config/manage/agents/pi`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        coreToolIds: ['shell', 'shell', 'file'],
        knowledgeEntryIds: ['Bioinformatics/anndata', 'Bioinformatics/anndata'],
        defaultCoreToolIds: ['terminal', 'create_plan', 'load_skill_directory'],
        prompt: 'canonical prompt',
      }),
    });
    assert.equal(agentResponse.status, 200);
    const agents = JSON.parse(await readFile(path.join(configDir, 'agents.json'), 'utf8'));
    assert.deepEqual(agents.agents[0].coreToolIds, ['shell', 'file']);
    assert.deepEqual(agents.agents[0].knowledgeEntryIds, ['Bioinformatics/anndata']);
    assert.equal('defaultCoreToolIds' in agents.agents[0], false);
    assert.equal('enabled' in agents.agents[0], false);
    assert.equal(await readFile(path.join(configDir, 'prompts', 'pi.md'), 'utf8'), 'canonical prompt');

    const mcpResponse = await fetch(`http://127.0.0.1:${address.port}/api/config/manage/mcp/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: JSON.stringify({
          mcpServers: {
            search: {
              command: 'npx',
              args: ['-y', 1],
              env: { API_KEY: keyReference },
              headers: { Authorization: keyReference },
            },
            'search-provider': {
              url: 'https://mcp.example.test/mcp',
              internal: true,
            },
          },
        }),
      }),
    });
    assert.equal(mcpResponse.status, 200);
    const mcp = JSON.parse(await readFile(path.join(configDir, 'mcp.json'), 'utf8'));
    assert.deepEqual(mcp.servers[0], {
      id: 'search',
      name: 'search',
      description: '',
      command: 'npx',
      args: ['-y', '1'],
      env: { API_KEY: keyReference },
      transportType: 'stdio',
      url: '',
      headers: { Authorization: keyReference },
      enabled: true,
      internal: false,
      createdAt: mcp.servers[0].createdAt,
      updatedAt: mcp.servers[0].updatedAt,
    });
    assert.deepEqual(mcp.servers[1], {
      id: 'search-provider',
      name: 'search-provider',
      description: '',
      command: '',
      args: [],
      env: {},
      transportType: 'sse',
      url: 'https://mcp.example.test/mcp',
      headers: {},
      enabled: true,
      internal: true,
      createdAt: mcp.servers[1].createdAt,
      updatedAt: mcp.servers[1].updatedAt,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfigDir === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previousConfigDir;
    await rm(configDir, { recursive: true, force: true });
  }
});
