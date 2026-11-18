import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPanelEvent,
  applyPanelEvents,
  EMPTY_PANELS,
  goalActionBlockedReason,
  goalLabel,
  goalRoundLabel,
  isGoalVisible,
  normalizeTodoItem,
  normalizeTodoList,
  todoProgress,
  todoProgressLabel,
} from '../src/domain/panels.js';

function goal(overrides = {}) {
  return {
    id: 'goal-1',
    revision: 1,
    objective: 'Finish the analysis',
    phase: 'active',
    maxRounds: 5,
    autoContinue: true,
    roundsStarted: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('normalizeTodoItem reads the three-state status and the legacy done flag', () => {
  assert.equal(normalizeTodoItem({ text: 'a', status: 'in_progress' }).status, 'in_progress');
  assert.equal(normalizeTodoItem({ text: 'b', done: true }).status, 'completed');
  assert.equal(normalizeTodoItem({ text: 'c' }).status, 'pending');
  assert.equal(normalizeTodoItem({ text: '   ' }), null);
});

test('normalizeTodoList fills ids and drops textless rows', () => {
  const list = normalizeTodoList([{ text: 'one' }, { text: '' }, { id: 'x', text: 'two', status: 'completed' }]);
  assert.deepEqual(list.map((item) => item.id), ['todo1', 'x']);
  assert.deepEqual(list.map((item) => item.status), ['pending', 'completed']);
  assert.deepEqual(normalizeTodoList(null), []);
});

test('todoProgress counts each status and the completion ratio', () => {
  const progress = todoProgress([
    { id: '1', text: 'a', status: 'completed' },
    { id: '2', text: 'b', status: 'completed' },
    { id: '3', text: 'c', status: 'in_progress' },
    { id: '4', text: 'd', status: 'pending' },
  ]);
  assert.deepEqual(
    { total: progress.total, completed: progress.completed, inProgress: progress.inProgress, pending: progress.pending },
    { total: 4, completed: 2, inProgress: 1, pending: 1 },
  );
  assert.equal(progress.ratio, 0.5);
  assert.equal(todoProgress([]).ratio, 0);
});

test('todoProgressLabel omits zero segments and never returns an empty string for a list', () => {
  assert.equal(todoProgressLabel([
    { id: '1', text: 'a', status: 'completed' },
    { id: '2', text: 'b', status: 'completed' },
  ]), '2 已完成');
  assert.equal(todoProgressLabel([
    { id: '1', text: 'a', status: 'in_progress' },
    { id: '2', text: 'b', status: 'pending' },
  ]), '1 进行中 · 1 待处理');
});

test('a todo panel event replaces the whole list', () => {
  const first = applyPanelEvent(EMPTY_PANELS, {
    type: 'planning_panel',
    panel: 'todo',
    status: 'active',
    todos: [{ text: 'one', status: 'pending' }],
  });
  assert.equal(first.todos.length, 1);

  const second = applyPanelEvent(first, {
    type: 'planning_panel',
    panel: 'todo',
    status: 'active',
    todos: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }],
  });
  assert.deepEqual(second.todos.map((todo) => todo.text), ['one', 'two']);
  assert.equal(second.todos[0].status, 'completed');
});

test('a complete todo panel clears the list', () => {
  const withTodos = applyPanelEvent(EMPTY_PANELS, {
    type: 'planning_panel',
    panel: 'todo',
    status: 'active',
    todos: [{ text: 'one', status: 'pending' }],
  });
  const cleared = applyPanelEvent(withTodos, { type: 'planning_panel', panel: 'todo', status: 'complete' });
  assert.equal(cleared.todos, null);
});

test('unrelated events keep the same object so renders can skip', () => {
  const panels = { ...EMPTY_PANELS, todos: [] };
  assert.equal(applyPanelEvent(panels, { type: 'content', content: 'hi' }), panels);
  assert.equal(applyPanelEvent(panels, { type: 'planning_panel', panel: 'clarify', status: 'waiting' }), panels);
});

test('applyPanelEvents folds a stream in order', () => {
  const panels = applyPanelEvents(EMPTY_PANELS, [
    { type: 'planning_panel', panel: 'todo', status: 'active', todos: [{ text: 'one', status: 'pending' }] },
    { type: 'goal_change', operation: 'create', goal: goal() },
    { type: 'planning_panel', panel: 'todo', status: 'active', todos: [{ text: 'one', status: 'completed' }] },
  ]);
  assert.equal(panels.todos[0].status, 'completed');
  assert.equal(panels.goal.id, 'goal-1');
});

test('a goal clear event empties the strip', () => {
  const withGoal = applyPanelEvent(EMPTY_PANELS, { type: 'goal_change', operation: 'create', goal: goal() });
  const cleared = applyPanelEvent(withGoal, { type: 'goal_change', operation: 'clear', goal: null });
  assert.equal(cleared.goal, null);
});

test('the strip only hides completed and missing goals', () => {
  assert.equal(isGoalVisible(null), false);
  assert.equal(isGoalVisible(goal({ phase: 'complete' })), false);
  assert.equal(isGoalVisible(goal({ phase: 'blocked' })), true);
  assert.equal(isGoalVisible(goal({ phase: 'paused' })), true);
});

test('labels distinguish a disarmed active goal from a paused one', () => {
  assert.equal(goalLabel(goal()), '进行中');
  assert.equal(goalLabel(goal({ autoContinue: false })), '已暂停（自动续轮关闭）');
  assert.equal(goalLabel(goal({ phase: 'paused', autoContinue: false })), '已暂停');
  assert.equal(goalLabel(goal({ phase: 'blocked' })), '受阻');
});

test('the round label shows accepted rounds against the budget', () => {
  assert.equal(goalRoundLabel(goal({ roundsStarted: 2, maxRounds: 5 })), '第 2/5 轮');
  assert.equal(goalRoundLabel(goal({ roundsStarted: 0 })), '第 0/5 轮');
});

test('the strip refuses mutations while a run is active', () => {
  assert.match(goalActionBlockedReason(goal(), true), /运行中/);
  assert.equal(goalActionBlockedReason(goal(), false), '');
  assert.match(goalActionBlockedReason(null, false), /没有目标/);
});
