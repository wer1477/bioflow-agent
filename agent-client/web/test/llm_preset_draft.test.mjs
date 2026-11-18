import assert from 'node:assert/strict';
import test from 'node:test';
import { draftForPreset, selectPresetDraft } from '../src/domain/llm_preset_draft.js';

const openai = {
  id: 'openai',
  name: 'OpenAI',
  api: 'https://api.openai.com/v1',
  suggestedThinkingFormat: 'openai-effort',
  modelCount: 2,
};
const anthropic = {
  id: 'anthropic',
  name: 'Anthropic Claude',
  api: 'https://api.anthropic.com/v1',
  suggestedThinkingFormat: 'none',
  modelCount: 1,
};
const ollama = {
  id: 'ollama',
  name: 'Ollama',
  api: 'http://127.0.0.1:11434/v1',
  suggestedThinkingFormat: 'openai-effort',
  modelCount: 0,
};

function blankEditor() {
  return {
    mode: 'create',
    draft: {
      id: '',
      presetId: 'custom',
      name: '',
      baseUrl: '',
      apiKey: '',
      thinkingFormat: 'openai-effort',
      defaultModelId: '',
      models: [],
    },
    drafts: {},
  };
}

test('a preset draft copies the catalog identity and asks for its models', () => {
  const draft = draftForPreset(anthropic);
  assert.equal(draft.presetId, 'anthropic');
  assert.equal(draft.name, 'Anthropic Claude');
  assert.equal(draft.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(draft.thinkingFormat, 'none');
  assert.equal(draft.apiKey, '');
  assert.deepEqual(draft.models, []);

  const selected = selectPresetDraft(blankEditor(), openai);
  assert.equal(selected.draft.presetId, 'openai');
  assert.equal(selected.loadModels, true);
});

test('switching back restores the key and model rows typed for that preset', () => {
  const first = selectPresetDraft(blankEditor(), openai);
  const typed = {
    ...first.draft,
    apiKey: 'sk-test',
    models: [{ id: 'gpt-a', contextWindowTokens: '1000' }],
    defaultModelId: 'gpt-a',
  };

  const second = selectPresetDraft({ mode: 'create', draft: typed, drafts: first.drafts }, anthropic);
  assert.equal(second.draft.presetId, 'anthropic');
  assert.equal(second.draft.apiKey, '', 'a different provider never keeps the previous key');
  assert.deepEqual(second.draft.models, []);
  assert.equal(second.loadModels, true);

  const back = selectPresetDraft({ mode: 'create', draft: second.draft, drafts: second.drafts }, openai);
  assert.equal(back.draft.apiKey, 'sk-test');
  assert.deepEqual(back.draft.models.map((model) => model.id), ['gpt-a']);
  assert.equal(back.loadModels, false, 'a remembered draft already carries its rows');
});

test('re-selecting the active preset keeps manual edits and fetches nothing', () => {
  const selected = selectPresetDraft(blankEditor(), openai);
  const edited = { ...selected.draft, name: 'My OpenAI', baseUrl: 'https://gateway.example/v1' };
  const again = selectPresetDraft({ mode: 'create', draft: edited, drafts: selected.drafts }, openai);
  assert.equal(again.draft.name, 'My OpenAI');
  assert.equal(again.draft.baseUrl, 'https://gateway.example/v1');
  assert.equal(again.loadModels, false);
});

test('an endpoint-only preset is never asked for catalog models', () => {
  const selected = selectPresetDraft(blankEditor(), ollama);
  assert.equal(selected.draft.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(selected.loadModels, false);
  assert.deepEqual(selected.draft.models, []);
});
