import assert from 'node:assert/strict';
import test from 'node:test';
import { claimNextQueuedMessage } from '../src/domain/queue_scheduler.js';

test('a concurrent queue pump cannot claim two messages for the same conversation', () => {
  const queued = [
    { id: 'a', conversationId: 'conversation-1', message: 'first' },
    { id: 'b', conversationId: 'conversation-1', message: 'second' },
  ];
  const claimedConversationIds = new Set();

  const first = claimNextQueuedMessage(queued, new Set(), claimedConversationIds);
  const concurrent = claimNextQueuedMessage(queued, new Set(), claimedConversationIds);

  assert.equal(first?.item.id, 'a');
  assert.equal(concurrent, null);
});

test('queue pumps may claim different conversations in parallel', () => {
  const queued = [
    { id: 'a', conversationId: 'conversation-1', message: 'first' },
    { id: 'b', conversationId: 'conversation-2', message: 'second' },
  ];
  const claimedConversationIds = new Set();

  const first = claimNextQueuedMessage(queued, new Set(), claimedConversationIds);
  const second = claimNextQueuedMessage(queued, new Set(), claimedConversationIds);

  assert.equal(first?.item.id, 'a');
  assert.equal(second?.item.id, 'b');
});

test('a message pushed back by a busy server waits for its delay', () => {
  const queued = [{ id: 'a', conversationId: 'conversation-1', message: 'retry me', notBefore: 5_000 }];
  const claimed = new Set();

  assert.equal(claimNextQueuedMessage(queued, new Set(), claimed, 4_999), null, 'not before the delay');
  const later = claimNextQueuedMessage(queued, new Set(), claimed, 5_000);
  assert.equal(later?.item.id, 'a');
});

test('a message for a conversation that is running elsewhere is not claimed', () => {
  const queued = [{ id: 'a', conversationId: 'conversation-1', message: 'queued while busy' }];
  assert.equal(claimNextQueuedMessage(queued, new Set(['conversation-1']), new Set()), null);
});
