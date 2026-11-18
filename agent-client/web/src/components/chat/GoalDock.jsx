import { useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, EditIcon, GoalIcon, PauseIcon, PlayIcon, TrashIcon } from '../common/icons.jsx';
import { goalLabel, goalRoundLabel, isGoalVisible } from '../../domain/panels.js';

/**
 * The current goal, docked above the composer next to the to-do list.
 *
 * The strip is deliberately thin: it opens collapsed to a single line (phase, objective,
 * round counter, actions) and only expands when asked. A goal's objective is a paragraph,
 * so expanding is how the whole thing becomes readable — never by widening the strip or
 * by pushing the message list around.
 *
 * The durable document from the server decides what it shows; the only local state is the
 * collapse flag, the transient edit draft and the inline error. It cannot change a goal
 * while a run is active — the running recorder owns the transcript sequence, so the server
 * rejects that write and the UI says so up front.
 */
export function GoalDock({ goal, running, onMutate }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [error, setError] = useState('');

  const goalId = goal?.id || '';
  useEffect(() => {
    setExpanded(false);
    setEditing(false);
    setConfirmingClear(false);
    setError('');
  }, [goalId]);

  if (!isGoalVisible(goal)) return null;

  const busy = Boolean(pendingAction) || running;
  const canPause = goal.phase === 'active' && goal.autoContinue === true;
  const canResume = goal.phase === 'paused' || (goal.phase === 'active' && goal.autoContinue === false);

  const runAction = async (action, payload = {}) => {
    if (busy) return;
    setError('');
    setPendingAction(action);
    try {
      await onMutate(action, payload);
      setEditing(false);
      setConfirmingClear(false);
    } catch (err) {
      setError(err?.message || '目标更新失败');
    } finally {
      setPendingAction('');
    }
  };

  if (editing) {
    return (
      <section className="goal-dock goal-dock-editing" data-goal-dock data-expanded="" aria-label="编辑目标">
        <textarea
          className="goal-dock-editor"
          rows={3}
          value={draft}
          aria-label="目标内容"
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              const objective = draft.trim();
              if (objective) runAction('edit', { objective });
            }
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        <div className="goal-dock-actions">
          <button
            type="button"
            className="goal-dock-button primary"
            disabled={busy || draft.trim() === ''}
            onClick={() => runAction('edit', { objective: draft.trim() })}
          >
            保存
          </button>
          <button type="button" className="goal-dock-button" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
        {error && <span className="goal-dock-error" role="alert">{error}</span>}
      </section>
    );
  }

  const openEditor = () => {
    setDraft(goal.objective || '');
    setEditing(true);
  };

  return (
    <section
      className="goal-dock"
      data-goal-dock
      data-phase={goal.phase}
      data-expanded={expanded ? '' : undefined}
      aria-label="会话目标"
    >
      <button
        type="button"
        className="goal-dock-summary"
        aria-expanded={expanded}
        data-tooltip={expanded ? '收起目标' : '展开目标'}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="goal-dock-lead" aria-hidden="true"><GoalIcon /></span>
        <span className="goal-dock-phase" data-phase={goal.phase}>{goalLabel(goal)}</span>
        <span className="goal-dock-objective" title={goal.objective}>{goal.objective}</span>
        <span className="goal-dock-rounds">{goalRoundLabel(goal)}</span>
        {goal.phase === 'blocked' && goal.blockedReason && (
          <span className="goal-dock-blocked" title={goal.blockedReason.message}>
            {goal.blockedReason.code}
          </span>
        )}
        <span className="goal-dock-chevron" aria-hidden="true">
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      </button>
      <div className="goal-dock-actions">
        {canPause && (
          <button
            type="button"
            className="goal-dock-button"
            title={running ? '运行中不能暂停目标' : '暂停目标'}
            disabled={busy}
            onClick={() => runAction('pause')}
          >
            <PauseIcon />
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="goal-dock-button"
            title={running ? '运行中不能恢复目标' : '恢复目标'}
            disabled={busy}
            onClick={() => runAction('resume')}
          >
            <PlayIcon />
          </button>
        )}
        <button
          type="button"
          className="goal-dock-button"
          title="编辑目标"
          disabled={busy}
          onClick={openEditor}
        >
          <EditIcon />
        </button>
        {confirmingClear ? (
          <>
            <button
              type="button"
              className="goal-dock-button danger"
              disabled={busy}
              onClick={() => runAction('clear')}
            >
              确认清除
            </button>
            <button type="button" className="goal-dock-button" onClick={() => setConfirmingClear(false)}>
              <CloseIcon />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="goal-dock-button"
            title="清除目标"
            disabled={busy}
            onClick={() => setConfirmingClear(true)}
          >
            <TrashIcon />
          </button>
        )}
      </div>
      {expanded && (
        <div className="goal-dock-detail">
          <p className="goal-dock-objective-full">{goal.objective}</p>
          <dl className="goal-dock-meta">
            <div><dt>阶段</dt><dd>{goalLabel(goal)}</dd></div>
            <div><dt>轮次</dt><dd>{goalRoundLabel(goal)}</dd></div>
            <div><dt>自动续轮</dt><dd>{goal.autoContinue ? '已开启' : '已关闭'}</dd></div>
            <div><dt>更新于</dt><dd>{formatMoment(goal.updatedAt)}</dd></div>
          </dl>
          {goal.phase === 'blocked' && goal.blockedReason && (
            <p className="goal-dock-blocked-detail">
              <code>{goal.blockedReason.code}</code>
              {goal.blockedReason.message}
            </p>
          )}
        </div>
      )}
      {error && <span className="goal-dock-error" role="alert">{error}</span>}
    </section>
  );
}

/** `HH:MM` in the reader's locale; an unparseable stamp degrades to the raw value. */
function formatMoment(value) {
  const stamp = new Date(value || '');
  if (Number.isNaN(stamp.getTime())) return value || '';
  return stamp.toLocaleString();
}
