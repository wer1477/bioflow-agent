// 主题偏好：显式三态（light / dark / system）。system 下实时跟随系统深浅色。
// 旧版本只存 light / dark、缺省代表「跟随系统」；三值实现天然兼容：旧值原样读回，
// 缺省或非法值一律按 system 处理。index.html 的首帧脚本按同一规则解析，改这里要同步。

export const THEME_KEY = 'bioflow-theme';
export const THEME_PREFERENCES = ['light', 'dark', 'system'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 把任意存储值收窄成三种偏好之一；缺省/非法 -> system。 */
export function parsePreference(raw) {
  return THEME_PREFERENCES.includes(raw) ? raw : 'system';
}

/** 读取用户偏好；localStorage 不可用时回退 system。 */
export function readPreference() {
  try {
    return parsePreference(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** 把偏好解析成实际生效的主题：system 跟随系统，其余原样。 */
export function resolveTheme(preference, systemDark) {
  const stored = parsePreference(preference);
  if (stored === 'light' || stored === 'dark') return stored;
  return systemDark ? 'dark' : 'light';
}

/** 系统当前是否为深色。 */
export function prefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** 只把生效主题写到 DOM，不持久化——持久化是「显式偏好」的语义，见 rememberPreference。 */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

/** 记住用户的显式偏好。 */
export function rememberPreference(preference) {
  try {
    localStorage.setItem(THEME_KEY, parsePreference(preference));
  } catch {
    // 忽略持久化失败：本次会话仍按内存里的偏好生效。
  }
}

/**
 * 订阅系统深浅色变化，回调给出「系统当前是否为深色」。是否采用由调用方按偏好决定
 * （只有 system 才跟随），因此手动选了 light/dark 的用户不会被系统覆盖。
 * 返回取消订阅函数。
 */
export function watchSystemTheme(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const handler = (event) => onChange(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
