import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearActivatedToolNames,
  readActivatedToolNames,
  readSystemPromptHash,
  recordActivatedToolNames,
  recordSystemPromptHash,
} from '../src/agent/config/conversation_cache_state_store.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';

test('activated tool names are appended once and keep their first-activation order', () => {
  const project = createTempProject('tool-set-order');
  const conversation = createConversation({ title: 'tool set', projectPath: project.projectPath });
  try {
    assert.deepEqual(readActivatedToolNames(conversation.id), [], 'nothing installed yet');

    recordActivatedToolNames(conversation.id, ['tool_b', 'tool_a']);
    recordActivatedToolNames(conversation.id, ['tool_a', 'tool_c']);

    // Order is the position in the request: re-sorting or re-appending would move tokens
    // and defeat the point of keeping the array monotonic.
    assert.deepEqual(readActivatedToolNames(conversation.id), ['tool_b', 'tool_a', 'tool_c']);

    recordActivatedToolNames(conversation.id, ['tool_a']);
    assert.deepEqual(readActivatedToolNames(conversation.id), ['tool_b', 'tool_a', 'tool_c']);
  } finally {
    clearActivatedToolNames(conversation.id);
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('an unknown conversation is a no-op instead of an exception', () => {
  assert.deepEqual(readActivatedToolNames('no-such-conversation'), []);
  recordActivatedToolNames('no-such-conversation', ['tool_a']);
  assert.deepEqual(readActivatedToolNames('no-such-conversation'), []);
});

test('BIOFLOW_TOOL_SET_STABILITY=off restores the old per-run behaviour', () => {
  const project = createTempProject('tool-set-off');
  const conversation = createConversation({ title: 'tool set off', projectPath: project.projectPath });
  const previous = process.env.BIOFLOW_TOOL_SET_STABILITY;
  try {
    recordActivatedToolNames(conversation.id, ['tool_a']);
    assert.deepEqual(readActivatedToolNames(conversation.id), ['tool_a']);

    process.env.BIOFLOW_TOOL_SET_STABILITY = 'off';
    assert.deepEqual(readActivatedToolNames(conversation.id), [], 'persistence stops being read');
    recordActivatedToolNames(conversation.id, ['tool_b']);
    assert.deepEqual(readActivatedToolNames(conversation.id), [], 'and stops being written');

    process.env.BIOFLOW_TOOL_SET_STABILITY = previous;
    assert.deepEqual(readActivatedToolNames(conversation.id), ['tool_a'], 'the record is intact underneath');
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_TOOL_SET_STABILITY;
    else process.env.BIOFLOW_TOOL_SET_STABILITY = previous;
    clearActivatedToolNames(conversation.id);
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('the system prompt fingerprint is remembered per conversation', () => {
  const project = createTempProject('cache-state-hash');
  const conversation = createConversation({ title: 'hash', projectPath: project.projectPath });
  try {
    assert.equal(readSystemPromptHash(conversation.id), null, 'nothing assembled yet');

    recordSystemPromptHash(conversation.id, 'aaaa1111');
    assert.equal(readSystemPromptHash(conversation.id), 'aaaa1111');

    // The tool record must not drop the fingerprint, and vice versa: they share one file
    // because both answer "can the next request reuse the prefix".
    recordActivatedToolNames(conversation.id, ['tool_a']);
    assert.equal(readSystemPromptHash(conversation.id), 'aaaa1111');
    assert.deepEqual(readActivatedToolNames(conversation.id), ['tool_a']);

    recordSystemPromptHash(conversation.id, 'bbbb2222');
    assert.equal(readSystemPromptHash(conversation.id), 'bbbb2222');
    assert.deepEqual(readActivatedToolNames(conversation.id), ['tool_a']);
  } finally {
    clearActivatedToolNames(conversation.id);
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
