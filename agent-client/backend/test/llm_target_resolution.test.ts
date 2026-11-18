import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { resolveLLMTarget, getLLMProviderRecord } from '../src/agent/config/llm_config_store.js';
import { countLLMProviderReferences } from '../src/agent/config/agent_config_store.js';
import configManageRouter from '../src/http/routes/config_manage.js';

const CONFIG_DIR = path.join(import.meta.dirname, '..', 'config');

async function withConfigDir<T>(files: Record<string, unknown>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-llm-target-test-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  try {
    for (const [name, value] of Object.entries(files)) {
      await writeFile(path.join(dir, name), JSON.stringify(value, null, 2));
    }
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function llmDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    defaultProviderId: 'dgx',
    providers: [{
      id: 'dgx',
      name: 'dgx',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '${TEST_LLM_API_KEY}',
      thinkingFormat: 'anthropic-budget',
      defaultModelId: 'fast',
      models: [
        {
          id: 'fast',
          contextWindowTokens: 1_000_000,
          reasoningEfforts: { low: 1024, high: 16384 },
          defaultThinkingLevel: 'low',
        },
        { id: 'deep', contextWindowTokens: 2_000_000 },
      ],
      ...overrides,
    }],
  };
}

test('a provider-only binding resolves to that provider\'s default model', async () => {
  await withConfigDir({ 'llm.json': llmDocument() }, async () => {
    const resolved = resolveLLMTarget({ providerId: 'dgx' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.provider.model, 'fast');
    assert.equal(resolved.provider.thinkingWire, 1024);
    assert.equal(resolved.provider.thinkingFormat, 'anthropic-budget');
  });
});

test('a named model wins over the default, and an absent model falls back to it', async () => {
  await withConfigDir({ 'llm.json': llmDocument() }, async () => {
    assert.equal(resolveLLMTarget({ providerId: 'dgx', modelId: 'deep' }).provider.model, 'deep');
    assert.equal(resolveLLMTarget({ providerId: 'dgx', modelId: '' }).provider.model, 'fast');
  });
});

test('a chosen level is translated to this provider\'s wire value', async () => {
  await withConfigDir({ 'llm.json': llmDocument() }, async () => {
    const resolved = resolveLLMTarget({ providerId: 'dgx', modelId: 'fast', thinkingLevel: 'high' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.provider.thinkingLevelName, 'high');
    assert.equal(resolved.provider.thinkingWire, 16384);
  });
});

test('a model without reasoning levels resolves with no thinking wire', async () => {
  await withConfigDir({ 'llm.json': llmDocument() }, async () => {
    const resolved = resolveLLMTarget({ providerId: 'dgx', modelId: 'deep' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.provider.thinkingWire, undefined);
    assert.deepEqual(resolved.provider.thinkingLevels, undefined);
  });
});

test('a binding that names something absent fails instead of falling back', async () => {
  await withConfigDir({ 'llm.json': llmDocument() }, async () => {
    const unknownProvider = resolveLLMTarget({ providerId: 'gone' });
    assert.equal(unknownProvider.ok, false);
    assert.equal(unknownProvider.reason, 'unknown-provider');
    assert.match(unknownProvider.message, /gone/);

    const unknownModel = resolveLLMTarget({ providerId: 'dgx', modelId: 'nope' });
    assert.equal(unknownModel.ok, false);
    assert.equal(unknownModel.reason, 'unknown-model');

    const unknownLevel = resolveLLMTarget({ providerId: 'dgx', modelId: 'fast', thinkingLevel: 'max' });
    assert.equal(unknownLevel.ok, false);
    assert.equal(unknownLevel.reason, 'unknown-level');
    assert.match(unknownLevel.message, /Available: low, high/);

    const noLevels = resolveLLMTarget({ providerId: 'dgx', modelId: 'deep', thinkingLevel: 'high' });
    assert.equal(noLevels.ok, false);
    assert.equal(noLevels.reason, 'unknown-level');
    assert.match(noLevels.message, /declares no thinking level/);
  });
});

test('an empty store reports a missing provider rather than returning undefined', async () => {
  await withConfigDir({ 'llm.json': [] }, async () => {
    const resolved = resolveLLMTarget({});
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, 'no-provider');
  });
});

test('deleting a referenced provider asks first, then clears the binding', async () => {
  const agents = {
    schemaVersion: 2,
    team: { leadRoleId: 'pi', roles: ['pi', 'searcher', 'researcher', 'writer', 'reviewer'], router: { engine: 'always-pi', fallbackRoleId: 'pi' }, limits: { maxConcurrentDispatches: 3 } },
    agents: [
      { id: 'pi', llmProviderId: 'dgx', llmModelId: 'deep', llmThinkingLevel: 'low' },
      { id: 'searcher', llmProviderId: 'dgx' },
    ],
  };
  await withConfigDir({ 'llm.json': llmDocument(), 'agents.json': agents }, async () => {
    assert.equal(countLLMProviderReferences('dgx'), 2);

    const app = express();
    app.use(express.json());
    app.use('/api/config/manage', configManageRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;

      const refused = await fetch(`${origin}/api/config/manage/llm/dgx`, { method: 'DELETE' });
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).references, 2);
      assert.ok(getLLMProviderRecord('dgx'), 'a refused delete leaves the provider in place');

      const forced = await fetch(`${origin}/api/config/manage/llm/dgx?force=1`, { method: 'DELETE' });
      assert.equal(forced.status, 200);
      assert.equal(getLLMProviderRecord('dgx'), undefined);
      assert.equal(countLLMProviderReferences('dgx'), 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('every role in the shipped configuration still resolves to a runnable model', async () => {
  // Guards the committed config rather than a fixture: a rename or a dropped model should
  // fail here, not on the first run of a deployed role.
  const llmJson = JSON.parse(await readFile(path.join(CONFIG_DIR, 'llm.json'), 'utf8'));
  const agentsJson = JSON.parse(await readFile(path.join(CONFIG_DIR, 'agents.json'), 'utf8'));
  assert.equal(llmJson.schemaVersion ?? 2, 2);

  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = CONFIG_DIR;
  try {
    for (const agent of agentsJson.agents) {
      const resolved = resolveLLMTarget({
        providerId: agent.llmProviderId || undefined,
        modelId: agent.llmModelId || undefined,
        thinkingLevel: agent.llmThinkingLevel || undefined,
      });
      assert.equal(resolved.ok, true, `${agent.id}: ${resolved.ok ? '' : resolved.message}`);
      assert.ok(resolved.provider.model, `${agent.id} resolves to a model id`);
      assert.ok(resolved.provider.contextWindowTokens, `${agent.id} has a context window`);
    }
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
  }
});
