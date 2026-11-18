import assert from 'node:assert/strict';
import test from 'node:test';
import { runRegistry } from '../src/agent/run_registry.js';

test('two runs on one conversation are serialized, in arrival order', async () => {
  runRegistry.resetForTests();
  const order: string[] = [];
  const releaseFirst = await runRegistry.acquire('conversation-a');
  assert.equal(runRegistry.isActive('conversation-a'), true);

  let secondHeld = false;
  const second = runRegistry.acquire('conversation-a').then((release) => {
    secondHeld = true;
    order.push('second');
    release();
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondHeld, false, 'the second run must wait for the first');
  order.push('first');
  releaseFirst();
  await second;

  assert.deepEqual(order, ['first', 'second']);
  assert.equal(runRegistry.isActive('conversation-a'), false);
});

test('a different conversation is not blocked by a running one', async () => {
  runRegistry.resetForTests();
  const releaseA = await runRegistry.acquire('conversation-a');
  const releaseB = await runRegistry.acquire('conversation-b');
  assert.equal(runRegistry.isActive('conversation-a'), true);
  assert.equal(runRegistry.isActive('conversation-b'), true);
  releaseB();
  releaseA();
  assert.equal(runRegistry.anyActive(['conversation-a', 'conversation-b']), false);
});

test('release is idempotent and the queue keeps draining', async () => {
  runRegistry.resetForTests();
  const release = await runRegistry.acquire('conversation-c');
  release();
  release();
  assert.equal(runRegistry.isActive('conversation-c'), false);

  const releaseNext = await runRegistry.acquire('conversation-c');
  assert.equal(runRegistry.isActive('conversation-c'), true);
  releaseNext();
});

test('isActive counts a queued run, not only the holder', async () => {
  runRegistry.resetForTests();
  const release = await runRegistry.acquire('conversation-d');
  const queued = runRegistry.acquire('conversation-d');
  // The queued waiter has not started yet, but a second writer must already be refused.
  assert.equal(runRegistry.isActive('conversation-d'), true);
  assert.equal(runRegistry.anyActive(['other', 'conversation-d']), true);

  release();
  const releaseQueued = await queued;
  assert.equal(runRegistry.isActive('conversation-d'), true);
  releaseQueued();
  assert.equal(runRegistry.isActive('conversation-d'), false);
});
