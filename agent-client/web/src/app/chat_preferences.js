// 对话展示偏好：整轮过程什么时候收起。两档语义见 domain/turn_process.js 的
// resolveTurnProcessOpen：completion 一结束就收，nextInput 让最新一个成功轮次
// 保持展开，直到下一条消息把「最新」这个身份让出去。
//
// 和主题偏好一样，这是浏览器级视觉偏好：存 localStorage，不进后端 config/。

import { COLLAPSE_TIMINGS, DEFAULT_COLLAPSE_TIMING } from '../domain/turn_process.js';

export const COLLAPSE_KEY = 'bioflow-chat-collapse-timing';

/** 默认「回答结束后」：任务一完成就收起，只留结果。 */
export { DEFAULT_COLLAPSE_TIMING };

/** 把任意存储值收窄成两档之一；缺省/非法 -> 默认档。 */
export function parseCollapseTiming(raw) {
  return COLLAPSE_TIMINGS.includes(raw) ? raw : DEFAULT_COLLAPSE_TIMING;
}

/** 读取用户偏好；localStorage 不可用（隐私模式）时回退默认值。 */
export function readCollapseTiming() {
  try {
    return parseCollapseTiming(localStorage.getItem(COLLAPSE_KEY));
  } catch {
    return DEFAULT_COLLAPSE_TIMING;
  }
}

/** 记住用户的显式选择。 */
export function rememberCollapseTiming(timing) {
  try {
    localStorage.setItem(COLLAPSE_KEY, parseCollapseTiming(timing));
  } catch {
    // 忽略持久化失败：本次会话仍按内存里的取值生效。
  }
}
