import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMessageDisposition } from '../src/domain/conversation_run_state.js';

test('a running conversation does not queue a message submitted in another conversation', () => {
  const runningConversationIds = new Set(['conversation-a']);

  assert.equal(resolveMessageDisposition(runningConversationIds, 'conversation-a'), 'queue');
  assert.equal(resolveMessageDisposition(runningConversationIds, 'conversation-b'), 'start');
});
