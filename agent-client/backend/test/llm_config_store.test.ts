import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deleteLLMProvider,
  getAllLLMProviders,
  getLLMProviderRecord,
  getLLMTarget,
  getRawLLMProviders,
  updateLLMProvider,
  upsertProviderModels,
} from '../src/agent/config/llm_config_store.js';

/**
 * The store owns the on-disk shape, so these tests pin both directions: what a legacy
 * file is read as, and what a save writes. They run against a temporary config dir
 * because `readConfig` resolves `BIOFLOW_CONFIG_DIR` per call.
 */
async function withConfigDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-llm-store-test-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('a v1 flat record is read as a v2 provider with the same runnable projection', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify([{
      id: 'dgx',
      baseUrl: 'https://your-llm-endpoint/v1',
      apiKey: '${TEST_LLM_API_KEY}',
      model: 'RadixArk/Qwen3.8-Flash-Next-NVFP4',
      contextWindowTokens: 1_000_000,
      thinkingLevel: 'medium',
      isDefault: true,
    }]));

    const [provider] = getAllLLMProviders();
    assert.equal(provider.id, 'dgx');
    assert.equal(provider.model, 'RadixArk/Qwen3.8-Flash-Next-NVFP4');
    assert.equal(provider.contextWindowTokens, 1_000_000);
    assert.equal(provider.thinkingLevel, 'medium');
    assert.equal(provider.thinkingWire, 'medium');
    assert.equal(provider.thinkingFormat, 'openai-effort');
    assert.equal(provider.isDefault, true);

    const [record] = getRawLLMProviders();
    assert.equal(record.models[0].id, 'RadixArk/Qwen3.8-Flash-Next-NVFP4');
    assert.deepEqual(record.models[0].reasoningEfforts, { medium: 'medium' });
    assert.equal(record.models[0].defaultThinkingLevel, 'medium');
    assert.equal(record.models[0].metadataSource, 'manual');
  });
});

test('a level name and its wire spelling can diverge without touching the model id', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify([{
      id: 'dgx',
      baseUrl: 'https://your-llm-endpoint/v1',
      apiKey: '${TEST_LLM_API_KEY}',
      model: 'qwen',
      contextWindowTokens: 1_000_000,
      isDefault: true,
    }]));
    updateLLMProvider('dgx', {
      models: [{
        id: 'qwen',
        contextWindowTokens: 1_000_000,
        // This endpoint names its top level `xhigh` and rejects `max` outright.
        reasoningEfforts: { medium: 'medium', high: 'high', max: 'xhigh' },
        defaultThinkingLevel: 'max',
      }],
    });

    const target = getLLMTarget('dgx');
    assert.equal(target.thinkingWire, 'xhigh');
    assert.equal(target.thinkingFormat, 'openai-effort');
  });
});

test('a legacy flat update patches the default model and preserves its siblings', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify({
      schemaVersion: 2,
      defaultProviderId: 'dgx',
      providers: [{
        id: 'dgx',
        name: 'DGX',
        baseUrl: 'http://old.example/v1',
        apiKey: '${TEST_LLM_API_KEY}',
        thinkingFormat: 'openai-effort',
        defaultModelId: 'first',
        models: [
          { id: 'first', contextWindowTokens: 1_000, metadataSource: 'manual' },
          { id: 'second', contextWindowTokens: 2_000, metadataSource: 'manual' },
        ],
      }],
    }));

    updateLLMProvider('dgx', { baseUrl: 'http://new.example/v1' });
    const record = getLLMProviderRecord('dgx');
    assert.equal(record.baseUrl, 'http://new.example/v1');
    assert.deepEqual(record.models.map((model) => model.id), ['first', 'second']);
    assert.equal(record.models[0].contextWindowTokens, 1_000, 'touching baseUrl must not clear the context window');

    updateLLMProvider('dgx', { thinkingLevel: 'high' });
    const patched = getLLMProviderRecord('dgx');
    assert.deepEqual(patched.models[0].reasoningEfforts, { high: 'high' });
    assert.equal(patched.models[1].reasoningEfforts, undefined, 'only the default model is patched');
  });
});

test('an importer never overwrites a hand-written model row', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify({
      schemaVersion: 2,
      providers: [{
        id: 'custom',
        name: 'custom',
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKey: '${TEST_LLM_API_KEY}',
        thinkingFormat: 'openai-effort',
        models: [{ id: 'mine', contextWindowTokens: 8_192, metadataSource: 'manual' }],
      }],
    }));

    upsertProviderModels('custom', [
      { id: 'mine', contextWindowTokens: 1_000_000 },
      { id: 'probed', contextWindowTokens: 32_768 },
    ], 'probe');

    const models = getLLMProviderRecord('custom').models;
    assert.equal(models[0].contextWindowTokens, 8_192, 'a manual row keeps the value the user typed');
    assert.equal(models[0].metadataSource, 'manual');
    assert.equal(models[1].id, 'probed');
    assert.equal(models[1].metadataSource, 'probe');
  });
});

test('a save writes the v2 document and drops fields it does not own', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify([{
      id: 'provider-1',
      base_url: 'https://old.example.test/v1',
      api_key: '${TEST_LLM_API_KEY}',
      model: 'old-model',
      context_window_tokens: 1_024,
      customLegacyField: 'must-not-survive-a-save',
      isDefault: true,
    }]));
    updateLLMProvider('provider-1', { contextWindowTokens: 8_192 });

    const persisted = JSON.parse(await readFile(path.join(dir, 'llm.json'), 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.defaultProviderId, 'provider-1');
    assert.equal(persisted.providers[0].id, 'provider-1');
    assert.equal(persisted.providers[0].baseUrl, 'https://old.example.test/v1');
    assert.equal(persisted.providers[0].models[0].contextWindowTokens, 8_192);
    assert.equal('customLegacyField' in persisted.providers[0], false);
    assert.equal(Array.isArray(persisted), false, 'the document, not a bare array, is the canonical shape');
  });
});

test('an unset or duplicated default resolves to a provider that exists', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify({
      schemaVersion: 2,
      defaultProviderId: 'gone',
      providers: [
        { id: 'a', name: 'a', baseUrl: 'http://a.test/v1', apiKey: '${TEST_LLM_API_KEY}', models: [{ id: 'm' }] },
        { id: 'b', name: 'b', baseUrl: 'http://b.test/v1', apiKey: '${TEST_LLM_API_KEY}', models: [{ id: 'm' }] },
      ],
    }));
    assert.equal(getAllLLMProviders().find((provider) => provider.isDefault).id, 'a');

    deleteLLMProvider('a');
    const remaining = getAllLLMProviders();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].isDefault, true);
  });
});

test('provider headers round-trip, survive partial updates, and can be cleared explicitly', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify({
      schemaVersion: 2,
      providers: [{
        id: 'opencode-go-2',
        name: 'OpenCode Go account 2',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: '${TEST_LLM_API_KEY}',
        headers: { 'x-opencode-session': 'session-1' },
        thinkingFormat: 'openai-effort',
        defaultModelId: 'deepseek-v4.1-flash',
        models: [{ id: 'deepseek-v4.1-flash', contextWindowTokens: 1_000_000 }],
      }],
    }));

    const [projection] = getAllLLMProviders();
    assert.deepEqual(projection.headers, { 'x-opencode-session': 'session-1' });
    assert.equal(projection.name, 'OpenCode Go account 2', 'the provider name is not replaced by the model label');

    // The Web editor does not send headers. Saving another field must not drop them.
    updateLLMProvider('opencode-go-2', { baseUrl: 'https://opencode.ai/zen/go/v1/' });
    assert.deepEqual(getLLMProviderRecord('opencode-go-2').headers, { 'x-opencode-session': 'session-1' });

    updateLLMProvider('opencode-go-2', { headers: { 'x-opencode-session': 'session-2', 'x-extra': 'yes' } });
    assert.deepEqual(getRawLLMProviders()[0].headers, { 'x-opencode-session': 'session-2', 'x-extra': 'yes' });

    updateLLMProvider('opencode-go-2', { headers: {} });
    assert.equal(getLLMProviderRecord('opencode-go-2').headers, undefined);
    const persisted = JSON.parse(await readFile(path.join(dir, 'llm.json'), 'utf8'));
    assert.equal('headers' in persisted.providers[0], false, 'cleared headers are not persisted');
  });
});

test('invalid header names, empty values and CR/LF injection are rejected on write', async () => {
  await withConfigDir(async (dir) => {
    await writeFile(path.join(dir, 'llm.json'), JSON.stringify({
      schemaVersion: 2,
      providers: [{
        id: 'p',
        name: 'p',
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKey: '${TEST_LLM_API_KEY}',
        thinkingFormat: 'openai-effort',
        models: [{ id: 'm', contextWindowTokens: 1_000 }],
      }],
    }));

    assert.throws(() => updateLLMProvider('p', { headers: { 'bad header': 'x' } }), /请求头/);
    assert.throws(() => updateLLMProvider('p', { headers: { 'x-test': 'a\r\nb' } }), /请求头/);
    assert.throws(() => updateLLMProvider('p', { headers: { 'x-test': '  ' } }), /请求头/);
    // A secret-shaped header must use an environment reference, like apiKey.
    assert.throws(() => updateLLMProvider('p', { headers: { authorization: 'Bearer literal' } }), /environment variable reference/);
    updateLLMProvider('p', { headers: { authorization: '${TEST_AUTH_TOKEN}' } });
    assert.deepEqual(getLLMProviderRecord('p').headers, { authorization: '${TEST_AUTH_TOKEN}' });
  });
});
