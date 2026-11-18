import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  catalogModelsAsEntries,
  getCatalogGeneratedAt,
  getCatalogProvider,
  listCatalogProviders,
  resetCatalogCache,
  suggestThinkingFormat,
} from '../src/agent/config/llm_catalog.js';

async function withCatalog<T>(fixture: unknown | null, run: (dir: string) => Promise<T>, presetsFixture: unknown = null): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-catalog-test-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  resetCatalogCache();
  try {
    if (fixture !== null) await writeFile(path.join(dir, 'llm_catalog.json'), JSON.stringify(fixture));
    if (presetsFixture !== null) await writeFile(path.join(dir, 'llm_presets.json'), JSON.stringify(presetsFixture));
    return await run(dir);
  } finally {
    resetCatalogCache();
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const fixture = {
  sourceUrl: 'https://models.dev/api.json',
  generatedAt: '2026-11-05T00:00:00.000Z',
  providers: {
    deepseek: {
      name: 'DeepSeek',
      api: 'https://api.deepseek.com',
      env: ['DEEPSEEK_API_KEY'],
      npm: '@ai-sdk/openai-compatible',
      models: {
        'deepseek-v4-flash': { name: 'DeepSeek V4.1 Flash', c: 1048576, o: 393216, r: true, eff: ['low', 'high', 'max'], t: true, img: true },
      },
    },
    anthropic: {
      name: 'Anthropic',
      api: 'https://api.anthropic.com',
      env: ['ANTHROPIC_API_KEY'],
      npm: '@ai-sdk/anthropic',
      models: {
        'claude-sonnet-5': { c: 200_000, o: 64_000, r: true, eff: ['low', 'medium', 'high'] },
        broken: null,
      },
    },
  },
};

test('a missing catalog degrades to no presets instead of failing', async () => {
  await withCatalog(null, async () => {
    assert.deepEqual(listCatalogProviders(), []);
    assert.equal(getCatalogProvider('deepseek'), undefined);
    assert.equal(getCatalogGeneratedAt(), undefined);
  });
});

test('presets are searchable by id, name and base URL', async () => {
  await withCatalog(fixture, async () => {
    assert.equal(getCatalogGeneratedAt(), '2026-11-05T00:00:00.000Z');
    assert.deepEqual(listCatalogProviders().map((provider) => provider.id), ['anthropic', 'deepseek']);
    assert.deepEqual(listCatalogProviders('anthropic').map((provider) => provider.id), ['anthropic']);
    assert.deepEqual(listCatalogProviders('api.deepseek').map((provider) => provider.id), ['deepseek']);
    assert.deepEqual(listCatalogProviders('nothing-here'), []);
  });
});

test('a malformed provider entry is skipped without failing the catalog', async () => {
  await withCatalog(fixture, async () => {
    const anthropic = getCatalogProvider('anthropic');
    assert.deepEqual(anthropic.models.map((model) => model.id), ['claude-sonnet-5']);
    assert.equal(anthropic.suggestedThinkingFormat, 'anthropic-budget');
    assert.equal(getCatalogProvider('deepseek').suggestedThinkingFormat, 'openai-effort');
  });
});

test('model metadata maps onto provider entries with an identity level map', async () => {
  await withCatalog(fixture, async () => {
    const [entry] = catalogModelsAsEntries(getCatalogProvider('deepseek').models);
    assert.equal(entry.id, 'deepseek-v4-flash');
    assert.equal(entry.label, 'DeepSeek V4.1 Flash');
    assert.equal(entry.contextWindowTokens, 1_048_576);
    assert.equal(entry.maxOutputTokens, 393_216);
    assert.deepEqual(entry.reasoningEfforts, { low: 'low', high: 'high', max: 'max' });
    assert.equal(entry.defaultThinkingLevel, 'low');
    assert.deepEqual(entry.capabilities, { tools: true, images: true });
    assert.equal(entry.metadataSource, 'catalog');
  });
});

test('the thinking format is a hint derived from the upstream package, never a claim', async () => {
  assert.equal(suggestThinkingFormat('@ai-sdk/anthropic'), 'anthropic-budget');
  assert.equal(suggestThinkingFormat('@ai-sdk/openai-compatible'), 'openai-effort');
  assert.equal(suggestThinkingFormat(undefined), 'openai-effort');
});

test('the curated preset overlay supplies endpoints, model order and featured ranking', async () => {
  const catalog = {
    generatedAt: '2026-11-05T00:00:00.000Z',
    providers: {
      openai: {
        name: 'OpenAI',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-a': { name: 'GPT A', c: 1_000, o: 100, r: true, eff: ['low', 'high'], t: true },
          'gpt-b': { name: 'GPT B', c: 2_000, o: 200, r: true, eff: ['low', 'high'], t: true },
          'gpt-c': { name: 'GPT C', c: 3_000, o: 300, r: true, t: true },
          'text-embedding-small': { name: 'Embedding Small' },
        },
      },
      anthropic: {
        name: 'Anthropic',
        api: 'https://api.anthropic.com/v1/messages',
        npm: '@ai-sdk/anthropic',
        models: { 'claude-x': { name: 'Claude X', c: 200_000, o: 8_000, r: true, t: true } },
      },
      deepseek: {
        name: 'DeepSeek',
        api: 'https://api.deepseek.com',
        npm: '@ai-sdk/openai-compatible',
        models: { 'deepseek-x': { name: 'DeepSeek X', c: 128_000, o: 8_000, t: true } },
      },
    },
  };
  const presets = {
    providers: [
      {
        id: 'openai', name: 'OpenAI (curated)', api: 'https://api.openai.com/v1', thinkingFormat: 'openai-effort',
        featured: true, priority: 100, modelIds: ['gpt-b', 'gpt-a'],
      },
      {
        id: 'anthropic', name: 'Anthropic Claude', api: 'https://api.anthropic.com/v1', thinkingFormat: 'none',
        protocol: 'anthropic-messages', featured: true, priority: 90, modelIds: ['claude-x'],
      },
      {
        id: 'ollama', name: 'Ollama', api: 'http://127.0.0.1:11434/v1', thinkingFormat: 'openai-effort',
        featured: true, priority: 10, modelIds: [],
      },
    ],
  };

  await withCatalog(catalog, async () => {
    assert.deepEqual(listCatalogProviders().map((provider) => provider.id), ['openai', 'anthropic', 'ollama', 'deepseek']);
    assert.deepEqual(listCatalogProviders('api.openai.com').map((provider) => provider.id), ['openai']);
    assert.equal(listCatalogProviders('ollama')[0].modelCount, 0);

    const openaiSummary = listCatalogProviders('openai')[0];
    assert.equal(openaiSummary.api, 'https://api.openai.com/v1');
    assert.equal(openaiSummary.name, 'OpenAI (curated)');
    assert.equal(openaiSummary.modelCount, 2);
    assert.equal(openaiSummary.featured, true);

    const openai = getCatalogProvider('openai');
    assert.deepEqual(openai?.models.map((model) => model.id), ['gpt-b', 'gpt-a']);
    assert.equal(openai?.suggestedThinkingFormat, 'openai-effort');

    const anthropic = getCatalogProvider('anthropic');
    assert.equal(anthropic?.api, 'https://api.anthropic.com/v1');
    assert.equal(anthropic?.suggestedThinkingFormat, 'none');
    // The protocol is a provider identity, not decoration: it must survive the projection
    // the create dialog reads, otherwise the adapter is unreachable from a preset.
    assert.equal(anthropic?.protocol, 'anthropic-messages');
    assert.equal(listCatalogProviders('anthropic')[0].protocol, 'anthropic-messages');
    // An OpenAI-compatible preset says nothing, which means "the default".
    assert.equal(getCatalogProvider('openai')?.protocol, undefined);

    assert.deepEqual(getCatalogProvider('ollama')?.models, []);
    assert.equal(getCatalogProvider('deepseek')?.api, 'https://api.deepseek.com');
    assert.equal(getCatalogProvider('deepseek')?.suggestedThinkingFormat, 'openai-effort');
  }, presets);
});

test('a malformed preset overlay is ignored instead of hiding the catalog', async () => {
  await withCatalog(fixture, async () => {
    assert.deepEqual(listCatalogProviders().map((provider) => provider.id), ['anthropic', 'deepseek']);
    assert.equal(getCatalogProvider('deepseek')?.api, 'https://api.deepseek.com');
  }, { providers: 'not-an-array' });
});

test('a stale curated list falls back to the catalog instead of an empty provider', async () => {
  const catalog = {
    generatedAt: '2026-11-05T00:00:00.000Z',
    providers: {
      alpha: {
        name: 'Alpha',
        api: 'https://api.alpha.example/v1',
        npm: '@ai-sdk/openai-compatible',
        models: { 'alpha-new': { name: 'Alpha New', c: 1_000, t: true }, 'alpha-alt': { name: 'Alpha Alt', c: 2_000, t: true } },
      },
      beta: {
        name: 'Beta',
        npm: '@ai-sdk/openai-compatible',
        models: { 'beta-one': { name: 'Beta One', c: 1_000, t: true } },
      },
    },
  };
  const presets = {
    providers: [
      // The whole curated list rotated out: fall back to the catalog's full list.
      { id: 'alpha', api: 'https://api.alpha.example/v1', featured: true, priority: 10, modelIds: ['alpha-retired'] },
      // An empty list still means endpoint-only, not "everything".
      { id: 'beta', featured: true, priority: 5, modelIds: [] },
    ],
  };

  await withCatalog(catalog, async () => {
    assert.equal(listCatalogProviders('alpha')[0].modelCount, 2);
    assert.deepEqual(getCatalogProvider('alpha')?.models.map((model) => model.id), ['alpha-alt', 'alpha-new']);
    assert.equal(listCatalogProviders('beta')[0].modelCount, 0);
    assert.deepEqual(getCatalogProvider('beta')?.models, []);
    // The overlay is a delta: environment-variable names come from the catalog only.
    assert.deepEqual(listCatalogProviders('alpha')[0].env, []);
  }, presets);
});
