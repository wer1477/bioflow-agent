import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { KNOWLEDGEBASE_INLINE_RESULT_CHARS, TOOLLIBRARY_INLINE_RESULT_CHARS, TOOLLOAD_INLINE_RESULT_CHARS, createObservation, inlineResultBudget } from '../src/agent/observation_manager.js';
import { createTempProject } from './helpers/project_fixture.js';

test('the default inline budget stays at 6000 chars', () => {
  assert.equal(inlineResultBudget('exec_command'), 6000);
  assert.equal(inlineResultBudget('read_file'), 6000);
  assert.equal(inlineResultBudget('unknown_tool'), 6000);

  const observation = createObservation({ toolName: 'exec_command', result: 'x'.repeat(7000) });
  assert.equal(observation.mode, 'preview');
});

test('knowledgebase results stay inline up to 30000 chars', () => {
  assert.equal(KNOWLEDGEBASE_INLINE_RESULT_CHARS, 30000);
  assert.equal(inlineResultBudget('knowledgebase'), 30000);

  const result = 'x'.repeat(25000);
  const observation = createObservation({ toolName: 'knowledgebase', result });
  assert.equal(observation.mode, 'inline');
  assert.equal(observation.modelContent, result);
  // The UI event preview stays bounded even though the model gets the full text.
  assert.ok(observation.eventPreview.length <= 12100);
  assert.match(observation.eventPreview, /\[truncated\]$/);
});

test('a knowledgebase result above 30000 chars falls back to the observation pipeline', () => {
  const observation = createObservation({ toolName: 'knowledgebase', result: 'y'.repeat(30001) });
  assert.notEqual(observation.mode, 'inline');
  assert.match(observation.modelContent, /\[observation truncated\]/);
});

test('tool library browsing stays inline up to 30000 chars, skill loads up to 70000', () => {
  assert.equal(TOOLLIBRARY_INLINE_RESULT_CHARS, 30000);
  assert.equal(TOOLLOAD_INLINE_RESULT_CHARS, 70000);
  assert.equal(inlineResultBudget('toollibrary'), 30000);
  assert.equal(inlineResultBudget('toolload'), 70000);

  const catalogResult = 'x'.repeat(25000);
  const catalogObservation = createObservation({ toolName: 'toollibrary', result: catalogResult });
  assert.equal(catalogObservation.mode, 'inline');
  assert.equal(catalogObservation.modelContent, catalogResult);

  const skillResult = 'y'.repeat(60000);
  const skillObservation = createObservation({ toolName: 'toolload', result: skillResult });
  assert.equal(skillObservation.mode, 'inline');
  assert.equal(skillObservation.modelContent, skillResult);
});

test('a spilled observation is bounded and never advertises a removed retrieval tool', () => {
  const project = createTempProject('observation-file-mode');
  const conversation = createConversation({ title: 'observation', projectPath: project.projectPath });
  try {
    const result = 'z'.repeat(7000);
    const observation = createObservation({ conversationId: conversation.id, toolName: 'read_file', result });

    assert.equal(observation.mode, 'file');
    // Observations live in the session directory, outside the project root: handing the
    // model that path only produces a project-boundary refusal or an approval prompt.
    assert.equal(/\/\.sessions\//.test(observation.modelContent), false);
    assert.equal(observation.modelContent.includes('observationPath'), false);
    // history_lookup is unregistered while the context mechanism is rebuilt; the spill
    // note must not send the model after a capability that no longer exists.
    assert.equal(observation.modelContent.includes('history_lookup'), false);
    assert.match(observation.modelContent, /truncated/);
    // The model still gets a bounded view of the result itself.
    assert.ok(observation.modelContent.includes(result.slice(0, 100)));
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
