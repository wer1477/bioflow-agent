import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSubagentRow,
  formatSubagentDuration,
  isSubagentConversation,
  subagentRowLabel,
  subagentRowMeta,
  subagentStatusMeta,
  subagentTriggerLabel,
} from '../src/domain/subagent_view.js';

test('status words map onto the shared state dots', () => {
  assert.deepEqual(subagentStatusMeta('running'), { state: 'running', label: '运行中' });
  assert.deepEqual(subagentStatusMeta('completed'), { state: 'done', label: '已完成' });
  assert.deepEqual(subagentStatusMeta('failed'), { state: 'error', label: '失败' });
  assert.deepEqual(subagentStatusMeta('cancelled'), { state: 'warning', label: '已取消' });
  assert.equal(subagentStatusMeta('unknown').state, 'idle');
  assert.equal(subagentStatusMeta(undefined).state, 'idle', 'an absent status is never rendered as finished work');
});

test('a row label prefers the delegation description and falls back to the title', () => {
  assert.equal(subagentRowLabel({ description: 'reads QC', title: 'Subagent · whatever' }), 'reads QC');
  assert.equal(subagentRowLabel({ description: '   ', title: 'Subagent · variant calling' }), 'variant calling');
  assert.equal(subagentRowLabel({ title: '' }), '子 Agent');
  assert.equal(subagentRowLabel(null), '子 Agent');
});

test('duration formatting stays readable from seconds to hours', () => {
  assert.equal(formatSubagentDuration(0), '0s');
  assert.equal(formatSubagentDuration(undefined), '0s');
  assert.equal(formatSubagentDuration(-1000), '0s');
  assert.equal(formatSubagentDuration(45_000), '45s');
  assert.equal(formatSubagentDuration(130_000), '2m10s');
  assert.equal(formatSubagentDuration(3_900_000), '1h05m');
});

test('row meta shows message count and elapsed time, marking a running child as such', () => {
  assert.equal(subagentRowMeta({ messageCount: 4, status: 'completed', durationMs: 42_000 }), '4 条消息 · 42s');
  assert.equal(subagentRowMeta({ messageCount: 2, status: 'running', durationMs: 61_000 }), '2 条消息 · 已运行 1m01s');
  assert.equal(subagentRowMeta({ messageCount: 0, status: 'unknown', durationMs: null }), '');
});

test('the header trigger counts children and running children, and hides when empty', () => {
  assert.equal(subagentTriggerLabel({ total: 0, running: 0 }), '');
  assert.equal(subagentTriggerLabel({ total: 2, running: 0 }), '子 Agent 2');
  assert.equal(subagentTriggerLabel({ total: 2, running: 1 }), '子 Agent 2 · 1 运行中');
  assert.equal(subagentTriggerLabel({ total: 3 }), '子 Agent 3', 'a missing running count is not "NaN 运行中"');
});

test('a child conversation is recognised by its parent link, not by its title', () => {
  assert.equal(isSubagentConversation({ parentConversationId: 'parent-1' }), true);
  assert.equal(isSubagentConversation({ title: 'Subagent · reads QC' }), false);
  assert.equal(isSubagentConversation(null), false);
});

test('the child finds its own row in the parent catalog', () => {
  const rows = [{ conversationId: 'a' }, { conversationId: 'b' }];
  assert.deepEqual(findSubagentRow(rows, 'b'), { conversationId: 'b' });
  assert.equal(findSubagentRow(rows, 'missing'), null);
  assert.equal(findSubagentRow(rows, ''), null);
  assert.equal(findSubagentRow(null, 'a'), null);
});
