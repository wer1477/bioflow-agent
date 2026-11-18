import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPersistedRunEvent,
  TRANSCRIPT_MIRRORED_EVENT_TYPES,
} from '../src/agent/service/agent_service.js';
import type { AgentEvent } from '../src/agent/types.js';

/**
 * `applyRuntimeEvent` only forwards an event to `pushRunEvent` (UI stream + transcript
 * mirror) when `isPersistedRunEvent` accepts it. A type that is mirrored but not accepted
 * disappears without any error, so the two lists have to agree.
 *
 * Regression: `goal_change` was mirrored but not accepted, so `create_goal` returned the
 * new goal to the model while the transcript stayed empty — `get_goal` answered "no goal"
 * on the very next turn and the Web goal panel never rendered.
 */

/** `info` is the one exception: narration is buffered and pushed through `recordEvent`. */
const PUSHED_OUTSIDE_APPLY_RUNTIME_EVENT = new Set(['info']);

test('every mirrored event type can actually reach the transcript', () => {
  const unreachable = TRANSCRIPT_MIRRORED_EVENT_TYPES.filter(
    (type) => !PUSHED_OUTSIDE_APPLY_RUNTIME_EVENT.has(type) && !isPersistedRunEvent({ type } as AgentEvent),
  );
  assert.deepEqual(unreachable, [], 'mirrored but never pushed: these types would be silently dropped');
});

test('goal state documents survive the runtime event gate', () => {
  assert.equal(isPersistedRunEvent({ type: 'goal_change', operation: 'create', goal: null } as AgentEvent), true);
  assert.equal(isPersistedRunEvent({ type: 'goal_round', goalId: 'goal-1', revision: 1, round: 2 } as AgentEvent), true);
});

test('runtime-only streaming deltas stay out of the transcript', () => {
  for (const type of ['content', 'thinking', 'run_status']) {
    assert.equal(isPersistedRunEvent({ type } as AgentEvent), false, `${type} must not be persisted by itself`);
  }
});
