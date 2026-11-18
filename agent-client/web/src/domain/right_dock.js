// 右侧 dock 的纯逻辑：宽度钳制、标签回退、持久化解析、宽内容预览的宽度策略。
// 无 React 依赖，保持可单测（与 domain/ 下其余模块同样的约定）。

import { getWorkspacePreviewKind, isImageExtension } from '../workspace_preview.js';

export const DOCK_MIN_WIDTH = 300;
export const DOCK_MAX_WIDTH = 1000;
export const DOCK_DEFAULT_WIDTH = 440;

/** 折叠态只留一条标签栏 rail。 */
export const DOCK_COLLAPSED_WIDTH = 40;

/** 「全宽预览」的上限：再宽也是在跟对话页抢位置。 */
export const DOCK_WIDE_MAX_WIDTH = 1280;

/** 宽内容在窄栏里打开时自动撑到这个宽度（不改用户持久化的宽度）。 */
export const DOCK_AUTO_WIDEN_WIDTH = 720;

/**
 * 对话页至少要留下的宽度。
 *
 * 布局规则是「dock 保持宽度、对话页让位」，所以窗口变窄时对话页会被一路压窄。
 * 压到这个数以下就没有对话可言了，此时 dock 自动收成 rail（不是被压扁，也不是覆盖）：
 * 面板要么是用户拖出来的宽度，要么是 40px 竖条，中间没有第三态。
 */
export const DOCK_MIN_CONVERSATION_WIDTH = 360;

/** 当前布局宽度下，dock 是否该自动收起。布局宽度未知（首帧）时不收。 */
export function shouldAutoCollapseDock({ layoutWidth, width } = {}) {
  const available = Number(layoutWidth);
  if (!Number.isFinite(available) || available <= 0) return false;
  // 这里不能用 clampDockWidth：最大化后的宽度会超过拖拽上限 DOCK_MAX_WIDTH，
  // 先钳制会把 1280 当成 1000 来算收起，结果最大化一打开就把自己收成 rail。
  return available < normalizeWidth(width) + DOCK_MIN_CONVERSATION_WIDTH;
}

/** 数值宽度；脏输入退回默认宽度（`Number('')` 是 0，会误判成"很窄"）。 */
function normalizeWidth(value) {
  if (value === null || value === undefined || value === '') return DOCK_DEFAULT_WIDTH;
  const width = Number(value);
  return Number.isFinite(width) ? width : DOCK_DEFAULT_WIDTH;
}

/**
 * 这些内容在 300–440px 的窄栏里基本没法读：整页的 PDF、图、以及卡片式的 notebook。
 * 打开它们时自动把面板撑宽一次。
 */
export function isWidePreviewPath(path) {
  const lower = String(path || '').toLowerCase();
  if (!lower) return false;
  if (lower.endsWith('.pdf')) return true;
  if (isImageExtension(lower)) return true;
  return getWorkspacePreviewKind(lower) === 'notebook';
}

/** 最大化后的宽度：给对话页留下保底宽度，其余全给面板。 */
export function dockMaximizedWidth(layoutWidth) {
  const available = Number(layoutWidth);
  if (!Number.isFinite(available) || available <= 0) return DOCK_MAX_WIDTH;
  const room = Math.round(available - DOCK_MIN_CONVERSATION_WIDTH);
  return Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_WIDE_MAX_WIDTH, room));
}

/** 窄栏里打开宽内容时是否该自动撑宽。撑宽之后仍要给对话页留够位置，否则不如不撑。 */
export function shouldAutoWiden({ width, layoutWidth, path } = {}) {
  if (!isWidePreviewPath(path)) return false;
  const available = Number(layoutWidth);
  if (!Number.isFinite(available) || available <= 0) return false;
  if (normalizeWidth(width) >= DOCK_AUTO_WIDEN_WIDTH) return false;
  return available >= DOCK_AUTO_WIDEN_WIDTH + DOCK_MIN_CONVERSATION_WIDTH;
}

/**
 * 面板实际渲染宽度。
 * 优先级：最大化 > 宽内容自动撑宽 > 用户拖出来的宽度。
 * 自动撑宽与最大化都是派生的，不写回 localStorage——用户上次的窄栏偏好要留着。
 */
export function resolveDockWidth({ width, layoutWidth, path, maximized = false } = {}) {
  if (maximized) return dockMaximizedWidth(layoutWidth);
  if (shouldAutoWiden({ width, layoutWidth, path })) return Math.max(clampDockWidth(width), DOCK_AUTO_WIDEN_WIDTH);
  return clampDockWidth(width);
}

/**
 * 标签顺序即展示顺序：第一个永远是「项目文件」（不可关闭），
 * 之后每打开一个文件追加一个 `file:<相对路径>` 标签。
 */
export const DOCK_TABS = ['files'];

/** 文件标签 id 前缀；路径本身可能带冒号，所以只认前缀。 */
export const FILE_TAB_PREFIX = 'file:';

export function fileTabId(path) {
  return `${FILE_TAB_PREFIX}${String(path || '')}`;
}

export function tabFilePath(tabId) {
  const value = String(tabId || '');
  return value.startsWith(FILE_TAB_PREFIX) ? value.slice(FILE_TAB_PREFIX.length) : '';
}

export function clampDockWidth(value) {
  // Number(null) / Number('') 都是 0，会把"没有值"钳到最小值；
  // 这类输入应当退回默认宽度。
  if (value === null || value === undefined || value === '') return DOCK_DEFAULT_WIDTH;
  const width = Number(value);
  if (!Number.isFinite(width)) return DOCK_DEFAULT_WIDTH;
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width)));
}

/** 请求的标签不可用时回退到第一个可用标签。 */
export function resolveDockTab(requested, available = []) {
  if (available.includes(requested)) return requested;
  return available[0] || DOCK_TABS[0];
}

/** 从持久化字符串里还原状态，任何损坏都退回默认值而不是抛错。 */
export function readDockState(raw) {
  let parsed = {};
  try {
    parsed = JSON.parse(raw || '{}') || {};
  } catch {
    parsed = {};
  }
  return {
    width: clampDockWidth(parsed.width),
    collapsed: Boolean(parsed.collapsed),
  };
}

/** 依据当前打开的文件推导出标签集合；「项目文件」恒在第一位。 */
export function availableDockTabs({ openPaths = [] } = {}) {
  return [...DOCK_TABS, ...openPaths.filter(Boolean).map(fileTabId)];
}
