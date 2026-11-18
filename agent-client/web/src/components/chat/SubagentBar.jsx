import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../common/icons.jsx';
import { StateDot } from '../common/StateDot.jsx';
import {
  subagentRowLabel,
  subagentRowMeta,
  subagentStatusMeta,
  subagentTriggerLabel,
} from '../../domain/subagent_view.js';

/**
 * 父会话标题右侧的委派入口。
 *
 * 子会话不在项目的会话列表里，因此这里是它唯一的入口：触发器显示"有几个、几个在跑"，
 * 展开后是直接子级的清单，点一行就打开那个子会话（主面板，只读）。
 * 交互对齐 DSH 的 header 后代计数：悬停/点击展开、点外面或 Esc 收起。
 */
export function SubagentBar({ rows, total, running, onOpen }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!total) return null;

  return (
    <div className="subagent-bar" ref={rootRef}>
      <button
        type="button"
        className={`subagent-trigger${running ? ' is-running' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip="本会话委派的子 Agent（只读，不在项目会话列表里）"
        onClick={() => setOpen((value) => !value)}
      >
        {running > 0 && <StateDot state="running" label={`${running} 个子 Agent 运行中`} />}
        <span className="subagent-trigger-label">{subagentTriggerLabel({ total, running })}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="subagent-menu" role="menu" aria-label="本会话委派的子 Agent">
          <p className="subagent-menu-head">这些会话由本会话委派，只读</p>
          <ul>
            {rows.map((row) => {
              const status = subagentStatusMeta(row.status);
              const meta = subagentRowMeta(row);
              return (
                <li key={row.conversationId}>
                  <button
                    type="button"
                    role="menuitem"
                    className="subagent-row"
                    onClick={() => {
                      setOpen(false);
                      onOpen(row.conversationId);
                    }}
                  >
                    <StateDot state={status.state} label={status.label} />
                    <span className="subagent-row-body">
                      <strong>{subagentRowLabel(row)}</strong>
                      <small>{meta ? `${status.label} · ${meta}` : status.label}</small>
                    </span>
                    <ChevronRightIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
