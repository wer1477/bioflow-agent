// 单文件编辑会话的纯逻辑：草稿、自动保存判定、保存/冲突的状态转移。
// 无 React 依赖：hook 只负责调度与请求，状态怎么变全部在这里决定，便于单测。

/** 停笔多久之后自动保存。 */
export const AUTOSAVE_DELAY_MS = 800;

/**
 * 会话 = 后端文件元信息 + 编辑态。
 * `savedContent` 是"磁盘上那份"的本地副本，dirty 只能由它推出，避免多处各自维护脏标记。
 */
export function createFileSession(file) {
  const content = String(file?.content ?? '');
  return {
    path: file?.path || '',
    content,
    savedContent: content,
    encoding: file?.encoding || 'utf8',
    mimeType: file?.mimeType || '',
    version: file?.version || '',
    size: Number(file?.size) || 0,
    mtimeMs: Number(file?.mtimeMs) || 0,
    truncated: Boolean(file?.truncated),
    binary: Boolean(file?.binary),
    canEdit: Boolean(file?.canEdit),
    dirty: false,
    conflict: null,
  };
}

export function applyDraft(session, content) {
  if (!session) return session;
  const next = String(content ?? '');
  if (next === session.content) return session;
  return { ...session, content: next, dirty: next !== session.savedContent };
}

export function applySave(session, saved) {
  if (!session) return session;
  return {
    ...session,
    savedContent: session.content,
    version: saved?.version || session.version,
    size: Number(saved?.size) || session.size,
    mtimeMs: Number(saved?.mtimeMs) || session.mtimeMs,
    dirty: false,
    conflict: null,
  };
}

/** 磁盘版本推送到本地：只在没有本地改动时替换内容，绝不覆盖未保存的草稿。 */
export function applyRemote(session, remote) {
  if (!session || session.dirty) return session;
  const content = String(remote?.content ?? session.content);
  return {
    ...session,
    content,
    savedContent: content,
    encoding: remote?.encoding || session.encoding,
    mimeType: remote?.mimeType || session.mimeType,
    version: remote?.version || session.version,
    size: Number(remote?.size) || session.size,
    mtimeMs: Number(remote?.mtimeMs) || session.mtimeMs,
    truncated: Boolean(remote?.truncated),
    binary: Boolean(remote?.binary),
    conflict: null,
  };
}

export function applyConflict(session, conflict) {
  if (!session) return session;
  return { ...session, conflict: conflict || null };
}

/** 自动保存只在"能编辑、开关打开、没有冲突、不在保存中、确实脏了"时触发。 */
export function shouldAutoSave(session, { autoSave = true, saving = false } = {}) {
  if (!session || !session.canEdit) return false;
  if (!autoSave || saving || session.conflict) return false;
  return Boolean(session.dirty);
}

export function canEditSession(session) {
  return Boolean(session?.canEdit && !session?.truncated);
}

/** 工具条上的状态文案；tone 决定颜色语义。 */
export function describeFileStatus(session, { saving = false } = {}) {
  if (!session) return { label: '', tone: 'idle' };
  if (session.conflict) return { label: '磁盘已更新', tone: 'conflict' };
  if (saving) return { label: '保存中…', tone: 'busy' };
  if (session.dirty) return { label: '未保存', tone: 'dirty' };
  return { label: '已保存', tone: 'saved' };
}

/**
 * 切走文件时把草稿留在一个 Map 里（key=路径），切回来能接着改。
 * Map 是不可变的：每次返回新实例，React 才能看出变化。
 */
export function stashDraft(drafts, session) {
  if (!session?.path || !session.dirty) return drafts;
  const next = new Map(drafts);
  next.set(session.path, { content: session.content, version: session.version });
  return next;
}

export function dropDraft(drafts, path) {
  if (!drafts?.has(path)) return drafts;
  const next = new Map(drafts);
  next.delete(path);
  return next;
}

export function draftFor(drafts, path) {
  return drafts?.get(path) || null;
}

/** 自动保存开关的持久化值：只有显式的 'off' 才关，损坏值退回"开"。 */
export function parseAutoSavePreference(raw) {
  return String(raw || '') !== 'off';
}

export function autoSavePreferenceValue(enabled) {
  return enabled ? 'on' : 'off';
}

/**
 * 多标签下的会话集合操作。Map 都是不可变的：每次返回新实例，React 才看得出变化。
 * 标签顺序由 openPaths 决定，「项目文件」不在其中（它不可关闭）。
 */
export function addOpenPath(openPaths, path) {
  if (!path || openPaths.includes(path)) return openPaths;
  return [...openPaths, path];
}

export function removeOpenPath(openPaths, path) {
  return openPaths.filter((item) => item !== path);
}

/**
 * 关掉一批标签后激活谁：从被关掉的那一组往左找最近的幸存者，再往右找，
 * 都没有就回「项目文件」（空串）。一次关掉整个目录下的多个文件也走同一条规则。
 */
export function activePathAfterClose(openPaths, closedPaths) {
  const closed = new Set(closedPaths);
  const firstClosed = openPaths.findIndex((path) => closed.has(path));
  if (firstClosed < 0) return openPaths[openPaths.length - 1] || '';
  for (let index = firstClosed - 1; index >= 0; index -= 1) {
    if (!closed.has(openPaths[index])) return openPaths[index];
  }
  for (let index = firstClosed + 1; index < openPaths.length; index += 1) {
    if (!closed.has(openPaths[index])) return openPaths[index];
  }
  return '';
}

export function nextActivePath(openPaths, closedPath) {
  return activePathAfterClose(openPaths, [closedPath]);
}

export function upsertSession(sessions, session) {
  if (!session?.path) return sessions;
  const next = new Map(sessions);
  next.set(session.path, session);
  return next;
}

export function removeSession(sessions, path) {
  if (!sessions?.has(path)) return sessions;
  const next = new Map(sessions);
  next.delete(path);
  return next;
}

/** 重命名/移动后把会话搬到新路径，草稿与版本基线都跟着走。 */
export function renameSession(sessions, from, to) {
  const session = sessions?.get(from);
  if (!session) return sessions;
  const next = new Map(sessions);
  next.delete(from);
  next.set(to, { ...session, path: to });
  return next;
}

/** 需要自动保存的会话：能编辑、确实脏了、没在保存中、没有冲突。 */
export function autoSaveTargets(sessions, { autoSave = true, savingPaths } = {}) {
  const targets = [];
  for (const session of sessions?.values() || []) {
    const saving = Boolean(savingPaths?.has(session.path));
    if (shouldAutoSave(session, { autoSave, saving })) targets.push(session);
  }
  return targets;
}
