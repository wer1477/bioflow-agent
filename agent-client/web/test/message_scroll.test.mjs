import assert from 'node:assert/strict';
import test from 'node:test';
import { STICK_BOTTOM_THRESHOLD, distanceFromBottom, isNearBottom, scrollEdges } from '../src/domain/message_scroll.js';

const listElement = ({ scrollHeight, scrollTop, clientHeight }) => ({ scrollHeight, scrollTop, clientHeight });

test('distanceFromBottom 返回剩余可滚动距离', () => {
  assert.equal(distanceFromBottom(listElement({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 })), 100);
  assert.equal(distanceFromBottom(listElement({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })), 0);
});

test('distanceFromBottom 对未挂载的列表返回 Infinity（视为不贴底）', () => {
  assert.equal(distanceFromBottom(null), Number.POSITIVE_INFINITY);
  assert.equal(distanceFromBottom(undefined), Number.POSITIVE_INFINITY);
});

test('isNearBottom 以 80px 为界判定是否跟随尾部', () => {
  const at = (top) => listElement({ scrollHeight: 1000, scrollTop: top, clientHeight: 500 });
  assert.equal(isNearBottom(at(500)), true, '贴底');
  assert.equal(isNearBottom(at(500 - (STICK_BOTTOM_THRESHOLD - 1))), true, '距底 79px');
  assert.equal(isNearBottom(at(500 - STICK_BOTTOM_THRESHOLD)), false, '距底 80px 已不算贴底');
  assert.equal(isNearBottom(at(0)), false, '滚到顶部');
  assert.equal(isNearBottom(null), false);
});

test('scrollEdges 判到顶、到底与两者之间', () => {
  const box = (scrollTop, clientHeight, scrollHeight) => ({ scrollTop, clientHeight, scrollHeight });
  assert.deepEqual(scrollEdges(box(0, 400, 1200)), { atTop: true, atBottom: false });
  assert.deepEqual(scrollEdges(box(400, 400, 1200)), { atTop: false, atBottom: false });
  assert.deepEqual(scrollEdges(box(800, 400, 1200)), { atTop: false, atBottom: true });
  // 内容不足一屏：两头都算到，两边都不该渐隐。
  assert.deepEqual(scrollEdges(box(0, 400, 300)), { atTop: true, atBottom: true });
  assert.deepEqual(scrollEdges(null), { atTop: true, atBottom: true });
});

test('scrollEdges 用一像素容差吸收 sub-pixel 取整误差', () => {
  const box = (scrollTop) => ({ scrollTop, clientHeight: 400, scrollHeight: 1200 });
  // 高度不是整数时 scrollTop 会差一点点够不到底；那一点不该被当成"下面还有内容"。
  assert.equal(scrollEdges(box(799.4)).atBottom, true);
  assert.equal(scrollEdges(box(790)).atBottom, false);
});
