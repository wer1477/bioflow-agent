import assert from 'node:assert/strict';
import test from 'node:test';
import { canCopyAssistantMessage } from '../src/domain/message_copy_state.js';

test('assistant copy is unavailable until a streamed run completes', () => {
  assert.equal(canCopyAssistantMessage({ toolCalls: { run: { status: 'running' } } }), false);
  assert.equal(canCopyAssistantMessage({ toolCalls: { run: { status: 'completed' } } }), true);
  assert.equal(canCopyAssistantMessage({ toolCalls: null }), true);
  assert.equal(canCopyAssistantMessage({ toolCalls: { run: { status: 'completed' } } }, { isLive: true }), false);
});
