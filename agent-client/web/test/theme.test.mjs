import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePreference, resolveTheme } from '../src/app/theme.js';

test('parsePreference narrows stored values to the three preferences', () => {
  assert.equal(parsePreference('light'), 'light');
  assert.equal(parsePreference('dark'), 'dark');
  assert.equal(parsePreference('system'), 'system');
  // 旧版本「没有键」等于跟随系统；非法值也不能把用户卡在没有主题的状态。
  assert.equal(parsePreference(null), 'system');
  assert.equal(parsePreference(''), 'system');
  assert.equal(parsePreference('junk'), 'system');
  assert.equal(parsePreference(undefined), 'system');
});

test('resolveTheme follows the system only for the system preference', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  // 缺省/非法值按 system 处理。
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('junk', false), 'light');
});
