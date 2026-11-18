import { useState } from 'react';
import { ChecklistIcon, ChevronDownIcon, ChevronRightIcon } from '../common/icons.jsx';
import { todoProgress, todoProgressLabel, TODO_STATUS_LABELS } from '../../domain/panels.js';

/**
 * The current to-do list, docked above the composer.
 *
 * The list is a whole value from the server: this component never derives it from the
 * event history, so a reload and a live run always describe the same plan. Collapsing is
 * local UI state — it is never part of the durable panel.
 */
export function TodoDock({ todos }) {
  const [collapsed, setCollapsed] = useState(false);
  const items = Array.isArray(todos) ? todos : [];
  if (!items.length) return null;
  const progress = todoProgress(items);
  const percent = Math.round(progress.ratio * 100);

  return (
    <section className="todo-dock" data-testid="todo-dock" aria-label="任务清单">
      <button
        type="button"
        className="todo-dock-header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span className="todo-dock-lead" aria-hidden="true"><ChecklistIcon /></span>
        <span className="todo-dock-title">任务</span>
        <span className="todo-dock-progress">{todoProgressLabel(items)}</span>
        <span
          className="todo-dock-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
          aria-label={`已完成 ${progress.completed}/${progress.total}`}
        >
          <span className="todo-dock-meter-fill" style={{ width: `${percent}%` }} />
        </span>
        <span className="todo-dock-chevron" aria-hidden="true">
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </span>
      </button>
      {!collapsed && (
        <ul className="todo-dock-list">
          {items.map((item) => (
            <li key={item.id} className="todo-dock-item" data-status={item.status}>
              <span className="todo-dock-glyph" data-status={item.status} aria-hidden="true" />
              <span className="todo-dock-text">{item.text}</span>
              <span className="todo-dock-state">{TODO_STATUS_LABELS[item.status] || item.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
