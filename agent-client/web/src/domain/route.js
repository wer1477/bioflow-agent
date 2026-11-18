// 路由的纯逻辑：解析、构造、恢复入口。无 React / 无副作用（localStorage 只在函数内访问），
// 因此可被 node --test 直接单测；React 侧的 hook 在 src/app/router.js。

const LAST_LOCATION_KEY = 'bioflow.lastLocation';

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '').replace(/^\/+/, '');
  const parts = raw.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (!parts.length) return { name: 'root' };
  if (parts[0] === 'settings') {
    // `#/settings/general` 是通用设置；`#/settings/agent` 与任何未知子路径都归一到
    // Agent 设置。裸 `#/settings` 不带 section，由 App 用 location.replace 补全。
    if (parts[1] === 'general') return { name: 'settings', section: 'general' };
    if (parts[1]) return { name: 'settings', section: 'agent' };
    return { name: 'settings' };
  }
  if (parts[0] === 'login') return { name: 'login' };
  if (parts[0] === 'register') return { name: 'register' };
  if (parts[0] === 'forgot') return { name: 'forgot' };
  if (parts[0] !== 'projects') return { name: 'projects' };
  if (parts.length === 1) return { name: 'projects' };
  const projectKey = parts[1];
  if (parts.length >= 4 && parts[2] === 'sessions') return { name: 'session', projectKey, sessionId: parts[3] };
  return { name: 'project', projectKey };
}

export function buildHash(route) {
  switch (route?.name) {
    case 'settings':
      return route.section === 'general' ? '#/settings/general' : '#/settings/agent';
    case 'login':
      return '#/login';
    case 'register':
      return '#/register';
    case 'forgot':
      return '#/forgot';
    case 'project':
      return `#/projects/${encodeURIComponent(route.projectKey)}`;
    case 'session':
      return `#/projects/${encodeURIComponent(route.projectKey)}/sessions/${encodeURIComponent(route.sessionId)}`;
    default:
      return '#/projects';
  }
}

export function readLastLocation() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAST_LOCATION_KEY) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function rememberLocation(route) {
  try {
    if (route?.name !== 'project' && route?.name !== 'session') return;
    window.localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ projectKey: route.projectKey, sessionId: route.sessionId || null }));
  } catch {
    // 私密模式下 localStorage 可能不可用：忽略即可，只损失"恢复上次位置"。
  }
}

/** `#/` 进入时恢复到上次的项目/会话，否则回到项目列表。 */
export function resolveEntryHash() {
  const last = readLastLocation();
  if (last?.projectKey && last?.sessionId) return buildHash({ name: 'session', projectKey: last.projectKey, sessionId: last.sessionId });
  if (last?.projectKey) return buildHash({ name: 'project', projectKey: last.projectKey });
  return '#/projects';
}
