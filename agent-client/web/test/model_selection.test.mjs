import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelCatalog,
  catalogProviderName,
  effortLevels,
  isRoutable,
  modelCount,
  modelLabel,
  providerGroups,
  roleLlm,
  sameSelection,
  targetRoleId,
  triggerLabel,
} from '../src/domain/model_selection.js';

const settingsShape = {
  llmProviders: [
    { id: 'dgx', name: 'dgx' },
    { id: 'opencode', name: 'OpenCode' },
  ],
  llmModels: {
    dgx: [{ id: 'qwen', label: 'Qwen3.8', thinkingLevels: ['medium'] }],
    opencode: [
      { id: 'flash', label: 'DeepSeek V4.1 Flash', thinkingLevels: ['low', 'high', 'max'] },
      { id: 'pro', label: 'DeepSeek V4 Pro', thinkingLevels: ['high', 'max'] },
    ],
  },
};

const userShape = {
  systemProviders: [{ id: 'dgx', name: 'dgx' }],
  providers: [{ id: 'mine', name: 'My Endpoint' }],
  modelOptions: {
    dgx: [{ id: 'qwen', label: 'Qwen3.8', thinkingLevels: ['medium'] }],
    mine: [{ id: 'local', label: 'Local Model' }],
  },
};

test('the catalog normalizes both sources the app can load', () => {
  const fromSettings = buildModelCatalog({ settings: settingsShape });
  assert.deepEqual(fromSettings.providers.map((provider) => provider.id), ['dgx', 'opencode']);
  assert.deepEqual(fromSettings.models.opencode.map((model) => model.id), ['flash', 'pro']);
  assert.deepEqual(fromSettings.models.dgx[0].thinkingLevels, ['medium']);

  // A signed-in regular user gets system presets plus their own providers; that source wins.
  const fromUser = buildModelCatalog({ settings: settingsShape, userLlm: userShape });
  assert.deepEqual(fromUser.providers.map((provider) => provider.id), ['dgx', 'mine']);
  assert.equal(modelCount(fromUser), 2);
  assert.deepEqual(buildModelCatalog({}).providers, []);
});

test('the trigger prints the model label and the effort, and drops the effort when absent', () => {
  const catalog = buildModelCatalog({ settings: settingsShape });
  assert.equal(triggerLabel(catalog, { providerId: 'opencode', modelId: 'flash', thinkingLevel: 'high' }), 'DeepSeek V4.1 Flash · high');
  assert.equal(triggerLabel(catalog, { providerId: 'opencode', modelId: 'flash' }), 'DeepSeek V4.1 Flash');
  // A selection the catalog cannot see keeps its raw ids instead of pretending to be empty.
  assert.equal(modelLabel(catalog, { providerId: 'ghost', modelId: 'ghost-model' }), 'ghost-model');
  assert.equal(modelLabel(catalog, null), '未选择模型');
  assert.equal(catalogProviderName(catalog, 'opencode'), 'OpenCode');
  assert.equal(catalogProviderName(catalog, 'ghost'), 'ghost');
});

test('effort levels come from the selected model, never from the previous one', () => {
  const catalog = buildModelCatalog({ settings: settingsShape });
  assert.deepEqual(effortLevels(catalog, { providerId: 'opencode', modelId: 'pro' }), ['high', 'max']);
  assert.deepEqual(effortLevels(catalog, { providerId: 'mine', modelId: 'local' }), []);
  assert.deepEqual(effortLevels(catalog, { providerId: 'ghost', modelId: 'x' }), []);
});

test('provider groups filter by model, provider name and id, dropping empty groups', () => {
  const catalog = buildModelCatalog({ settings: settingsShape });
  assert.deepEqual(providerGroups(catalog, '').map((group) => group.id), ['dgx', 'opencode']);
  assert.deepEqual(providerGroups(catalog, 'deepseek').map((group) => group.id), ['opencode']);
  assert.deepEqual(providerGroups(catalog, 'pro').map((group) => group.id), ['opencode']);
  assert.deepEqual(providerGroups(catalog, 'opencode').map((group) => group.id), ['opencode']);
  assert.deepEqual(providerGroups(catalog, 'nothing'), []);
  // Filtering keeps one group's models, not the whole catalog.
  assert.deepEqual(providerGroups(catalog, 'pro')[0].models.map((model) => model.id), ['pro']);
});

test('the target role is the session role, else the role that last took over', () => {
  const team = { activeRoleId: 'searcher', leadRoleId: 'pi' };
  assert.equal(targetRoleId(team, { roleId: 'writer' }), 'writer');
  assert.equal(targetRoleId(team, { roleId: null }), 'searcher');
  assert.equal(targetRoleId({ leadRoleId: 'pi' }, null), 'pi');
  assert.equal(targetRoleId(null, null), '');
});

test('the role llm view is read off the team payload', () => {
  const team = {
    activeRoleId: 'pi',
    roles: [
      { id: 'pi', label: 'PI', llm: { override: null, selection: { providerId: 'dgx', modelId: 'qwen', thinkingLevel: 'medium' }, source: 'role', routable: true } },
      { id: 'searcher', label: 'Searcher' },
    ],
  };
  assert.equal(roleLlm(team, 'pi').source, 'role');
  assert.equal(roleLlm(team, 'searcher'), null);
  assert.equal(roleLlm(team, 'ghost'), null);
  assert.equal(roleLlm(null, 'pi'), null);
});

test('a selection is routable only when the catalog can still serve it', () => {
  const catalog = buildModelCatalog({ settings: settingsShape });
  assert.equal(isRoutable(catalog, { routable: true, selection: { providerId: 'dgx', modelId: 'qwen' } }), true);
  assert.equal(isRoutable(catalog, { routable: true, selection: { providerId: 'ghost', modelId: 'qwen' } }), false);
  assert.equal(isRoutable(catalog, { routable: false, selection: { providerId: 'dgx', modelId: 'qwen' } }), false);
  assert.equal(isRoutable(catalog, null), false);
});

test('sameSelection ignores an absent level and compares the rest', () => {
  assert.equal(sameSelection({ providerId: 'a', modelId: 'b' }, { providerId: 'a', modelId: 'b', thinkingLevel: '' }), true);
  assert.equal(sameSelection({ providerId: 'a', modelId: 'b', thinkingLevel: 'high' }, { providerId: 'a', modelId: 'b', thinkingLevel: 'max' }), false);
  assert.equal(sameSelection(null, { providerId: 'a' }), false);
});
