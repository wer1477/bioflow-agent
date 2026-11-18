import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCK_AUTO_WIDEN_WIDTH, DOCK_DEFAULT_WIDTH, DOCK_MAX_WIDTH, DOCK_MIN_CONVERSATION_WIDTH, DOCK_MIN_WIDTH,
  DOCK_WIDE_MAX_WIDTH, dockMaximizedWidth, isWidePreviewPath, resolveDockWidth, shouldAutoCollapseDock,
  shouldAutoWiden,
} from '../src/domain/right_dock.js';

/** 一块足够大的会话区：既能放下面板，又能给对话页留够宽度。 */
const ROOMY = 1920;

test('全宽预览按"给对话页留保底宽度"算，且有上限', () => {
  assert.equal(dockMaximizedWidth(ROOMY), DOCK_WIDE_MAX_WIDTH);
  // 布局比上限还宽时不再长，否则面板会变成整页。
  assert.equal(dockMaximizedWidth(4000), DOCK_WIDE_MAX_WIDTH);
  // 中等窗口：把对话页的保底宽度让出去，剩下的都给面板。
  assert.equal(dockMaximizedWidth(1400), 1400 - DOCK_MIN_CONVERSATION_WIDTH);
  // 极窄窗口：不会算出比最小宽度还小的值。
  assert.equal(dockMaximizedWidth(500), DOCK_MIN_WIDTH);
  // 首帧还没有布局宽度：退回拖拽上限，而不是 0。
  assert.equal(dockMaximizedWidth(0), DOCK_MAX_WIDTH);
  assert.equal(dockMaximizedWidth(undefined), DOCK_MAX_WIDTH);
});

test('只有"在窄栏里根本读不了"的内容才会自动撑宽', () => {
  assert.equal(isWidePreviewPath('paper.pdf'), true);
  assert.equal(isWidePreviewPath('PAPER.PDF'), true);
  assert.equal(isWidePreviewPath('figures/pca.png'), true);
  assert.equal(isWidePreviewPath('plots/heatmap.svg'), true);
  assert.equal(isWidePreviewPath('analysis.ipynb'), true);
  // 文本和表格有自己的横向滚动，打开就把面板撑宽会打断阅读节奏。
  assert.equal(isWidePreviewPath('notes.md'), false);
  assert.equal(isWidePreviewPath('data/expr.tsv'), false);
  assert.equal(isWidePreviewPath('bin/pipeline.py'), false);
  assert.equal(isWidePreviewPath(''), false);
});

test('自动撑宽要求：窄栏、宽内容、并且撑完还留得下对话页', () => {
  const narrow = DOCK_DEFAULT_WIDTH;
  assert.equal(shouldAutoWiden({ width: narrow, layoutWidth: ROOMY, path: 'paper.pdf' }), true);
  // 已经够宽了就不再动。
  assert.equal(shouldAutoWiden({ width: DOCK_AUTO_WIDEN_WIDTH, layoutWidth: ROOMY, path: 'paper.pdf' }), false);
  // 不是宽内容。
  assert.equal(shouldAutoWiden({ width: narrow, layoutWidth: ROOMY, path: 'notes.md' }), false);
  // 窗口放不下 720 + 对话页保底：宁可不撑，也不把对话页压没。
  assert.equal(
    shouldAutoWiden({ width: narrow, layoutWidth: DOCK_AUTO_WIDEN_WIDTH + DOCK_MIN_CONVERSATION_WIDTH - 1, path: 'paper.pdf' }),
    false,
  );
  // 首帧还没有布局宽度。
  assert.equal(shouldAutoWiden({ width: narrow, layoutWidth: 0, path: 'paper.pdf' }), false);
});

test('渲染宽度优先级：最大化 > 自动撑宽 > 用户拖出来的宽度', () => {
  assert.equal(
    resolveDockWidth({ width: 320, layoutWidth: ROOMY, path: 'paper.pdf', maximized: true }),
    DOCK_WIDE_MAX_WIDTH,
  );
  assert.equal(
    resolveDockWidth({ width: 320, layoutWidth: ROOMY, path: 'paper.pdf' }),
    DOCK_AUTO_WIDEN_WIDTH,
  );
  // 用户本来就拖得比自动撑宽的阈值还宽：不要把他缩回去。
  assert.equal(resolveDockWidth({ width: 900, layoutWidth: ROOMY, path: 'paper.pdf' }), 900);
  // 普通文件保持用户宽度，脏输入退回默认值。
  assert.equal(resolveDockWidth({ width: 380, layoutWidth: ROOMY, path: 'notes.md' }), 380);
  assert.equal(resolveDockWidth({ width: null, layoutWidth: ROOMY, path: 'notes.md' }), DOCK_DEFAULT_WIDTH);
  // 自动撑宽不是用户宽度：切回普通文件时应该回到 320。
  assert.equal(resolveDockWidth({ width: 320, layoutWidth: ROOMY, path: 'notes.md' }), 320);
});

test('最大化后的宽度不参与"钳到拖拽上限"的收起判断', () => {
  const maximized = dockMaximizedWidth(ROOMY);
  // 1400px 的窗口：最大化面板 1040 + 对话页 360 = 1400，刚好不收起。
  assert.equal(shouldAutoCollapseDock({ layoutWidth: 1400, width: 1040 }), false);
  // 再窄 1px 就收起，而不是把对话页压到保底以下。
  assert.equal(shouldAutoCollapseDock({ layoutWidth: 1399, width: 1040 }), true);
  // 宽度超过 DOCK_MAX_WIDTH 时仍然按真实数值算（不是先钳到 1000）。
  assert.equal(shouldAutoCollapseDock({ layoutWidth: maximized + DOCK_MIN_CONVERSATION_WIDTH, width: maximized }), false);
});
