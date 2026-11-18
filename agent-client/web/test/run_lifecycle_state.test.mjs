import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRunStatus, isRunActive } from '../src/domain/run_lifecycle_state.js';

test('run_status, rather than stream completion, determines whether a run is active', () => {
  let states = new Map();
  states = applyRunStatus(states, 'conversation-1', { runId: 'run-1', status: 'building_context' });
  assert.equal(isRunActive(states.get('conversation-1')), true);

  states = applyRunStatus(states, 'conversation-1', { runId: 'run-1', status: 'tool_execution' });
  assert.equal(states.get('conversation-1').status, 'tool_execution');
  assert.equal(isRunActive(states.get('conversation-1')), true);

  states = applyRunStatus(states, 'conversation-1', { runId: 'run-1', status: 'failed', stopReason: 'tool_error' });
  assert.equal(isRunActive(states.get('conversation-1')), false);
  assert.equal(states.get('conversation-1').stopReason, 'tool_error');
});

test('a persisted terminal run reconciles a stream that ended without done', () => {
  const states = applyRunStatus(new Map(), 'conversation-1', {
    runId: 'run-1',
    status: 'cancelled',
    stopReason: 'cancelled',
  });

  assert.equal(states.get('conversation-1').status, 'cancelled');
  assert.equal(isRunActive(states.get('conversation-1')), false);
});

test('startedAt keeps the first active instant of one run', () => {
  let states = applyRunStatus(new Map(), 'conversation-1', { runId: '', status: 'starting' }, 1_000);
  states = applyRunStatus(states, 'conversation-1', { runId: 'run-1', status: 'building_context' }, 1_200);
  states = applyRunStatus(states, 'conversation-1', { runId: 'run-1', status: 'model_turn' }, 5_000);

  assert.equal(states.get('conversation-1').startedAt, 1_000);
});

test('a new run re-bases startedAt after the previous run finished', () => {
  let states = applyRunStatus(new Map(), 'conversation-1', { runId: 'run-1', status: 'building_context' }, 1_000);
  states = applyRunStatus(states, 'conversation-1', { runId: 'run-1', status: 'completed' }, 9_000);
  // 终态保留旧值，方便状态表回看；active=false，渲染不依赖它。
  assert.equal(states.get('conversation-1').startedAt, 1_000);

  states = applyRunStatus(states, 'conversation-1', { runId: '', status: 'starting' }, 12_000);
  assert.equal(states.get('conversation-1').startedAt, 12_000);
});

test('startedAt is zero when the caller does not provide a clock', () => {
  const states = applyRunStatus(new Map(), 'conversation-1', { runId: 'run-1', status: 'model_turn' });
  assert.equal(states.get('conversation-1').startedAt, 0);
});
