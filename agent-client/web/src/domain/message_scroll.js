// 消息列表滚动的纯逻辑：到列表底部的距离、以及"是否在跟随尾部"。
// 无 React 依赖，保持可单测（与 domain/ 下其余模块同样的约定）。

/** 距底部小于该值就认为用户在跟随尾部。 */
export const STICK_BOTTOM_THRESHOLD = 80;

/** 列表还没挂载（null）时视为不贴底，避免把"没挂载"当成"在底部"。 */
export function distanceFromBottom(element) {
  if (!element) return Number.POSITIVE_INFINITY;
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export function isNearBottom(element, threshold = STICK_BOTTOM_THRESHOLD) {
  return distanceFromBottom(element) < threshold;
}

/**
 * 一个可滚动盒子是否已经到顶/到底。
 *
 * 用来决定边缘渐隐遮罩：到顶还淡出上边、到底还淡出下边，都会让用户以为内容被裁掉了。
 * 留一像素容差吸收 sub-pixel 布局的取整误差（高度不是整数时 `scrollTop` 会差一点够不到底）。
 */
export function scrollEdges(element) {
  if (!element) return { atTop: true, atBottom: true };
  return {
    atTop: element.scrollTop <= 0,
    atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
  };
}
