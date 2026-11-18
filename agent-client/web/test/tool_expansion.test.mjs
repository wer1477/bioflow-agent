import assert from 'node:assert/strict';
import test from 'node:test';
import { traceExpansionId, toggleToolExpansion } from '../src/domain/tool_expansion.js';
import { buildMessageParts, buildTraceItems, findRunId } from '../src/domain/trace.js';

const start = (toolName) => ({ type: 'tool_call_start', tool_name: toolName, arguments: {} });
const result = (toolName) => ({ type: 'tool_call_result', tool_name: toolName, result: '{}' });
/** 只有工具行带 callId；plan / mcp / runtime 行没有跨阶段稳定的身份。 */
const toolIds = (items) => items.filter((item) => item.callId).map(traceExpansionId);
const toolKeys = (items) => items.filter((item) => item.callId).map((item) => item.key);

const LIVE_EVENTS = [
  { type: 'run_status', runId: 'run-1', status: 'building_context' },
  { type: 'content', content: '先看目录' },
  start('read_file'),
  result('read_file'),
  { type: 'run_status', runId: 'run-1', status: 'tool_execution' },
  start('exec_command'),
  result('exec_command'),
];

test('toggleToolExpansion 增删展开项且不修改入参', () => {
  const empty = new Set();
  const opened = toggleToolExpansion(empty, 'a');
  assert.deepEqual([...opened], ['a']);
  assert.deepEqual([...empty], [], '不应原地修改入参');
  const closed = toggleToolExpansion(opened, 'a');
  assert.deepEqual([...closed], []);
  const both = toggleToolExpansion(opened, 'b');
  assert.deepEqual([...both].sort(), ['a', 'b']);
});

test('toggleToolExpansion 忽略空标识', () => {
  assert.deepEqual([...toggleToolExpansion(new Set(['a']), '')], ['a']);
  assert.deepEqual([...toggleToolExpansion(undefined, 'a')], ['a']);
});

test('traceExpansionId 优先用 callId，没有则退回位置 key', () => {
  assert.equal(traceExpansionId({ callId: 'run-1:tool:0:read_file', key: 'live-tool-1' }), 'run-1:tool:0:read_file');
  assert.equal(traceExpansionId({ key: 'live-plan' }), 'live-plan');
  assert.equal(traceExpansionId(null), '');
});

test('findRunId 取首个带 runId 的 run_status', () => {
  assert.equal(findRunId(LIVE_EVENTS), 'run-1');
  assert.equal(findRunId([{ type: 'run_status', runId: null }, { type: 'run_status', runId: 'run-2' }]), 'run-2');
  assert.equal(findRunId([start('read_file')]), '');
  assert.equal(findRunId(), '');
});

test('工具行的展开标识跨 live → 持久化不变', () => {
  // 持久化的 events 来自 transcript：叙事由 model_response 投影而来（是 info 行，但
  // 与直播侧逐块合成的 info 下标不同），也没有 run_status——所以数组下标两边不等，
  // 标识必须按「run 内第几个 tool_call_start」算。
  const persistedEvents = LIVE_EVENTS.filter((event) => event.type.startsWith('tool_call'));
  const live = buildTraceItems(LIVE_EVENTS, null, 'live', findRunId(LIVE_EVENTS));
  const persisted = buildTraceItems(persistedEvents, null, 'message-m1', 'run-1');

  assert.deepEqual(toolIds(live), [
    'run-1:tool:0:read_file',
    'run-1:tool:1:exec_command',
  ]);
  assert.deepEqual(toolIds(live), toolIds(persisted));
  assert.deepEqual(toolKeys(live), ['live-tool-2', 'live-tool-5']);
  assert.deepEqual(toolKeys(persisted), ['message-m1-tool-0', 'message-m1-tool-2']);
});

test('buildMessageParts 与 buildTraceItems 给工具行同一个展开标识', () => {
  const parts = buildMessageParts(LIVE_EVENTS, null, 'live', findRunId(LIVE_EVENTS));
  const items = buildTraceItems(LIVE_EVENTS, null, 'live', findRunId(LIVE_EVENTS));
  const idsFromParts = parts.filter((part) => part.item.callId).map((part) => part.item.callId);
  assert.deepEqual(idsFromParts, toolIds(items));
});

test('审批被拒导致序号错位时退化为收起，而不是展开另一个工具', () => {
  // 审批被拒：runtime 在 yield tool_call_start 之前就 continue，但 transcript 已经记录了这次调用。
  // 于是持久化比 live 多一条 start，该 run 内后续序号整体后移。
  const live = buildTraceItems([start('read_file'), result('read_file'), start('exec_command'), result('exec_command')], null, 'live', 'run-1');
  const persisted = buildTraceItems([
    start('read_file'), result('read_file'),
    start('write_file'), result('write_file'),
    start('exec_command'), result('exec_command'),
  ], null, 'message-m1', 'run-1');

  assert.equal(live[0].callId, persisted[0].callId, '错位点之前的工具仍保持展开');
  assert.equal(live[1].callId, 'run-1:tool:1:exec_command');
  assert.equal(persisted[2].callId, 'run-1:tool:2:exec_command');
  assert.notEqual(live[1].callId, persisted[2].callId, '错位的标识必须失配');
});

test('没有 runId 时退回位置 key（老数据仍可展开）', () => {
  const items = buildTraceItems([start('read_file')], null, 'message-m1', '');
  assert.equal(items[0].callId, 'message-m1-tool-0');
  assert.equal(traceExpansionId(items[0]), 'message-m1-tool-0');
});

test('孤立的结果事件也有稳定的展开标识', () => {
  const items = buildTraceItems([result('exec_command'), start('read_file'), result('read_file')], null, 'live', 'run-1');
  assert.deepEqual(items.map(traceExpansionId), ['run-1:toolResult:0:exec_command', 'run-1:tool:0:read_file']);
});

test('非工具行没有 callId，展开标识退回位置 key', () => {
  const items = buildTraceItems([{ type: 'workspace_artifact', artifact: { path: 'a.txt' } }], null, 'live', 'run-1');
  assert.equal(items[0].callId, undefined);
  assert.equal(traceExpansionId(items[0]), 'live-event-0');
});
