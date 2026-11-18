import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from '../common/icons.jsx';
import { teamGridCells, teamStatusLabel } from '../../domain/team_view.js';

/**
 * The team switcher: sits between the conversation title and the subagent bar.
 *
 * `auto` is a mode, not a role — the grid shows it in the same place a role would be, because
 * "let the team decide" and "make Searcher answer" are the same kind of choice to the user.
 */
export function TeamSwitcher({ team, viewRoleId = null, teamActivity = {}, unreadRoleSessionIds = null, onSelectRole, onSelectAuto }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!team) return null;
  const cells = teamGridCells(team, viewRoleId, teamActivity, unreadRoleSessionIds);

  const choose = (cell) => {
    setOpen(false);
    if (cell.kind === 'mode') onSelectAuto?.();
    else onSelectRole?.(cell.id);
  };

  return (
    <div className="team-switcher" ref={rootRef}>
      <button
        type="button"
        className="team-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip="团队：选择由谁来回答"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="team-trigger-label">{teamStatusLabel(team, viewRoleId)}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="team-menu" role="menu" aria-label="团队角色">
          <p className="team-menu-head">选择由谁回答</p>
          <div className="team-grid">
            {cells.map((row) => row.map((cell) => (
              <button
                key={cell.id}
                type="button"
                role="menuitemradio"
                aria-checked={cell.active}
                className={`team-cell${cell.active ? ' active' : ''}${cell.kind === 'mode' ? ' mode' : ''}`}
                onClick={() => choose(cell)}
              >
                <strong className="team-cell-title">
                  {cell.label}
                  {cell.running && <span className="team-cell-activity" role="img" aria-label="正在运行" title="正在运行" />}
                  {cell.finished && <span className="team-cell-finished" role="img" aria-label="已完成，尚未查看" title="已完成，尚未查看" />}
                </strong>
                <small>{cell.kind === 'mode' ? cell.hint : roleCellHint(cell)}</small>
              </button>
            )))}
          </div>
          <p className="team-menu-foot">
            auto 回到团队会话；选具体角色会进入该角色自己的会话。
          </p>
        </div>
      )}
    </div>
  );
}

/** Second line of a role cell: who it is, plus its live state. */
function roleCellHint(cell) {
  const name = cell.hasSession ? cell.name : `${cell.name}（尚未开始）`;
  if (cell.running) return `${name} · 运行中`;
  if (cell.finished) return `${name} · 已完成`;
  return name;
}
