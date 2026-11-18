import assert from 'node:assert/strict';
import test from 'node:test';
import { latestRunStatus, resolvePendingTurn } from '../src/domain/pending_turn.js';

const status = (value) => ({ type: 'run_status', runId: 'run-1', status: value });

test('a finished or idle turn has no pending row', () => {
  assert.equal(resolvePendingTurn({ running: false, events: [status('model_turn')] }), null);
});

test('the row appears before the first backend status', () => {
  assert.deepEqual(
    resolvePendingTurn({ running: true, events: [] }),
    { phase: 'sending', label: '正在发送…' },
  );
});

test('a team root dispatches a role before it runs', () => {
  assert.deepEqual(
    resolvePendingTurn({ running: true, events: [{ type: 'route_decision', roleId: 'role-1' }], teamMode: true }),
    { phase: 'sending', label: '正在分派给团队成员…' },
  );
});

test('labels follow the real backend phases', () => {
  assert.equal(resolvePendingTurn({ running: true, events: [status('building_context')] }).phase, 'building_context');
  assert.equal(resolvePendingTurn({ running: true, events: [status('building_context')] }).label, '已发送 · 准备上下文…');
  assert.equal(resolvePendingTurn({ running: true, events: [status('model_turn')] }).label, '等待模型响应…');
  assert.equal(resolvePendingTurn({ running: true, events: [status('tool_execution')] }).label, '正在执行工具…');
  assert.equal(resolvePendingTurn({ running: true, events: [status('something_new')] }).label, '正在运行…');
});

test('the latest status wins', () => {
  const events = [status('building_context'), status('model_turn')];
  assert.equal(latestRunStatus(events), 'model_turn');
  assert.equal(resolvePendingTurn({ running: true, events }).label, '等待模型响应…');
});

test('the first visible process row makes the placeholder yield', () => {
  assert.equal(resolvePendingTurn({ running: true, events: [{ type: 'tool_call_start', tool_name: 'read_file' }] }), null);
  assert.equal(resolvePendingTurn({ running: true, events: [], visible: true }), null);
  // 隐藏事件不算可见内容：状态在变，界面仍然空着，占位行必须留着。
  assert.equal(
    resolvePendingTurn({ running: true, events: [status('model_turn'), { type: 'route_decision', roleId: 'role-1' }] })?.phase,
    'model_turn',
  );
});

test('the run state status stands in when live events were cleared on a switch', () => {
  // 切到别的会话再切回来：直播事件流已被 resetForConversationSwitch 清空，
  // 但本页仍在跑，run state 记得最后一步；不能退回「正在发送」。
  assert.deepEqual(
    resolvePendingTurn({ running: true, events: [], status: 'model_turn' }),
    { phase: 'model_turn', label: '等待模型响应…' },
  );
  // 事件流比状态表新时，事件优先。
  assert.equal(
    resolvePendingTurn({ running: true, events: [status('tool_execution')], status: 'model_turn' }).phase,
    'tool_execution',
  );
  // starting 不是后端相位，仍然按「发送中」处理。
  assert.equal(resolvePendingTurn({ running: true, events: [], status: 'starting' }).phase, 'sending');
});
