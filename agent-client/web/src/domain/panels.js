/**
 * Conversation panels: the to-do list and the goal, as the Web shell sees them.
 *
 * The server folds the transcript and serves one authoritative value; these helpers only
 * normalize that value for rendering and apply the same *whole-value* rule to live events
 * while a run streams. Nothing here reconstructs history: every panel event carries the
 * complete list or goal, so applying one is a replacement, never a merge.
 */

export const EMPTY_PANELS = Object.freeze({
  asOfSequence: -1,
  goal: null,
  todos: null,
});

export const TODO_STATUSES = Object.freeze(['pending', 'in_progress', 'completed']);

export const TODO_STATUS_LABELS = Object.freeze({
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
});

export const GOAL_PHASE_LABELS = Object.freeze({
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成',
});

/** Coerce one to-do entry into `{id, text, status}`, tolerating the legacy `done` flag. */
export function normalizeTodoItem(item, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const text = String(item.text ?? item.content ?? '').trim();
  if (!text) return null;
  const rawStatus = String(item.status ?? '').trim();
  const status = TODO_STATUSES.includes(rawStatus)
    ? rawStatus
    : item.done === true
      ? 'completed'
      : 'pending';
  const id = String(item.id ?? '').trim() || `todo${index + 1}`;
  return { id, text, status };
}

/** Normalize a full list, dropping entries that carry no text. */
export function normalizeTodoList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => normalizeTodoItem(item, index))
    .filter(Boolean);
}

/** Per-status counts and the fraction completed, for the dock header. */
export function todoProgress(todos) {
  const items = Array.isArray(todos) ? todos : [];
  const total = items.length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const inProgress = items.filter((item) => item.status === 'in_progress').length;
  const pending = total - completed - inProgress;
  return {
    total,
    completed,
    inProgress,
    pending,
    ratio: total === 0 ? 0 : completed / total,
  };
}

/**
 * Header summary: only non-zero segments, joined with a middle dot.
 *
 * A finished list reads "3 已完成" rather than "3 已完成 · 0 进行中 · 0 待处理"; a
 * non-empty list always keeps at least one segment, so the header is never blank.
 */
export function todoProgressLabel(todos) {
  const progress = todoProgress(todos);
  const parts = [];
  if (progress.completed > 0) parts.push(`${progress.completed} 已完成`);
  if (progress.inProgress > 0) parts.push(`${progress.inProgress} 进行中`);
  if (progress.pending > 0) parts.push(`${progress.pending} 待处理`);
  return parts.join(' · ');
}

/** Whether a goal deserves a strip at all. */
export function isGoalVisible(goal) {
  return Boolean(goal) && goal.phase !== 'complete';
}

/**
 * The label for an active goal distinguishes armed from disarmed.
 *
 * Both render as a resume offer, but they mean different things: paused is a durable
 * decision, disarmed is a goal whose automatic rounds stopped without changing its phase.
 */
export function goalLabel(goal) {
  if (!goal) return '';
  if (goal.phase === 'active' && goal.autoContinue === false) return '已暂停（自动续轮关闭）';
  return GOAL_PHASE_LABELS[goal.phase] || goal.phase;
}

/** Round counter text, e.g. `第 2/5 轮`. */
export function goalRoundLabel(goal) {
  if (!goal) return '';
  const started = Number(goal.roundsStarted) || 0;
  const max = Number(goal.maxRounds) || 0;
  return `第 ${started}/${max} 轮`;
}

/**
 * Apply one runtime event to the panel pair.
 *
 * Returns the same object when the event is unrelated, so consumers can rely on
 * reference equality to skip work — the same contract the server-side fold uses.
 */
export function applyPanelEvent(panels, event) {
  if (!event || typeof event !== 'object') return panels;
  const current = panels || EMPTY_PANELS;

  if (event.type === 'planning_panel' && event.panel === 'todo') {
    if (event.status === 'complete') {
      return current.todos === null ? current : { ...current, todos: null };
    }
    const todos = normalizeTodoList(event.todos);
    return { ...current, todos };
  }

  if (event.type === 'goal_change') {
    return { ...current, goal: event.goal || null };
  }

  return panels;
}

/** Fold a stream of runtime events into the current panels (last write wins). */
export function applyPanelEvents(panels, events) {
  if (!Array.isArray(events) || events.length === 0) return panels;
  let next = panels;
  for (const event of events) next = applyPanelEvent(next, event);
  return next;
}

/** A goal mutation the strip should refuse locally instead of sending. */
export function goalActionBlockedReason(goal, running) {
  if (running) return '运行中不能修改目标，请先停止当前运行';
  if (!goal) return '当前没有目标';
  return '';
}
