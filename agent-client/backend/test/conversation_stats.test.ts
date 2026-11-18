import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConversationStats, summariseTranscript } from '../src/agent/conversation_stats.js';
import type { TranscriptRecord } from '../src/agent/transcript_log.js';

let sequence = 0;

function record(
  type: string,
  createdAt: string,
  data: Record<string, unknown> = {},
  extra: { runId?: string; requestId?: string } = {},
): TranscriptRecord {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence: sequence++,
    createdAt,
    conversationId: 'conversation-stats',
    runId: extra.runId || 'run-1',
    ...(extra.requestId ? { requestId: extra.requestId } : {}),
    type,
    data,
  };
}

function usage(promptTokens: number, completionTokens: number, cachedPromptTokens: number | null): Record<string, unknown> {
  return {
    type: 'loop_health',
    level: 'info',
    reason: 'token_usage_observed',
    detail: 'usage',
    tokenUsage: { promptTokens, completionTokens, cachedPromptTokens },
  };
}

test('session stats fold turns, steps, timing, tool time and cache usage', () => {
  sequence = 0;
  const records = [
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.100Z', {}, { requestId: 'request-1' }),
    record('model_chunk', '2026-01-01T00:00:00.300Z', { chunk: { choices: [{ delta: { content: 'hel' } }] } }, { requestId: 'request-1' }),
    record('engine_event', '2026-01-01T00:00:00.800Z', { event: usage(1000, 100, 750) }),
    record('model_response', '2026-01-01T00:00:00.900Z', { finishReason: 'tool_calls' }, { requestId: 'request-1' }),
    record('tool_result', '2026-01-01T00:00:00.950Z', { toolName: 'shell', durationMs: 250 }),
    record('model_request', '2026-01-01T00:00:01.100Z', {}, { requestId: 'request-2' }),
    record('model_chunk', '2026-01-01T00:00:01.200Z', { chunk: { choices: [{ delta: { content: 'lo' } }] } }, { requestId: 'request-2' }),
    record('engine_event', '2026-01-01T00:00:01.500Z', { event: usage(2000, 200, 1500) }),
    record('model_response', '2026-01-01T00:00:01.600Z', { finishReason: 'stop' }, { requestId: 'request-2' }),
    record('run_end', '2026-01-01T00:00:01.700Z', { status: 'completed' }),
    record('run_start', '2026-01-01T00:01:00.000Z', {}, { runId: 'run-2' }),
    record('model_request', '2026-01-01T00:01:00.100Z', {}, { runId: 'run-2', requestId: 'request-3' }),
    record('model_chunk', '2026-01-01T00:01:00.200Z', { chunk: { choices: [{ delta: { content: 'again' } }] } }, { runId: 'run-2', requestId: 'request-3' }),
    record('engine_event', '2026-01-01T00:01:00.500Z', { event: usage(500, 50, 0) }, { runId: 'run-2' }),
    record('model_response', '2026-01-01T00:01:00.700Z', { finishReason: 'stop' }, { runId: 'run-2', requestId: 'request-3' }),
  ];

  const stats = summariseTranscript(records);

  assert.equal(stats.activity.turns, 2);
  assert.equal(stats.activity.steps, 3);
  assert.equal(stats.activity.llmMs, 800 + 500 + 600);
  assert.equal(stats.activity.toolMs, 250);
  assert.equal(stats.activity.ttftMs, 200 + 100 + 100);
  assert.equal(stats.activity.ttftSteps, 3);
  assert.equal(stats.activity.decodeMs, 600 + 400 + 500);
  assert.equal(stats.activity.decodeTokens, 350);
  assert.deepEqual(stats.activity.tokensPerSecond, 350 / (1500 / 1000));
  assert.equal(stats.activity.ttftPromptTokens, 3500);
  assert.equal(stats.activity.prefillMsPerKTok, 400 / 3.5);

  assert.equal(stats.tokenUsage.promptTokens, 3500);
  assert.equal(stats.tokenUsage.cacheReadTokens, 2250);
  assert.equal(stats.tokenUsage.uncachedInputTokens, 1250);
  assert.equal(stats.tokenUsage.outputTokens, 350);
  assert.equal(stats.tokenUsage.totalTokens, 3850);
  assert.equal(stats.tokenUsage.cacheReportedSteps, 3);
  assert.equal(stats.tokenUsage.cacheTotalSteps, 3);
  assert.equal(stats.tokenUsage.cacheHitPercent, 64.3);
});

test('cache coverage counts attempts that answered nothing', () => {
  sequence = 0;
  const stats = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.100Z', {}, { requestId: 'request-1' }),
    record('engine_event', '2026-01-01T00:00:00.500Z', { event: usage(1000, 10, 0) }),
    record('model_response', '2026-01-01T00:00:00.600Z', {}, { requestId: 'request-1' }),
    record('model_request', '2026-01-01T00:00:01.100Z', {}, { requestId: 'request-2' }),
    record('engine_event', '2026-01-01T00:00:01.500Z', { event: usage(900, 10, null) }),
    record('model_response', '2026-01-01T00:00:01.600Z', {}, { requestId: 'request-2' }),
    // No usage frame at all: the cache status is unknown, so it still belongs in the
    // denominator — otherwise a mostly-uninstrumented session reports a confident ratio.
    record('model_request', '2026-01-01T00:00:02.100Z', {}, { requestId: 'request-3' }),
    record('model_response', '2026-01-01T00:00:02.600Z', {}, { requestId: 'request-3' }),
  ]);

  assert.equal(stats.tokenUsage.cacheReportedSteps, 1);
  assert.equal(stats.tokenUsage.cacheTotalSteps, 3);
  assert.equal(stats.tokenUsage.cacheHitPercent, 0);
});

test('prefill cost collapses when the same prompt is served from cache', () => {
  sequence = 0;
  const cold = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.000Z', {}, { requestId: 'cold' }),
    record('model_chunk', '2026-01-01T00:00:07.500Z', { chunk: { choices: [{ delta: { content: 'ok' } }] } }, { requestId: 'cold' }),
    record('engine_event', '2026-01-01T00:00:07.600Z', { event: usage(23_128, 4, 0) }),
    record('model_response', '2026-01-01T00:00:07.700Z', {}, { requestId: 'cold' }),
  ]);
  sequence = 0;
  const warm = summariseTranscript([
    record('run_start', '2026-01-01T00:01:00.000Z'),
    record('model_request', '2026-01-01T00:01:00.000Z', {}, { requestId: 'warm' }),
    record('model_chunk', '2026-01-01T00:01:00.240Z', { chunk: { choices: [{ delta: { content: 'ok' } }] } }, { requestId: 'warm' }),
    record('engine_event', '2026-01-01T00:01:00.300Z', { event: usage(23_128, 4, 23_024) }),
    record('model_response', '2026-01-01T00:01:00.400Z', {}, { requestId: 'warm' }),
  ]);

  // Both requests sent the same prompt; only the warm one reused its prefix.
  assert.equal(cold.activity.prefillMsPerKTok, 7_500 / 23.128);
  assert.equal(warm.activity.prefillMsPerKTok, 240 / 23.128);
  assert.ok((cold.activity.prefillMsPerKTok ?? 0) > (warm.activity.prefillMsPerKTok ?? 0) * 20);
});

test('a completed partial cache hit never rounds up to a perfect hit', () => {
  sequence = 0;
  const stats = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.100Z', {}, { requestId: 'request-1' }),
    record('engine_event', '2026-01-01T00:00:00.500Z', { event: usage(1000, 10, 999) }),
    record('model_response', '2026-01-01T00:00:00.600Z', {}, { requestId: 'request-1' }),
  ]);

  assert.equal(stats.tokenUsage.cacheHitPercent, 99.9);
});

test('missing cache counters stay unknown instead of becoming a miss', () => {
  sequence = 0;
  const stats = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.100Z', {}, { requestId: 'request-1' }),
    record('engine_event', '2026-01-01T00:00:00.500Z', { event: usage(800, 40, null) }),
    record('model_response', '2026-01-01T00:00:00.600Z', {}, { requestId: 'request-1' }),
  ]);

  assert.equal(stats.tokenUsage.promptTokens, 800);
  assert.equal(stats.tokenUsage.cacheReadTokens, 0);
  assert.equal(stats.tokenUsage.uncachedInputTokens, 800);
  assert.equal(stats.tokenUsage.cacheHitPercent, null);
});

test('usage without request timing still counts toward tokens but not toward speed', () => {
  sequence = 0;
  const stats = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('engine_event', '2026-01-01T00:00:00.500Z', { event: usage(500, 25, null) }),
  ]);

  assert.equal(stats.tokenUsage.totalTokens, 525);
  assert.equal(stats.activity.steps, 0);
  assert.equal(stats.activity.decodeMs, 0);
  assert.equal(stats.activity.tokensPerSecond, null);
});

test('repeated usage frames for one request collapse to the newest reading', () => {
  sequence = 0;
  const stats = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.100Z', {}, { requestId: 'request-1' }),
    record('model_chunk', '2026-01-01T00:00:00.300Z', { chunk: { choices: [{ delta: { content: 'hi' } }] } }, { requestId: 'request-1' }),
    record('engine_event', '2026-01-01T00:00:00.400Z', { event: usage(1000, 10, 800) }),
    record('engine_event', '2026-01-01T00:00:00.500Z', { event: usage(1000, 20, 800) }),
    record('model_response', '2026-01-01T00:00:00.900Z', {}, { requestId: 'request-1' }),
  ]);

  assert.equal(stats.tokenUsage.promptTokens, 1000);
  assert.equal(stats.tokenUsage.outputTokens, 20);
  assert.equal(stats.tokenUsage.totalTokens, 1020);
  assert.equal(stats.activity.decodeTokens, 20);
});

test('an empty transcript yields zeroed statistics', () => {
  const stats = summariseTranscript([]);
  assert.deepEqual(stats.activity, {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    tokensPerSecond: null,
    ttftPromptTokens: 0,
    prefillMsPerKTok: null,
  });
  assert.equal(stats.tokenUsage.totalTokens, 0);
  assert.equal(stats.tokenUsage.cacheHitPercent, null);
  assert.equal(stats.tokenUsage.cacheReportedSteps, 0);
  assert.equal(stats.tokenUsage.cacheTotalSteps, 0);
});

test('merging conversations adds the totals instead of averaging the rates', () => {
  sequence = 0;
  const fast = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.000Z', {}, { requestId: 'request-fast' }),
    record('model_chunk', '2026-01-01T00:00:00.100Z', { chunk: { choices: [{ delta: { content: 'go' } }] } }, { requestId: 'request-fast' }),
    record('engine_event', '2026-01-01T00:00:00.200Z', { event: usage(1000, 900, 0) }),
    record('model_response', '2026-01-01T00:00:01.100Z', {}, { requestId: 'request-fast' }),
  ]);
  const slow = summariseTranscript([
    record('run_start', '2026-01-01T00:02:00.000Z', {}, { runId: 'run-2' }),
    record('model_request', '2026-01-01T00:02:00.000Z', {}, { runId: 'run-2', requestId: 'request-slow' }),
    record('model_chunk', '2026-01-01T00:02:00.100Z', { chunk: { choices: [{ delta: { content: 'ok' } }] } }, { runId: 'run-2', requestId: 'request-slow' }),
    record('engine_event', '2026-01-01T00:02:00.800Z', { event: usage(2000, 100, 0) }, { runId: 'run-2' }),
    record('model_response', '2026-01-01T00:02:01.900Z', {}, { runId: 'run-2', requestId: 'request-slow' }),
  ]);

  const merged = mergeConversationStats([fast, slow]);

  assert.equal(merged.activity.turns, 2);
  assert.equal(merged.activity.steps, 2);
  assert.equal(merged.activity.decodeTokens, 1000);
  assert.equal(merged.activity.decodeMs, 1000 + 1800);
  // Speed comes from the summed window: 1000 tokens over 2.8 s, not the average of both.
  assert.equal(merged.activity.tokensPerSecond, 1000 / 2.8);
  assert.notEqual(
    merged.activity.tokensPerSecond,
    ((fast.activity.tokensPerSecond || 0) + (slow.activity.tokensPerSecond || 0)) / 2,
  );
  assert.equal(merged.tokenUsage.totalTokens, 4000);
});

test('merging never dilutes a cache ratio with a session that reported none', () => {
  sequence = 0;
  const reporting = summariseTranscript([
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.100Z', {}, { requestId: 'request-1' }),
    record('engine_event', '2026-01-01T00:00:00.500Z', { event: usage(1000, 10, 1000) }),
    record('model_response', '2026-01-01T00:00:00.600Z', {}, { requestId: 'request-1' }),
  ]);
  const silent = summariseTranscript([
    record('run_start', '2026-01-01T00:01:00.000Z', {}, { runId: 'run-2' }),
    record('model_request', '2026-01-01T00:01:00.100Z', {}, { runId: 'run-2', requestId: 'request-2' }),
    record('engine_event', '2026-01-01T00:01:00.500Z', { event: usage(4000, 20, null) }, { runId: 'run-2' }),
    record('model_response', '2026-01-01T00:01:00.600Z', {}, { runId: 'run-2', requestId: 'request-2' }),
  ]);
  assert.equal(silent.tokenUsage.cacheHitPercent, null);

  const merged = mergeConversationStats([reporting, silent]);
  assert.equal(merged.tokenUsage.cacheReadTokens, 1000);
  assert.equal(merged.tokenUsage.cachePromptTokens, 1000);
  assert.equal(merged.tokenUsage.cacheHitPercent, 100);

  // Nothing reported a counter at all: still unknown, never 0%.
  assert.equal(mergeConversationStats([silent]).tokenUsage.cacheHitPercent, null);
});

test('merging is the same fold as one transcript holding every record', () => {
  sequence = 0;
  const firstHalf = [
    record('run_start', '2026-01-01T00:00:00.000Z'),
    record('model_request', '2026-01-01T00:00:00.100Z', { llm: { baseUrl: 'https://a.test/v1', model: 'model-a' } }, { requestId: 'request-1' }),
    record('engine_event', '2026-01-01T00:00:00.500Z', { event: usage(1000, 100, 500) }),
    record('model_response', '2026-01-01T00:00:00.600Z', {}, { requestId: 'request-1' }),
  ];
  const secondHalf = [
    record('run_start', '2026-01-01T00:01:00.000Z', {}, { runId: 'run-2' }),
    record('model_request', '2026-01-01T00:01:00.100Z', { llm: { baseUrl: 'https://b.test/v1', model: 'model-b' } }, { runId: 'run-2', requestId: 'request-2' }),
    record('engine_event', '2026-01-01T00:01:00.500Z', { event: usage(700, 30, 0) }, { runId: 'run-2' }),
    record('model_response', '2026-01-01T00:01:00.600Z', {}, { runId: 'run-2', requestId: 'request-2' }),
  ];

  const merged = mergeConversationStats([summariseTranscript(firstHalf), summariseTranscript(secondHalf)]);
  assert.deepEqual(merged, summariseTranscript([...firstHalf, ...secondHalf]));
});

test('merging nothing yields zeroed statistics', () => {
  const merged = mergeConversationStats([]);
  assert.equal(merged.activity.turns, 0);
  assert.equal(merged.activity.tokensPerSecond, null);
  assert.equal(merged.tokenUsage.cacheHitPercent, null);
  assert.deepEqual(merged.byModel, []);
});
