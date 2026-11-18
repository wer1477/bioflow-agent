import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityDetail,
  activityLabel,
  cacheCoverage,
  contextNote,
  contextSegments,
  formatCacheHitPercent,
  formatPrefillCost,
  formatStatDuration,
  formatTokensPerSecond,
  usageDetail,
  usageLabel,
} from '../src/domain/conversation_stats.js';

test('activity pill keeps DSH compact syntax', () => {
  assert.equal(
    activityLabel({ turns: 3, steps: 37, tokensPerSecond: 187.4 }),
    '3 轮 37 步 · 187 tok/s',
  );
  assert.equal(activityLabel({ turns: 1, steps: 0, tokensPerSecond: null }), '');
  assert.equal(activityLabel({ turns: 2, steps: 4, tokensPerSecond: null }), '2 轮 4 步');
  assert.equal(formatTokensPerSecond(9.94), '9.9');
  assert.equal(formatTokensPerSecond(0), '');
  assert.equal(formatTokensPerSecond('junk'), '');
});

test('activity tooltip only lists measured timings', () => {
  assert.equal(
    activityDetail({ llmMs: 12_300, toolMs: 3_400, ttftMs: 1_600, ttftSteps: 2, tokensPerSecond: 187 }),
    ['模型用时 12.3s', '工具调用用时 3.4s', '首 token 平均 0.8s', '输出速度 187 tok/s'].join('\n'),
  );
  assert.equal(activityDetail({}), '');
  assert.equal(formatStatDuration(162_000), '2m42s');
  assert.equal(formatStatDuration(0), '');
});

test('usage pill shows total tokens and cache hit only when known', () => {
  assert.equal(
    usageLabel({ totalTokens: 2_700_000, cacheHitPercent: 90, cacheReportedSteps: 12, cacheTotalSteps: 12 }),
    '2.7M tok · 缓存命中 90%',
  );
  // Never reported: say so instead of hiding the segment, or "not measured" reads as "fine".
  assert.equal(usageLabel({ totalTokens: 2_700_000, cacheHitPercent: null }), '2.7M tok · 缓存未上报');
  assert.equal(usageLabel({ totalTokens: 0 }), '');
  assert.equal(formatCacheHitPercent(99.9), '99.9');
  assert.equal(formatCacheHitPercent(90), '90');
  assert.equal(formatCacheHitPercent(null), '');
});

test('a partially instrumented ratio always shows its sample size', () => {
  // Three of sixty-four requests reported, and all three missed. A bare 0% here is what
  // made a working prefix cache look broken.
  assert.equal(
    usageLabel({ totalTokens: 70_823, cacheHitPercent: 0, cacheReportedSteps: 3, cacheTotalSteps: 64 }),
    '71k tok · 缓存命中 0%（3/64 步）',
  );
  assert.equal(
    usageDetail({
      uncachedInputTokens: 1000,
      cacheReadTokens: 900,
      outputTokens: 50,
      cacheHitPercent: 90,
      cacheReportedSteps: 3,
      cacheTotalSteps: 64,
    }),
    '未缓存输入 1k tok\n缓存读取 900 tok\n缓存上报 3/64 步\n输出 50 tok',
  );
});

test('usage tooltip omits the cache row when the provider never reported it', () => {
  assert.equal(
    usageDetail({ uncachedInputTokens: 1000, cacheReadTokens: 0, outputTokens: 50, cacheHitPercent: null }),
    '未缓存输入 1k tok\n输出 50 tok',
  );
  assert.equal(
    usageDetail({
      uncachedInputTokens: 500,
      cacheReadTokens: 4500,
      outputTokens: 50,
      cacheHitPercent: 90,
      cacheReportedSteps: 4,
      cacheTotalSteps: 4,
    }),
    '未缓存输入 500 tok\n缓存读取 4.5k tok\n缓存上报 4/4 步\n输出 50 tok',
  );
});

test('prefill cost is shown as a per-1k-token figure', () => {
  assert.equal(
    activityDetail({ llmMs: 12_300, ttftMs: 1_600, ttftSteps: 2, prefillMsPerKTok: 114.2857, tokensPerSecond: 187 }),
    ['模型用时 12.3s', '首 token 平均 0.8s', '预填充成本 114.29 ms/ktok', '输出速度 187 tok/s'].join('\n'),
  );
  assert.equal(formatPrefillCost(0.024), '0.02 ms/ktok');
  assert.equal(formatPrefillCost(null), '');
  assert.equal(cacheCoverage({ cacheReportedSteps: 0, cacheTotalSteps: 0 }), null);
  assert.deepEqual(cacheCoverage({ cacheReportedSteps: 3, cacheTotalSteps: 64 }), {
    reported: 3,
    total: 64,
    complete: false,
  });
});

test('context segments split the meter into three proportional categories', () => {
  const segments = contextSegments({
    percent: 12,
    breakdown: { system: 1000, tools: 3000, messages: 6000 },
  });
  assert.deepEqual(segments.map((segment) => segment.key), ['system', 'tools', 'messages']);
  assert.deepEqual(segments.map((segment) => segment.label), ['系统提示词', '工具定义', '对话消息']);
  assert.deepEqual(segments.map((segment) => segment.tokens), [1000, 3000, 6000]);
  const widths = segments.map((segment) => segment.width);
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 12);
  assert.equal(widths[0], 1.2);
  assert.equal(widths[1], 3.6);
  assert.equal(widths[2], 7.2);
});

test('context segments keep zero rows but give them no width', () => {
  const segments = contextSegments({ percent: 0, breakdown: { system: 0, tools: 0, messages: 0 } });
  assert.deepEqual(segments.map((segment) => segment.width), [0, 0, 0]);
  assert.deepEqual(contextSegments({ percent: 12 }).map((segment) => segment.width), [0, 0, 0]);
});

test('context note reports compaction and watermark state', () => {
  assert.match(
    contextNote({ checkpoint: { createdAt: '2026-01-01T03:04:00.000Z' }, softExceeded: true }),
    /^已压缩 .+ · 已超过软阈值$/,
  );
  assert.equal(contextNote({ hardExceeded: true }), '已超过硬阈值');
  assert.equal(contextNote({}), '');
});
