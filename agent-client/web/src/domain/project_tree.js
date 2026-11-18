// 项目/会话树的纯函数：分组、排序、搜索、可见会话数、展开态。
// 无 React 依赖，保持可单测（与 src/domain/* 其余模块一致）。

/** 侧栏默认最多展示几个会话；dsh 用同样的思路避免树无限膨胀。 */
export const DEFAULT_VISIBLE_SESSIONS = 5;

/** 侧栏默认最多展示几个项目；其余收进"显示全部项目"入口，避免几百个项目撑满树。 */
export const DEFAULT_VISIBLE_PROJECTS = 12;

/** `GET /api/projects` 的载荷 → 项目与未分组会话两组；缺字段时退化为空数组。 */
export function splitProjectsAndOrphans(payload) {
  return {
    projects: Array.isArray(payload?.projects) ? payload.projects : [],
    orphans: Array.isArray(payload?.orphans) ? payload.orphans : [],
  };
}

/**
 * 会话按项目分组。优先用后端派生的 `projectKey`；若该字段缺失（例如后端还是旧进程），
 * 退化为用 `projectPath` 在项目表里反查，避免整个树空掉。
 * `pathToKey` 是 `Map<项目绝对路径, projectKey>`。
 */
export function groupSessionsByProject(conversations, pathToKey) {
  const grouped = {};
  for (const conversation of conversations || []) {
    const key = conversation?.projectKey || pathToKey?.get?.(conversation?.projectPath) || null;
    if (!key) continue;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(conversation);
  }
  return grouped;
}

export function sessionsForProject(grouped, projectKey) {
  return grouped?.[projectKey] || [];
}

export function filterSessions(sessions, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return sessions || [];
  return (sessions || []).filter((session) => String(session.title || '').toLowerCase().includes(needle));
}

/**
 * 展开后显示哪些会话：置顶/运行中的优先保留，其余按上限截断。
 * 返回 `{ visible, hidden }`，`hidden > 0` 时侧栏显示"显示更多"。
 */
export function visibleSessions(sessions, { expanded = false, limit = DEFAULT_VISIBLE_SESSIONS, runningIds } = {}) {
  const rows = sessions || [];
  if (expanded || rows.length <= limit) return { visible: rows, hidden: 0 };
  const visible = rows.slice(0, limit);
  const shown = new Set(visible.map((session) => session.id));
  for (const session of rows) {
    if (shown.has(session.id)) continue;
    if (runningIds?.has?.(session.id)) {
      visible.push(session);
      shown.add(session.id);
    }
  }
  return { visible, hidden: rows.length - visible.length };
}

/**
 * 搜索：项目名命中时保留它全部会话；否则只保留标题命中的会话。
 * 返回过滤后的 `projects` 与 `sessionsByProject`。
 */
export function matchProjects(projects, sessionsByProject, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { projects: projects || [], sessionsByProject: sessionsByProject || {} };
  const matchedProjects = [];
  const matchedSessions = {};
  for (const project of projects || []) {
    const sessions = sessionsByProject?.[project.key] || [];
    if (String(project.title || '').toLowerCase().includes(needle)) {
      matchedProjects.push(project);
      matchedSessions[project.key] = sessions;
      continue;
    }
    const hits = filterSessions(sessions, needle);
    if (hits.length) {
      matchedProjects.push(project);
      matchedSessions[project.key] = hits;
    }
  }
  return { projects: matchedProjects, sessionsByProject: matchedSessions };
}

/** 展开集合：`Set` 里切换一个键，返回新集合（供折叠区块使用）。 */
export function toggleExpandedKey(expandedKeys, key) {
  const next = new Set(expandedKeys || []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function isExpandedKey(expandedKeys, key) {
  return Boolean(expandedKeys?.has?.(key));
}

export function sortProjects(projects) {
  return [...(projects || [])].sort((a, b) => {
    const runningDiff = Number(b.runningCount || 0) - Number(a.runningCount || 0);
    if (runningDiff) return runningDiff;
    const activity = String(b.lastActivityAt || b.updatedAt || '').localeCompare(String(a.lastActivityAt || a.updatedAt || ''));
    if (activity) return activity;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

/**
 * 项目列表的可见子集：按传入顺序保留前 `limit` 个，再补回当前项目和有运行中会话
 * 的项目（保持原顺序，不把它们挪到末尾）；其余收进"显示全部项目"入口。
 * `expanded` 为 true（点了"显示全部"或正在搜索）时直接全量返回。
 */
export function visibleProjects(projects, { currentKey = '', expanded = false, limit = DEFAULT_VISIBLE_PROJECTS } = {}) {
  const rows = projects || [];
  if (expanded || rows.length <= limit) return { visible: rows, hidden: 0 };
  const visible = rows.filter((project, index) => (
    index < limit || project?.key === currentKey || Number(project?.runningCount || 0) > 0
  ));
  return { visible, hidden: rows.length - visible.length };
}

export function projectSubtitle(project) {
  const sessions = Number(project?.sessionCount || 0);
  const running = Number(project?.runningCount || 0);
  return running ? `${sessions} · 运行中 ${running}` : `${sessions}`;
}

export function orphanSubtitle(orphan) {
  return orphan?.projectPath ? `原项目目录已不存在：${orphan.projectPath}` : '未绑定项目目录';
}

export function canDeleteProject(project) {
  return Number(project?.runningCount || 0) === 0;
}

export function findProject(projects, key) {
  if (!key) return null;
  return (projects || []).find((project) => project.key === key) || null;
}
