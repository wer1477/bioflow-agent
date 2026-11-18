import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGoalMutation,
  canStartGoalRound,
  DEFAULT_GOAL_MAX_ROUNDS,
  foldConversationPanels,
  GoalTransitionError,
  normalizeTodoItems,
  renderGoalRoundPrompt,
  type GoalState,
} from '../src/agent/conversation_panels.js';
import type { TranscriptRecord } from '../src/agent/transcript_log.js';

let sequence = 0;

/** One engine event record, shaped exactly as the recorder writes it. */
function engineEvent(event: Record<string, unknown>): TranscriptRecord {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    createdAt: new Date(sequence * 1000).toISOString(),
    conversationId: 'conversation-1',
    runId: 'run-1',
    type: 'engine_event',
    data: { event },
  };
}

function todoPanel(todos: Array<Record<string, unknown>>, status = 'active'): Record<string, unknown> {
  return { type: 'planning_panel', panel: 'todo', status, title: '计划', todos };
}

function goalChange(goal: Record<string, unknown> | null, operation = 'create'): Record<string, unknown> {
  return { type: 'goal_change', operation, goal };
}

function goalDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'goal-1',
    revision: 1,
    objective: 'Finish the analysis',
    phase: 'active',
    maxRounds: 5,
    autoContinue: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function activeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    revision: 1,
    objective: 'Finish the analysis',
    phase: 'active',
    maxRounds: 5,
    autoContinue: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    roundsStarted: 0,
    ...overrides,
  };
}

test('normalizeTodoItems keeps the three-state status verbatim', () => {
  const todos = normalizeTodoItems([
    { id: 'a', text: 'find data', status: 'completed' },
    { id: 'b', text: 'align reads', status: 'in_progress' },
    { id: 'c', text: 'call variants', status: 'pending' },
  ]);
  assert.deepEqual(todos.map((todo) => todo.status), ['completed', 'in_progress', 'pending']);
});

test('normalizeTodoItems reads the legacy done boolean', () => {
  const todos = normalizeTodoItems([
    { id: 'a', text: 'old finished', done: true },
    { id: 'b', text: 'old open', done: false },
  ]);
  assert.deepEqual(todos.map((todo) => todo.status), ['completed', 'pending']);
});

test('normalizeTodoItems rejects empty, duplicate and unknown input', () => {
  assert.throws(() => normalizeTodoItems([{ text: '   ' }]), /non-empty/);
  assert.throws(() => normalizeTodoItems([{ text: 'same' }, { text: 'same' }]), /duplicate/);
  assert.throws(() => normalizeTodoItems([{ text: 'x', status: 'doing' }]), /status must be one of/);
});

test('fold keeps the last todo list and clears it on complete', () => {
  const records = [
    engineEvent(todoPanel([{ text: 'one', status: 'pending' }])),
    engineEvent(todoPanel([{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }])),
  ];
  const panels = foldConversationPanels(records);
  assert.deepEqual(panels.todos?.map((todo) => todo.text), ['one', 'two']);
  assert.equal(panels.todos?.[1]?.status, 'in_progress');

  const cleared = foldConversationPanels([...records, engineEvent(todoPanel([], 'complete'))]);
  assert.equal(cleared.todos, null);
});

test('fold reads a legacy transcript with done booleans', () => {
  const records = [engineEvent(todoPanel([{ id: 'a', text: 'legacy row', done: true }]))];
  assert.equal(foldConversationPanels(records).todos?.[0]?.status, 'completed');
});

test('fold counts goal rounds for the current goal only', () => {
  const records = [
    engineEvent(goalChange(goalDocument())),
    engineEvent({ type: 'goal_round', goalId: 'goal-1', revision: 1, round: 1 }),
    engineEvent({ type: 'goal_round', goalId: 'goal-1', revision: 1, round: 2 }),
    engineEvent({ type: 'goal_round', goalId: 'goal-other', revision: 1, round: 9 }),
  ];
  const panels = foldConversationPanels(records);
  assert.equal(panels.goal?.roundsStarted, 2);
});

test('fold resets rounds when a new goal id replaces the old one', () => {
  const records = [
    engineEvent(goalChange(goalDocument())),
    engineEvent({ type: 'goal_round', goalId: 'goal-1', revision: 1, round: 3 }),
    engineEvent(goalChange(goalDocument({ id: 'goal-2', revision: 1, createdAt: '2026-01-01T00:00:00.000Z' }))),
  ];
  assert.equal(foldConversationPanels(records).goal?.roundsStarted, 0);
});

test('fold treats a null goal as a clear tombstone', () => {
  const records = [engineEvent(goalChange(goalDocument())), engineEvent(goalChange(null, 'clear'))];
  assert.equal(foldConversationPanels(records).goal, null);
});

test('create refuses to replace a goal that is still running', () => {
  assert.throws(
    () => applyGoalMutation(activeGoal(), { operation: 'create', objective: 'another' }),
    (error: GoalTransitionError) => error.code === 'GOAL_ALREADY_EXISTS',
  );
});

test('create replaces a completed goal and starts a fresh revision series', () => {
  const completed = activeGoal({ phase: 'complete', autoContinue: false, roundsStarted: 4 });
  const next = applyGoalMutation(completed, { operation: 'create', objective: '  new objective  ' });
  assert.equal(next?.revision, 1);
  assert.equal(next?.objective, 'new objective');
  assert.equal(next?.roundsStarted, 0);
  assert.equal(next?.maxRounds, DEFAULT_GOAL_MAX_ROUNDS);
  assert.equal(next?.autoContinue, true);
});

test('pause disarms and resume re-arms without losing the round count', () => {
  const paused = applyGoalMutation(activeGoal({ roundsStarted: 2 }), { operation: 'pause' });
  assert.equal(paused?.phase, 'paused');
  assert.equal(paused?.autoContinue, false);
  assert.equal(paused?.roundsStarted, 2);

  const resumed = applyGoalMutation(paused, { operation: 'resume' });
  assert.equal(resumed?.phase, 'active');
  assert.equal(resumed?.autoContinue, true);
  assert.equal(resumed?.roundsStarted, 2);
  assert.equal(resumed?.revision, 3);
});

test('resume refuses an armed goal and an exhausted budget', () => {
  assert.throws(
    () => applyGoalMutation(activeGoal(), { operation: 'resume' }),
    (error: GoalTransitionError) => error.code === 'GOAL_INVALID_TRANSITION',
  );
  const exhausted = activeGoal({ phase: 'paused', autoContinue: false, roundsStarted: 5, maxRounds: 5 });
  assert.throws(
    () => applyGoalMutation(exhausted, { operation: 'resume' }),
    (error: GoalTransitionError) => error.code === 'GOAL_ROUNDS_EXHAUSTED',
  );
});

test('block records the reason and clears it on resume', () => {
  const blocked = applyGoalMutation(activeGoal(), {
    operation: 'block',
    blockedReason: { code: 'missing-data', message: 'the reference genome is unavailable' },
  });
  assert.equal(blocked?.phase, 'blocked');
  assert.deepEqual(blocked?.blockedReason, { code: 'missing-data', message: 'the reference genome is unavailable' });

  const resumed = applyGoalMutation(blocked, { operation: 'resume' });
  assert.equal(resumed?.phase, 'active');
  assert.equal(resumed?.blockedReason, undefined);
});

test('block requires a non-empty reason and an active goal', () => {
  assert.throws(
    () => applyGoalMutation(activeGoal(), { operation: 'block' }),
    (error: GoalTransitionError) => error.code === 'GOAL_INVALID_BLOCK_REASON',
  );
  const paused = activeGoal({ phase: 'paused', autoContinue: false });
  assert.throws(
    () => applyGoalMutation(paused, { operation: 'block', blockedReason: { code: 'x', message: 'y' } }),
    (error: GoalTransitionError) => error.code === 'GOAL_INVALID_TRANSITION',
  );
});

test('edit keeps the phase and can change the round cap', () => {
  const edited = applyGoalMutation(activeGoal(), { operation: 'edit', objective: 'narrower', maxRounds: 9 });
  assert.equal(edited?.objective, 'narrower');
  assert.equal(edited?.maxRounds, 9);
  assert.equal(edited?.phase, 'active');
  assert.equal(edited?.autoContinue, true);
});

test('timestamps never move backwards', () => {
  const edited = applyGoalMutation(
    activeGoal({ updatedAt: '2030-01-01T00:00:00.000Z' }),
    { operation: 'edit', objective: 'later' },
    '2020-01-01T00:00:00.000Z',
  );
  assert.equal(edited?.updatedAt, '2030-01-01T00:00:00.000Z');
});

test('canStartGoalRound needs an armed active goal with budget left', () => {
  assert.equal(canStartGoalRound(activeGoal()), true);
  assert.equal(canStartGoalRound(activeGoal({ autoContinue: false })), false);
  assert.equal(canStartGoalRound(activeGoal({ roundsStarted: 5 })), false);
  assert.equal(canStartGoalRound(activeGoal({ phase: 'blocked' })), false);
  assert.equal(canStartGoalRound(null), false);
});

test('the round prompt names the objective and the budget', () => {
  const prompt = renderGoalRoundPrompt(activeGoal({ objective: 'line "one"\nline two' }), 2);
  assert.match(prompt, /<goal_round>/);
  assert.match(prompt, /Round: 2\/5/);
  assert.match(prompt, /"line \\"one\\"\\nline two"/);
});
