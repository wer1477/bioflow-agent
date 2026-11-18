import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCK_DEFAULT_WIDTH, DOCK_MAX_WIDTH, DOCK_MIN_CONVERSATION_WIDTH, DOCK_MIN_WIDTH, DOCK_TABS,
  availableDockTabs, clampDockWidth, fileTabId, readDockState, resolveDockTab, shouldAutoCollapseDock, tabFilePath,
} from '../src/domain/right_dock.js';

test('the dock defaults to a width that can hold a file view', () => {
  assert.ok(DOCK_DEFAULT_WIDTH >= 420);
  assert.ok(DOCK_MAX_WIDTH >= 900);
  assert.equal(clampDockWidth(DOCK_DEFAULT_WIDTH), DOCK_DEFAULT_WIDTH);
});

test('clampDockWidth keeps the width inside the allowed range', () => {
  assert.equal(clampDockWidth(DOCK_MIN_WIDTH - 100), DOCK_MIN_WIDTH);
  assert.equal(clampDockWidth(DOCK_MAX_WIDTH + 100), DOCK_MAX_WIDTH);
  assert.equal(clampDockWidth(400), 400);
  assert.equal(clampDockWidth(400.6), 401);
});

test('clampDockWidth falls back to the default for junk input', () => {
  assert.equal(clampDockWidth(undefined), DOCK_DEFAULT_WIDTH);
  assert.equal(clampDockWidth(null), DOCK_DEFAULT_WIDTH);
  assert.equal(clampDockWidth('abc'), DOCK_DEFAULT_WIDTH);
  assert.equal(clampDockWidth(NaN), DOCK_DEFAULT_WIDTH);
  assert.equal(clampDockWidth(Infinity), DOCK_DEFAULT_WIDTH);
});

test('the project tab is always first and never closable', () => {
  assert.deepEqual(DOCK_TABS, ['files']);
  assert.deepEqual(availableDockTabs(), ['files']);
  assert.deepEqual(availableDockTabs({ openPaths: ['a.md', 'data/b.tsv'] }), ['files', 'file:a.md', 'file:data/b.tsv']);
  // 空路径不该造出空标签。
  assert.deepEqual(availableDockTabs({ openPaths: ['', 'a.md'] }), ['files', 'file:a.md']);
});

test('file tab ids round-trip through the prefix', () => {
  assert.equal(fileTabId('runs/data/a.tsv'), 'file:runs/data/a.tsv');
  assert.equal(tabFilePath('file:runs/data/a.tsv'), 'runs/data/a.tsv');
  assert.equal(tabFilePath('files'), '');
  assert.equal(fileTabId(''), 'file:');
});

test('a file tab stays selected while it is open and falls back to files once closed', () => {
  const available = availableDockTabs({ openPaths: ['a.md'] });
  assert.equal(resolveDockTab('file:a.md', available), 'file:a.md');
  assert.equal(resolveDockTab('file:a.md', ['files']), 'files');
});

test('resolveDockTab falls back when the requested panel has no content', () => {
  assert.equal(resolveDockTab('files', ['files']), 'files');
  assert.equal(resolveDockTab('preview', ['files']), 'files');
  assert.equal(resolveDockTab('nonsense', ['files']), 'files');
  assert.equal(resolveDockTab('preview', []), 'files');
});

test('readDockState restores width and collapsed, clamping bad values', () => {
  assert.deepEqual(readDockState('{"width":420,"collapsed":true}'), { width: 420, collapsed: true });
  assert.deepEqual(readDockState('{"width":9999}'), { width: DOCK_MAX_WIDTH, collapsed: false });
  assert.deepEqual(readDockState('{"width":10}'), { width: DOCK_MIN_WIDTH, collapsed: false });
});

test('readDockState survives corrupt or empty storage', () => {
  assert.deepEqual(readDockState(''), { width: DOCK_DEFAULT_WIDTH, collapsed: false });
  assert.deepEqual(readDockState('not json'), { width: DOCK_DEFAULT_WIDTH, collapsed: false });
  assert.deepEqual(readDockState('null'), { width: DOCK_DEFAULT_WIDTH, collapsed: false });
  assert.deepEqual(readDockState('[]'), { width: DOCK_DEFAULT_WIDTH, collapsed: false });
});

test('the dock collapses itself only when the conversation would get too narrow', () => {
  const width = DOCK_DEFAULT_WIDTH;
  // 刚好塞得下：dock 保持自己的宽度，对话页留下保底宽度。
  assert.equal(shouldAutoCollapseDock({ layoutWidth: width + DOCK_MIN_CONVERSATION_WIDTH, width }), false);
  // 差 1px 就收成 rail，而不是把对话页压到保底以下。
  assert.equal(shouldAutoCollapseDock({ layoutWidth: width + DOCK_MIN_CONVERSATION_WIDTH - 1, width }), true);
  // 首帧还没有布局宽度：不要闪一下收起。
  assert.equal(shouldAutoCollapseDock({ layoutWidth: 0, width }), false);
  assert.equal(shouldAutoCollapseDock({ layoutWidth: undefined, width }), false);
  // 脏宽度先钳制再判断，和渲染用的宽度保持一致。
  assert.equal(shouldAutoCollapseDock({ layoutWidth: 900, width: 10 }), false);
});
