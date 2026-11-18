import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import configManageRouter from '../src/http/routes/config_manage.js';
import settingsRouter from '../src/http/routes/settings.js';
import { resetCatalogCache } from '../src/agent/config/llm_catalog.js';

/**
 * The role editor needs two lists the runtime never needed before: the models of a provider
 * and the levels of a model. This pins the payload shape that the Web settings page consumes.
 */
test('the settings payload carries the model and level lists the role editor needs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-llm-surface-'));
  const previousConfig = process.env.BIOFLOW_CONFIG_DIR;
  const previousEnv = process.env.BIOFLOW_ENV_FILE;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  process.env.BIOFLOW_ENV_FILE = path.join(dir, '.env');
  resetCatalogCache();

  await writeFile(path.join(dir, '.env'), 'BIOFLOW_LLM_API_KEY_DGX=secret\n');
  await writeFile(path.join(dir, 'llm_catalog.json'), JSON.stringify({
    generatedAt: '2026-11-05T00:00:00.000Z',
    providers: { anthropic: { name: 'Anthropic', api: 'https://api.anthropic.com', npm: '@ai-sdk/anthropic', models: { 'claude-sonnet-5': { c: 200_000 } } } },
  }));
  await writeFile(path.join(dir, 'llm.json'), JSON.stringify({
    schemaVersion: 2,
    defaultProviderId: 'dgx',
    providers: [{
      id: 'dgx',
      name: 'dgx',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '${BIOFLOW_LLM_API_KEY_DGX}',
      headers: { 'x-opencode-session': 'session-1' },
      thinkingFormat: 'openai-effort',
      defaultModelId: 'qwen',
      models: [
        { id: 'qwen', label: 'Qwen', contextWindowTokens: 1_000_000, reasoningEfforts: { low: 'low', max: 'xhigh' }, defaultThinkingLevel: 'low' },
        { id: 'plain', contextWindowTokens: 128_000 },
      ],
    }],
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.use('/api/config/manage', configManageRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    // GET / returns the settings object directly; only POST /reload wraps it.
    const settings = await (await fetch(`${origin}/api/settings`)).json();
    assert.deepEqual(settings.llmModels.dgx.map((model) => model.id), ['qwen', 'plain']);
    assert.deepEqual(settings.llmModels.dgx[0].thinkingLevels, ['low', 'max']);
    assert.equal(settings.llmModels.dgx[1].thinkingLevels, undefined, 'a model without levels reports none');
    assert.equal(settings.llmProviders[0].apiKey, '${BIOFLOW_LLM_API_KEY_DGX}');
    // The provider's own name, not its default model's label: the editor writes this back.
    assert.equal(settings.llmProviders[0].name, 'dgx');
    assert.deepEqual(settings.llmProviders[0].headers, { 'x-opencode-session': 'session-1' });

    const catalog = await (await fetch(`${origin}/api/config/manage/llm/catalog?q=anthropic`)).json();
    assert.equal(catalog.generatedAt, '2026-11-05T00:00:00.000Z');
    assert.deepEqual(catalog.providers.map((provider) => provider.id), ['anthropic']);
    assert.equal(catalog.providers[0].suggestedThinkingFormat, 'anthropic-budget');

    // Model rows can be added without replacing the provider's credential or its other rows.
    const added = await fetch(`${origin}/api/config/manage/llm/dgx/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'catalog', models: [{ id: 'qwen', contextWindowTokens: 4 }, { id: 'extra', contextWindowTokens: 8_192 }] }),
    });
    assert.equal(added.status, 201);
    const persisted = JSON.parse(await readFile(path.join(dir, 'llm.json'), 'utf8'));
    const models = persisted.providers[0].models;
    assert.deepEqual(models.map((model) => model.id), ['qwen', 'plain', 'extra']);
    assert.equal(models[0].contextWindowTokens, 1_000_000, 'an import never overwrites an existing row');

    const removed = await fetch(`${origin}/api/config/manage/llm/dgx/models/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'extra' }),
    });
    assert.equal(removed.status, 200);
    const afterRemoval = JSON.parse(await readFile(path.join(dir, 'llm.json'), 'utf8'));
    assert.deepEqual(afterRemoval.providers[0].models.map((model) => model.id), ['qwen', 'plain']);

    // The Web editor payload has no headers field. Saving must keep the provider's map,
    // otherwise a config-file-only routing header disappears on the first UI save.
    const edited = await fetch(`${origin}/api/config/manage/llm/dgx`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'dgx',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: '${BIOFLOW_LLM_API_KEY_DGX}',
        thinkingFormat: 'openai-effort',
        defaultModelId: 'qwen',
        models: [
          { id: 'qwen', label: 'Qwen', contextWindowTokens: 1_000_000, reasoningEfforts: { low: 'low', max: 'xhigh' }, defaultThinkingLevel: 'low' },
          { id: 'plain', contextWindowTokens: 128_000 },
        ],
      }),
    });
    assert.equal(edited.status, 200);
    const afterEdit = JSON.parse(await readFile(path.join(dir, 'llm.json'), 'utf8'));
    assert.deepEqual(afterEdit.providers[0].headers, { 'x-opencode-session': 'session-1' });
  } finally {
    resetCatalogCache();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfig === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previousConfig;
    if (previousEnv === undefined) delete process.env.BIOFLOW_ENV_FILE;
    else process.env.BIOFLOW_ENV_FILE = previousEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
