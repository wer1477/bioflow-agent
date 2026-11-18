import assert from 'node:assert/strict';
import test from 'node:test';
import {
  budgetLadderFor,
  defaultModelFor,
  describeLevelMap,
  describeModel,
  levelNames,
  levelsToMap,
  modelsForProvider,
  parseLevelMapText,
  planImport,
  requiresNumericLevels,
  roleModelSelection,
  serializeLevelMap,
  withCurrentOption,
} from '../src/domain/llm_options.js';

const llmProviders = [
  { id: 'dgx', name: 'dgx', model: 'qwen', thinkingFormat: 'openai-effort' },
  { id: 'd1', name: 'd1', model: 'deepseek', thinkingFormat: 'openai-effort' },
];

const llmModels = {
  dgx: [
    { id: 'qwen', label: 'Qwen3.8', contextWindowTokens: 1_000_000, thinkingLevels: ['medium', 'high', 'max'], capabilities: { tools: true } },
    { id: 'plain', label: 'Plain', contextWindowTokens: 128_000 },
  ],
  d1: [{ id: 'deepseek', label: 'DeepSeek', contextWindowTokens: 1_000_000, thinkingLevels: ['low', 'high'] }],
};

test('a level map round-trips through the text form the editor shows', () => {
  assert.equal(serializeLevelMap({ medium: 'medium', max: 'xhigh' }), 'medium\nmax=xhigh');
  assert.deepEqual(parseLevelMapText('medium\nmax=xhigh'), { medium: 'medium', max: 'xhigh' });
  assert.deepEqual(parseLevelMapText('low=1024\n\n  high = 16384 ', { numeric: true }), { low: 1024, high: 16384 });
  assert.deepEqual(parseLevelMapText('nonsense=abc', { numeric: true }), {}, 'a non-numeric budget is dropped, not guessed');
  assert.deepEqual(parseLevelMapText(''), {});
});

test('a level summary makes the name/wire split visible', () => {
  assert.equal(describeLevelMap({ medium: 'medium', max: 'xhigh' }), 'medium · max→xhigh');
  assert.equal(describeLevelMap({}), '未声明档位');
});

test('probed levels become an identity map or a budget ladder', () => {
  assert.deepEqual(levelsToMap(['low', 'high'], 'openai-effort'), { low: 'low', high: 'high' });
  assert.deepEqual(levelsToMap(['low', 'high'], 'anthropic-budget'), { low: 1024, high: 16384 });
  assert.equal(requiresNumericLevels('anthropic-budget'), true);
  assert.equal(requiresNumericLevels('openai-effort'), false);
});

test('the budget ladder covers every named level and never returns an invalid value', () => {
  assert.deepEqual(budgetLadderFor(['low', 'max']), { low: 1024, max: 32768 });
  assert.deepEqual(budgetLadderFor(['unknown']), { unknown: 4096 });
  assert.deepEqual(Object.keys(budgetLadderFor([])), ['low', 'medium', 'high', 'max']);
});

test('an import adds only what is missing', () => {
  const existing = [{ id: 'a' }, { id: 'b' }];
  const plan = planImport(existing, [{ id: 'b' }, { id: 'c' }, {}]);
  assert.deepEqual(plan.toAdd.map((model) => model.id), ['c']);
  assert.deepEqual(plan.skipped, ['b']);
});

test('a provider only shows its own models', () => {
  assert.deepEqual(modelsForProvider(llmModels, 'dgx').map((model) => model.id), ['qwen', 'plain']);
  assert.deepEqual(modelsForProvider(llmModels, 'missing'), []);
  assert.deepEqual(modelsForProvider(undefined, 'dgx'), []);
});

test('a stale binding stays visible instead of silently reading as unset', () => {
  const options = [{ value: 'qwen', label: 'Qwen' }];
  assert.deepEqual(withCurrentOption(options, 'qwen'), options);
  assert.equal(withCurrentOption(options, 'gone')[0].value, 'gone');
  assert.equal(withCurrentOption(options, 'gone')[0].disabled, true);
});

test('a role resolves to a runnable triple, falling back to the provider default', () => {
  const selected = roleModelSelection({ llmProviderId: 'dgx' }, llmProviders, llmModels);
  assert.equal(selected.modelId, 'qwen');
  assert.deepEqual(selected.levels, ['medium', 'high', 'max']);
  assert.equal(selected.level, 'medium');

  const explicit = roleModelSelection({ llmProviderId: 'dgx', llmModelId: 'plain' }, llmProviders, llmModels);
  assert.equal(explicit.modelId, 'plain');
  assert.deepEqual(explicit.levels, [], 'a model without levels offers no level');

  const stale = roleModelSelection({ llmProviderId: 'gone' }, llmProviders, llmModels);
  assert.equal(stale.modelId, '');
  assert.equal(stale.level, '');
});

test('the default model prefers the provider default, then the first row', () => {
  assert.equal(defaultModelFor({ defaultModelId: 'plain' }, [{ id: 'qwen' }, { id: 'plain' }]), 'plain');
  assert.equal(defaultModelFor({ defaultModelId: 'gone' }, [{ id: 'qwen' }]), 'qwen');
  assert.equal(defaultModelFor({}, []), '');
});

test('a model row summarises what the picker can promise', () => {
  assert.equal(describeModel({ contextWindowTokens: 1_000_000, thinkingLevels: ['a', 'b'], capabilities: { tools: true } }), '1M 上下文 · 2 档思考 · 工具');
  assert.equal(describeModel({}), '');
  assert.deepEqual(levelNames({ thinkingLevels: ['x'] }), ['x']);
});
