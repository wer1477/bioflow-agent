import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shipped preset overlay is hand-maintained, so it is validated here rather than at startup:
 * a typo degrades the create dialog at runtime (the loader tolerates unreadable overlays), while
 * this test fails the build. The overlay is a delta over the generated catalog — endpoints, display
 * names, thinking encoding, curated model order and featured ranking — so every curated id must
 * still exist in `llm_catalog.json`.
 */
const CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
const THINKING_FORMATS = new Set(['openai-effort', 'anthropic-budget', 'none']);
const PROTOCOLS = new Set(['openai-completions', 'anthropic-messages', 'openai-responses']);

function readConfig(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(CONFIG_DIR, name), 'utf8')) as Record<string, unknown>;
}

test('every shipped preset is a valid delta over the shipped catalog', () => {
  const presets = (readConfig('llm_presets.json').providers || []) as Record<string, unknown>[];
  const catalog = (readConfig('llm_catalog.json').providers || {}) as Record<string, Record<string, unknown>>;
  assert.ok(presets.length > 0, 'the overlay ships at least one preset');

  const seen = new Set<string>();
  for (const preset of presets) {
    const id = String(preset.id || '');
    assert.ok(id, 'every preset has an id');
    assert.ok(!seen.has(id), `duplicate preset id: ${id}`);
    seen.add(id);

    const provider = id in catalog ? catalog[id] : undefined;
    assert.ok(provider || typeof preset.api === 'string', `${id}: needs a catalog entry or its own api`);
    assert.equal(preset.env, undefined, `${id}: env belongs to the catalog, not the overlay`);

    if (preset.protocol !== undefined) {
      assert.ok(PROTOCOLS.has(String(preset.protocol)), `${id}: unknown protocol ${String(preset.protocol)}`);
    }
    if (preset.thinkingFormat !== undefined) {
      assert.ok(THINKING_FORMATS.has(String(preset.thinkingFormat)), `${id}: unknown thinkingFormat ${String(preset.thinkingFormat)}`);
    }
    if (preset.api !== undefined) {
      assert.match(String(preset.api), /^https?:\/\//, `${id}: api must be an absolute URL`);
    }
    if (preset.featured !== undefined) {
      assert.equal(typeof preset.featured, 'boolean', `${id}: featured must be a boolean`);
    }
    if (preset.featured === true) {
      assert.equal(typeof preset.priority, 'number', `${id}: a featured preset declares its priority`);
    }

    if (preset.modelIds === undefined) continue;
    assert.ok(Array.isArray(preset.modelIds), `${id}: modelIds must be an array`);
    const modelIds = preset.modelIds as string[];
    assert.equal(new Set(modelIds).size, modelIds.length, `${id}: duplicate modelIds`);
    if (!modelIds.length) continue; // endpoint-only preset: the editor probes it.
    assert.ok(provider, `${id}: curated models need a catalog entry`);
    const catalogModels = (provider.models || {}) as Record<string, unknown>;
    const missing = modelIds.filter((modelId) => !catalogModels[modelId]);
    assert.deepEqual(missing, [], `${id}: curated model ids missing from the catalog: ${missing.join(', ')}`);
  }

  const featured = presets.filter((preset) => preset.featured === true);
  assert.ok(featured.length >= 10, `the create dialog expects a mainstream group, found ${featured.length}`);
});

/**
 * The subscription plans are the providers the catalog alone cannot present: their ids are plan
 * endpoints (kimi.com/coding, bigmodel.cn/api/coding, token-plan.*) rather than the vendor's main
 * API, so a regression silently drops them back into the 200-provider long tail. Pin them by id
 * and require a curated model list — an empty list would mean "probe the endpoint", which the
 * operator cannot do before they own a key.
 */
test('the subscription plans ship as featured presets with curated models', () => {
  const presets = (readConfig('llm_presets.json').providers || []) as Record<string, unknown>[];
  const byId = new Map(presets.map((preset) => [String(preset.id), preset]));
  const plans = [
    'zhipuai-coding-plan',
    'kimi-code-plan-cn',
    'alibaba-token-plan-cn',
    'xiaomi-token-plan-cn',
    'minimax-cn',
    'moonshotai-cn',
  ];
  for (const id of plans) {
    const preset = byId.get(id);
    assert.ok(preset, `${id}: the create dialog drops a subscription plan without a preset`);
    assert.equal(preset.featured, true, `${id}: a subscription plan belongs in the mainstream group`);
    const modelIds = preset.modelIds as unknown[] | undefined;
    assert.ok(Array.isArray(modelIds) && modelIds.length > 0, `${id}: needs curated models, not endpoint probing`);
  }
});
