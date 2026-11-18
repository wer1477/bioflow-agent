import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgeSeen,
  mergeRunningIds,
  pruneSeen,
  seenSequence,
  shouldReloadSettledConversation,
  unseenCompletions,
} from '../src/domain/activity_view.js';

const conversations = {
  team: { running: true, runningRoles: ['researcher'], seq: 0 },
  settled: { running: false, runId: 'run-2', status: 'completed', finishedAt: '2026-11-01T02:00:00.000Z', seq: 4 },
  failed: { running: false, runId: 'run-3', status: 'failed', finishedAt: '2026-11-01T02:05:00.000Z', seq: 5 },
};

test('local run state and server activity are merged, not replaced', () => {
  const ids = mergeRunningIds(['local'], ['team'], ['team', 'another-view']);
  assert.equal(ids.has('local'), true, 'a run this tab just started counts immediately');
  assert.equal(ids.has('team'), true, 'a run reported by the backend counts too');
  assert.equal(ids.has('another-view'), true);
  assert.equal(ids.has('settled'), false);
  assert.equal(mergeRunningIds(undefined, undefined).size, 0);
});

test('a completion shows until that exact run has been seen', () => {
  assert.deepEqual([...unseenCompletions({ settled: conversations.settled }, { epoch: 'e1', seen: {} }, 'other')], ['settled']);
  assert.equal(unseenCompletions({ settled: conversations.settled }, { epoch: 'e1', seen: { settled: 4 } }, 'other').size, 0);
  assert.equal(unseenCompletions({ settled: conversations.settled }, { epoch: 'e1', seen: { settled: 3 } }, 'other').size, 1);
});

test('the conversation on screen never dots itself, and failed runs do not dot', () => {
  assert.equal(unseenCompletions({ settled: conversations.settled }, { epoch: 'e1', seen: {} }, 'settled').size, 0);
  assert.equal(unseenCompletions({ failed: conversations.failed }, { epoch: 'e1', seen: {} }, 'other').size, 0);
  assert.equal(unseenCompletions({ team: conversations.team }, { epoch: 'e1', seen: {} }, 'other').size, 0, 'a running conversation has no completion yet');
});

test('acknowledging is monotonic and ignores counters from a previous process', () => {
  const first = acknowledgeSeen({ epoch: 'e1', seen: {} }, { epoch: 'e1', conversationId: 'team', seq: 3 });
  assert.equal(seenSequence(first, 'team'), 3);
  assert.equal(acknowledgeSeen(first, { epoch: 'e1', conversationId: 'team', seq: 2 }), first, 'an older sequence changes nothing');
  assert.equal(acknowledgeSeen(first, { epoch: 'e1', conversationId: 'team', seq: 0 }), first, 'no completion, no marker');

  const restarted = acknowledgeSeen(first, { epoch: 'e2', conversationId: 'team', seq: 1 });
  assert.deepEqual(restarted, { epoch: 'e2', seen: { team: 1 } }, 'counters do not survive a backend restart');
});

test('seen markers are pruned to the conversations that still have activity', () => {
  const seen = { epoch: 'e1', seen: { team: 2, gone: 1 } };
  assert.deepEqual(pruneSeen(seen, new Set(['team'])), { epoch: 'e1', seen: { team: 2 } });
  assert.equal(pruneSeen(seen, new Set(['team', 'gone'])), seen);
});

test('watching a run settle reloads the transcript exactly once', () => {
  const running = { running: true, runId: 'run-4', seq: 4 };
  const settled = { running: false, status: 'completed', finishedAt: '2026-11-07T03:11:51.000Z', seq: 5 };

  assert.equal(shouldReloadSettledConversation(4, running), false, 'a running run stays live, no reload');
  assert.equal(shouldReloadSettledConversation(4, settled), true, 'the first settle after watching it run must reload');
  assert.equal(shouldReloadSettledConversation(5, settled), false, 'the same sequence must not reload again');
  assert.equal(shouldReloadSettledConversation(undefined, settled), false, 'opening a finished conversation already loaded it');
});
