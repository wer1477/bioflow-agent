import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  availableDockTabs, clampDockWidth, readDockState, resolveDockWidth, resolveDockTab,
  shouldAutoCollapseDock, tabFilePath,
} from '../domain/right_dock.js';

const STORAGE_KEY = 'bioflow-right-dock';

/**
 * 右侧 dock 的状态：当前标签、折叠、宽度。
 * 用户拖出来的宽度与折叠持久化到 localStorage；标签、最大化、宽内容自动撑宽都不持久化
 * （打开的文件本来就不跨刷新保留，临时宽度也不该污染用户偏好）。
 *
 * 折叠有两种来源：用户手动收起（持久化），以及窗口太窄时的自动收起（派生，不持久化）。
 * 自动收起期间不提供展开入口：dock 要么是用户拖出来的宽度，要么是 40px 竖条，
 * 不会出现"展开就把对话页压到不可用"的第三态。
 *
 * 渲染宽度由 `resolveDockWidth` 统一算：最大化 > 宽内容自动撑宽 > 用户宽度。
 * 宽内容按当前标签的文件路径判定，所以调用方不需要额外传视图类型。
 */
export function useRightDock({ openPaths = [] } = {}) {
  const stored = useRef(null);
  if (stored.current === null) {
    let raw = '';
    try {
      raw = localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      raw = '';
    }
    stored.current = readDockState(raw);
  }

  const layoutRef = useRef(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [preferredWidth, setPreferredWidth] = useState(stored.current.width);
  const [collapsed, setCollapsed] = useState(stored.current.collapsed);
  const [tab, setTab] = useState('files');
  const [maximized, setMaximized] = useState(false);

  const available = useMemo(() => availableDockTabs({ openPaths }), [openPaths]);
  const activeTab = resolveDockTab(tab, available);
  const activePath = tabFilePath(activeTab);

  // 面板消失时把标签收回可用集合。
  useEffect(() => {
    setTab((current) => resolveDockTab(current, available));
  }, [available.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // 观察会话区总宽度：dock 宽度自己决定，只有容器会变。
  useEffect(() => {
    const element = layoutRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect?.width || 0;
      setLayoutWidth((current) => (Math.abs(current - next) < 1 ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 切标签就退出最大化：最大化是"看这一个东西"的临时态，不是新的默认宽度。
  useEffect(() => {
    setMaximized(false);
  }, [activeTab]);

  const width = resolveDockWidth({
    width: preferredWidth,
    layoutWidth,
    path: activePath,
    maximized,
  });

  const autoCollapse = shouldAutoCollapseDock({ layoutWidth, width });
  const collapsedNow = collapsed || autoCollapse;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: preferredWidth, collapsed }));
    } catch {
      // 忽略持久化失败
    }
  }, [preferredWidth, collapsed]);

  /** 从右侧边缘拖拽改宽度；一旦开始拖就退出最大化，否则拖不动。 */
  const beginResize = useCallback((event) => {
    event.preventDefault();
    setMaximized(false);
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent) => setPreferredWidth(clampDockWidth(startWidth - (moveEvent.clientX - startX)));
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.body.classList.remove('is-resizing-dock');
    };
    document.body.classList.add('is-resizing-dock');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
  }, [width]);

  const toggleCollapsed = useCallback(() => {
    if (autoCollapse) return;
    setMaximized(false);
    setCollapsed((value) => !value);
  }, [autoCollapse]);

  const toggleMaximized = useCallback(() => {
    if (autoCollapse) return;
    setCollapsed(false);
    setMaximized((value) => !value);
  }, [autoCollapse]);

  return {
    tab: activeTab,
    setTab,
    available,
    collapsed: collapsedNow,
    // 窗口太窄时收起是布局算出来的，不是用户的决定：此时不给展开入口，
    // 否则展开只会把对话页压到不可用。
    canExpand: !autoCollapse,
    toggleCollapsed,
    maximized,
    toggleMaximized,
    width,
    beginResize,
    layoutRef,
  };
}
