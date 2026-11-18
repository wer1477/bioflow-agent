import { memo } from 'react';
import {
  ChevronLeftIcon, ChevronRightIcon, CloseIcon, CodeIcon, ExpandIcon, FileIcon, GenericIcon, RestoreIcon,
} from '../common/icons.jsx';

const TAB_ICONS = { files: CodeIcon };

/**
 * 右侧可停靠面板：标签栏里第一个永远是「项目文件」（不可关闭），
 * 之后每打开一个文件追加一个可关闭的标签；宽度可拖拽、可折叠成 rail。
 *
 * 只负责容器与标签切换；各面板的数据契约不变，仍由 ChatView 传入。
 *
 * `canExpand === false` 表示收起是窗口宽度算出来的：此时 rail 上的展开按钮禁用并说明原因，
 * 而不是让用户展开后把对话页挤到不可用。
 *
 * 「全宽预览」是 dock 自己的态：PDF / 图 / notebook 在 300–440px 里读不了，
 * 一键把面板撑到可用宽度上限，再点回到自己的宽度。
 */
export const RightDock = memo(function RightDock({
  tab, onTabChange, tabs, collapsed, onToggleCollapsed, canExpand = true, width, onResizeStart, onCloseTab,
  maximized = false, onToggleMaximized, children,
}) {
  if (collapsed) {
    const expandHint = canExpand ? '展开右侧面板' : '窗口太窄，展开会把对话页挤到不可用';
    return (
      <aside className="right-dock collapsed" aria-label="右侧面板">
        <button
          className="right-dock-rail"
          type="button"
          data-tooltip={expandHint}
          aria-label={expandHint}
          disabled={!canExpand}
          onClick={onToggleCollapsed}
        >
          <ChevronLeftIcon />
        </button>
        <div className="right-dock-rail-tabs">
          {tabs.map((item) => {
            const TabIcon = TAB_ICONS[item.id] || GenericIcon;
            return (
              <button
                key={item.id}
                className={`right-dock-rail-tab${item.id === tab ? ' active' : ''}`}
                type="button"
                data-tooltip={item.label}
                aria-label={item.label}
                disabled={!canExpand}
                onClick={() => { onTabChange(item.id); onToggleCollapsed(); }}
              >
                <TabIcon />
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="right-dock" style={{ '--dock-width': `${width}px` }} aria-label="右侧面板">
      <div
        className="right-dock-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右侧面板宽度"
        onPointerDown={onResizeStart}
      />
      <div className="right-dock-tabbar">
        <div className="right-dock-tabs" role="tablist">
        {tabs.map((item) => (
          <span
            key={item.id}
            className={`right-dock-tab${item.id === tab ? ' active' : ''}${item.dirty ? ' is-dirty' : ''}`}
          >
            <button
              className="right-dock-tab-label"
              type="button"
              role="tab"
              aria-selected={item.id === tab}
              data-tooltip={item.title || item.label}
              onClick={() => onTabChange(item.id)}
            >
              <span className="right-dock-tab-text">{item.label}</span>
              {item.dirty && <i className="right-dock-dirty" aria-label="有未保存的修改" />}
            </button>
            {item.closable && (
              <button
                className="right-dock-tab-close"
                type="button"
                aria-label={`关闭 ${item.label}`}
                data-tooltip="关闭"
                onClick={() => onCloseTab?.(item.id)}
              >
                <CloseIcon />
              </button>
            )}
          </span>
        ))}
        </div>
        <button
          className={`right-dock-collapse${maximized ? ' is-active' : ''}`}
          type="button"
          data-tooltip={maximized ? '还原面板宽度' : '全宽预览'}
          aria-label={maximized ? '还原面板宽度' : '全宽预览'}
          aria-pressed={maximized}
          disabled={!canExpand}
          onClick={onToggleMaximized}
        >
          {maximized ? <RestoreIcon /> : <ExpandIcon />}
        </button>
        <button
          className="right-dock-collapse"
          type="button"
          data-tooltip="收起右侧面板"
          aria-label="收起右侧面板"
          onClick={onToggleCollapsed}
        >
          <ChevronRightIcon />
        </button>
      </div>
      <div className="right-dock-body" role="tabpanel">{children}</div>
    </aside>
  );
});
