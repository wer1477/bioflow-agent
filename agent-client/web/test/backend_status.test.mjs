import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessageParts, buildTraceItems, isBackendStatusEvent } from '../src/domain/trace.js';

/** run 的第一条事件：后端 `formatRuntimeInfo` 拼出来的自检行。 */
const BANNER = { type: 'info', content: 'Agent: Main Agent; CoreTools: read_file; Skills: 3; MCP: tavily; Workspace: 2 artifacts; project /tmp/p' };
const start = (toolName) => ({ type: 'tool_call_start', tool_name: toolName, arguments: {} });

/** 两个投影入口的可见行：一个看 part 类型，一个看 trace item 标题。 */
const partsOf = (events) => buildMessageParts(events, null, 'message-m1', 'run-1');
const itemsOf = (events) => buildTraceItems(events, null, 'message-m1', 'run-1');

test('运行时 banner 不进对话流', () => {
  const events = [BANNER, { type: 'info', content: '先看目录\n' }, start('read_file')];
  assert.deepEqual(partsOf(events).map((part) => part.content ?? part.item.title), ['先看目录\n', 'read_file']);
  assert.deepEqual(itemsOf(events).map((item) => item.title), ['read_file']);
});

test('形状相近但不是 banner 的叙述照常显示', () => {
  // 只认后端拼出来的骨架（`Agent: ` 开头且含 `; CoreTools: `），不误伤模型自己说的话。
  const near = { type: 'info', content: 'Agent: 我先看一下 CoreTools 的配置' };
  assert.equal(isBackendStatusEvent(near), false);
  assert.equal(isBackendStatusEvent({ type: 'info', content: 'Agent: X; CoreTools: Y' }), true);
});

test('run_status 全部不显示：它本来就只存在于直播态', () => {
  // 终态的 run_status 在 persist('completed') 之后才 emit，也不在
  // TRANSCRIPT_MIRRORED_EVENT_TYPES 里——刷新之后它本来就会消失。
  const events = [
    { type: 'run_status', runId: 'r', status: 'building_context' },
    { type: 'run_status', runId: 'r', status: 'model_turn' },
    { type: 'run_status', runId: 'r', status: 'completed' },
  ];
  assert.deepEqual(partsOf(events), []);
  assert.deepEqual(itemsOf(events), []);
});

test('MCP 连接全成功时不显示，有连接失败时留下', () => {
  const ok = { type: 'mcp_status', connected: [{ name: 'tavily' }], failed: [] };
  const bad = { type: 'mcp_status', connected: [], failed: [{ name: 'tavily', error: 'timeout' }] };

  assert.deepEqual(partsOf([ok]), []);
  // 有 server 连不上意味着工具缺失，那是解释"它为什么不用那个工具"的唯一线索。
  assert.deepEqual(itemsOf([bad]).map((item) => item.title), ['MCP connection status']);
  assert.equal(itemsOf([bad])[0].status, 'warning');
});

test('遥测类 loop_health 不显示', () => {
  const telemetry = ['context_watermark_checked', 'token_usage_observed', 'context_watermark_exceeded'];
  for (const reason of telemetry) {
    assert.deepEqual(partsOf([{ type: 'loop_health', reason }]), [], `reason=${reason}`);
  }
});

test('异常与降级类 loop_health 一律留下', () => {
  // 历史真被改写（模型会忘事）、响应被截断、工具反复失败、硬水位线守卫、checkpoint。
  const kept = [
    'context_compaction_started', 'context_compaction_completed', 'context_compaction_failed',
    'context_compaction_degraded', 'model_response_truncated', 'repeated_tool_failure',
    'context_hard_watermark_guard', 'checkpoint', 'repeated_tool_failure_limit',
  ];
  for (const reason of kept) {
    assert.deepEqual(
      itemsOf([{ type: 'loop_health', reason }]).map((item) => item.title),
      [`Context: ${reason}`],
      `reason=${reason}`,
    );
  }
});

test('没登记过的 loop_health reason 默认可见', () => {
  // 白名单语义：将来新增的降级信号宁可多显示一条，也不能因为没被登记而静默消失。
  assert.equal(isBackendStatusEvent({ type: 'loop_health', reason: 'something_new' }), false);
  assert.deepEqual(itemsOf([{ type: 'loop_health', reason: 'something_new' }]).map((item) => item.title), ['Context: something_new']);
});

test('产物与错误照常显示', () => {
  const artifact = { type: 'workspace_artifact', artifact: { title: '结果表', path: 'out.csv' } };
  const error = { type: 'error', error: 'boom' };
  assert.deepEqual(itemsOf([artifact]).map((item) => item.title), ['Artifact: 结果表']);
  assert.deepEqual(itemsOf([error]).map((item) => item.title), ['Runtime error']);
});

test('两个投影入口对同一事件流的取舍完全一致', () => {
  // 直播走 buildTraceItems、历史走 buildMessageParts；分叉会让刷新前后行数不一样。
  const events = [
    BANNER,
    { type: 'run_status', status: 'model_turn' },
    { type: 'mcp_status', connected: [], failed: [] },
    { type: 'loop_health', reason: 'context_watermark_checked' },
    start('read_file'),
    { type: 'loop_health', reason: 'model_response_truncated' },
    { type: 'workspace_artifact', artifact: { title: '结果表' } },
  ];
  const expected = ['read_file', 'Context: model_response_truncated', 'Artifact: 结果表'];
  assert.deepEqual(itemsOf(events).map((item) => item.title), expected);
  // parts 侧只看 trace 行（`info` 在这里是 text part，不参与对比）。
  assert.deepEqual(
    partsOf(events).filter((part) => part.type === 'trace').map((part) => part.item.title),
    expected,
  );
});
