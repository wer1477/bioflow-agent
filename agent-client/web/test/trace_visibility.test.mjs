import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessageParts, hasVisibleLiveContent, isVisibleLiveEvent } from '../src/domain/trace.js';

/**
 * 直播事件 → 界面上会不会多出一行。
 *
 * `hasVisibleLiveContent` 是等待行让位的唯一判据，必须和渲染入口 `buildMessageParts`
 * 完全同源；这里逐类事件把两边钉在一起，将来新增事件类型会在这里先失败。
 */
const CASES = [
  // 后端自检 / 不产生对话行的事件
  { name: 'run_status', event: { type: 'run_status', runId: 'r', status: 'model_turn' }, visible: false },
  { name: 'runtime banner', event: { type: 'info', content: 'Agent: Main Agent; CoreTools: read_file; Skills: 3' }, visible: false },
  { name: 'healthy mcp status', event: { type: 'mcp_status', connected: ['tavily'], failed: [] }, visible: false },
  { name: 'token usage', event: { type: 'loop_health', reason: 'token_usage_observed' }, visible: false },
  { name: 'route decision', event: { type: 'route_decision', roleId: 'role-1' }, visible: false },
  { name: 'role switch', event: { type: 'role_switch', toRoleId: 'role-1' }, visible: false },
  { name: 'goal round', event: { type: 'goal_round', round: 1 }, visible: false },
  { name: 'empty info', event: { type: 'info', content: '' }, visible: false },
  { name: 'empty thinking', event: { type: 'thinking', content: '' }, visible: false },
  { name: 'empty plan', event: { type: 'plan_update', steps: [] }, visible: false },
  { name: 'non object', event: null, visible: false },

  // 会产出一条可见行的事件
  { name: 'narration', event: { type: 'info', content: '先看目录' }, visible: true },
  { name: 'thinking', event: { type: 'thinking', content: '分析一下' }, visible: true },
  { name: 'failed mcp status', event: { type: 'mcp_status', connected: [], failed: ['x'] }, visible: true },
  { name: 'tool start', event: { type: 'tool_call_start', tool_name: 'read_file', arguments: {} }, visible: true },
  { name: 'tool result', event: { type: 'tool_call_result', tool_name: 'read_file', result: 'ok' }, visible: true },
  { name: 'plan', event: { type: 'plan_update', steps: ['a'] }, visible: true },
  { name: 'planning panel', event: { type: 'planning_panel' }, visible: true },
  { name: 'security approval', event: { type: 'security_approval_request', approvalId: 'a' }, visible: true },
  { name: 'workspace artifact', event: { type: 'workspace_artifact', artifact: { path: 'a' } }, visible: true },
  { name: 'visible loop health', event: { type: 'loop_health', reason: 'context_compaction_started', detail: 'x' }, visible: true },
  { name: 'error', event: { type: 'error', error: 'boom' }, visible: true },
];

for (const { name, event, visible } of CASES) {
  test(`visibility of ${name} agrees with buildMessageParts`, () => {
    assert.equal(isVisibleLiveEvent(event), visible);
    assert.equal(hasVisibleLiveContent([{ type: 'run_status', status: 'model_turn' }, event]), visible);
    assert.equal(buildMessageParts([event], null, 'live', 'run-1').length > 0, visible);
  });
}

test('an empty stream has nothing visible', () => {
  assert.equal(hasVisibleLiveContent([]), false);
  assert.equal(hasVisibleLiveContent(undefined), false);
  assert.equal(buildMessageParts([]).length, 0);
});

test('hidden status events do not hide a real narration that follows them', () => {
  const events = [
    { type: 'run_status', status: 'building_context' },
    { type: 'info', content: 'Agent: Main Agent; CoreTools: read_file' },
    { type: 'loop_health', reason: 'context_watermark_checked' },
    { type: 'info', content: '先看目录' },
  ];
  assert.equal(hasVisibleLiveContent(events), true);
  assert.equal(buildMessageParts(events, null, 'live', 'run-1').length > 0, true);
});
