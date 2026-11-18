import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countSteps, formatElapsed, formatRunDuration, isAccountedNarration, isCompletedRun,
  latestCompletedIndex, resolveTurnProcessOpen, runStatusLabel, splitTurnProcess, turnProcessLabel,
} from '../src/domain/turn_process.js';
import { buildMessageParts } from '../src/domain/trace.js';

const start = (toolName) => ({ type: 'tool_call_start', tool_name: toolName, arguments: {} });
const result = (toolName) => ({ type: 'tool_call_result', tool_name: toolName, result: '{}' });
const info = (content) => ({ type: 'info', content });

/** run 的第一条事件：运行时 banner，只存在于事件流，不在 message.content 里。 */
const BANNER = info('Agent: Main Agent; CoreTools: read_file; Skills: 3; MCP: tavily; Workspace: 2 artifacts; project /tmp/p');
const CONTENT = '先看目录\n再看文件\n完成。';

const textParts = (parts) => parts.filter((part) => part.type === 'text').map((part) => part.content);
const kinds = (parts) => parts.map((part) => part.type).join(',');

const FULL_RUN = [
  BANNER,
  info('先看目录\n'),
  start('read_file'),
  result('read_file'),
  info('再看文件\n'),
  start('exec_command'),
  result('exec_command'),
  info('完成。'),
];

test('工具行之后的叙述归结果，其余归过程', () => {
  const parts = buildMessageParts(FULL_RUN, null, 'message-m1', 'run-1');
  const split = splitTurnProcess(parts, CONTENT);

  assert.equal(split.foldable, true);
  assert.deepEqual(textParts(split.result), ['完成。']);
  // 结果区按定义不含工具行，否则"折起来的过程"会反向漏出一排工具行。
  assert.equal(split.result.some((part) => part.type === 'trace'), false);
  assert.equal(split.process.at(-1).type, 'trace');
  assert.deepEqual(textParts(split.process), ['先看目录\n', '再看文件\n']);
});

test('运行时 banner 不会进 parts，也不会被当成结果', () => {
  // 结尾是工具行：没有尾随叙述，唯一"看起来像叙述"的文本是开头那条 banner。
  const parts = buildMessageParts([
    BANNER, info('先看目录\n'), start('read_file'), result('read_file'),
  ], null, 'message-m1', 'run-1');
  const split = splitTurnProcess(parts, CONTENT);

  assert.equal(split.foldable, false);
  assert.deepEqual(split.result, parts, '不可折时原样返回全部 parts');
  // banner 在投影层就被摘掉（见 domain/trace.js 的 isBackendStatusEvent），根本走不到分区。
  assert.deepEqual(textParts(parts), ['先看目录\n']);
  // 判据本身仍然在：正文里找不到的文本不算"结果"。
  assert.equal(isAccountedNarration(CONTENT, { type: 'text', content: BANNER.content }), false);
  assert.equal(isAccountedNarration(CONTENT, { type: 'text', content: '完成。' }), true);
});

test('没有工具行的纯问答不折叠', () => {
  const parts = buildMessageParts([BANNER, info('先看目录\n再看文件\n完成。')], null, 'message-m1', 'run-1');
  const split = splitTurnProcess(parts, CONTENT);
  assert.equal(split.foldable, false);
  assert.equal(split.process.length, 0);
});

test('工具行之后没有任何叙述时不折叠，而不是退化成"最后一段叙述"', () => {
  // 退化会把尾部工具行划进结果区，折叠行之下的"结果"变成一排工具行，比不折更糟。
  const parts = buildMessageParts([
    info('先看目录\n'), start('read_file'), result('read_file'), start('exec_command'), result('exec_command'),
  ], null, 'message-m1', 'run-1');
  assert.equal(splitTurnProcess(parts, CONTENT).foldable, false);
});

test('要人操作的面板整轮收起时仍然可见', () => {
  const parts = [
    { type: 'text', key: 'p0', content: '先看目录\n' },
    { type: 'planning', key: 'p1', panel: { type: 'planning_panel' } },
    { type: 'trace', key: 'p2', item: { callId: 'run-1:tool:0:read_file', kind: 'file' } },
    { type: 'security_approval', key: 'p3', request: { approvalId: 'a1' } },
    { type: 'trace', key: 'p4', item: { callId: 'run-1:tool:1:exec_command', kind: 'terminal' } },
    { type: 'text', key: 'p5', content: '完成。' },
  ];
  const split = splitTurnProcess(parts, '先看目录\n完成。');

  assert.equal(split.foldable, true);
  assert.deepEqual(split.pinned.map((part) => part.key), ['p1', 'p3']);
  assert.deepEqual(split.result.map((part) => part.key), ['p5']);
  // 折叠态 = pinned + result，展开态 = 全部 parts；两者都不丢内容。
  const folded = [...split.pinned, ...split.result].map((part) => part.key);
  assert.deepEqual(folded, ['p1', 'p3', 'p5']);
  assert.equal(new Set([...split.process, ...split.result]).size, parts.length);
});

test('步数只数带 callId 的 trace 行', () => {
  const parts = buildMessageParts([
    BANNER,
    info('先看目录\n'),
    start('read_file'), result('read_file'),
    info('再看文件\n'),
    start('exec_command'), result('exec_command'),
    info('完成。'),
    { type: 'workspace_artifact', artifact: { path: 'a.txt' } },
    { type: 'mcp_status', connected: [], failed: [] },
  ], null, 'message-m1', 'run-1');
  // 计划 / MCP 状态 / artifact / runtime 行都没有 callId，数进来只会让步数虚高。
  assert.equal(countSteps(parts), 2);
  assert.equal(countSteps([]), 0);
  assert.equal(countSteps(undefined), 0);
});

test('时长格式覆盖秒、分、时与非法输入', () => {
  assert.equal(formatElapsed(0), '1s', '不足 1 秒按 1 秒算，不显示 0s');
  assert.equal(formatElapsed(999), '1s');
  assert.equal(formatElapsed(1200), '1s');
  assert.equal(formatElapsed(83000), '1m 23s');
  assert.equal(formatElapsed(60000), '1m');
  assert.equal(formatElapsed(3_723_000), '1h 2m');
  assert.equal(formatElapsed(3_600_000), '1h');

  assert.equal(formatRunDuration('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:23.000Z'), '1m 23s');
  // 历史消息可能缺字段：降级为空串，折叠行只显示"已完成"。
  assert.equal(formatRunDuration('', '2026-01-01T00:00:00.000Z'), '');
  assert.equal(formatRunDuration('2026-01-01T00:00:00.000Z', undefined), '');
  assert.equal(formatRunDuration('junk', 'junk'), '');
});

test('折叠行文案按时长与步数省略', () => {
  const base = { startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:23.000Z', steps: 12 };
  assert.equal(turnProcessLabel(base), '已完成 · 用时 1m 23s · 12 步');
  assert.equal(turnProcessLabel({ ...base, startedAt: '' }), '已完成 · 12 步');
  assert.equal(turnProcessLabel({ ...base, steps: 0 }), '已完成 · 用时 1m 23s');
  assert.equal(turnProcessLabel({}), '已完成');
});

test('运行状态文案把用户中断与真失败分开', () => {
  const at = '2026-01-01T00:00:00.000Z';
  // 后端 persist 的真实形状：取消写 error + interruptedAt，失败只写 error。
  assert.equal(runStatusLabel({ status: 'error', error: 'Run cancelled by user.', interruptedAt: at }), '已停止');
  assert.equal(runStatusLabel({ status: 'error', error: 'Connection error: socket hang up' }), '处理失败 · Connection error: socket hang up');

  assert.equal(runStatusLabel({ status: 'completed' }), '已完成');
  assert.equal(runStatusLabel({ status: 'error', interruptedAt: at }), '已停止');
  assert.equal(runStatusLabel({ status: 'error', error: 'connection_error' }), '处理失败 · connection_error');
  assert.equal(runStatusLabel({ status: 'error' }), '处理失败');
  assert.equal(runStatusLabel({ status: 'running' }), '运行中');
  // 事件流里已经有 cancelled；落库一旦改成直接写它，不能把它当成"还在跑"。
  assert.equal(runStatusLabel({ status: 'cancelled' }), '已停止');
  assert.equal(runStatusLabel(null), '');
  // 长错误信息压成一行并截断，不把状态行撑成一段话。
  const longLabel = runStatusLabel({ status: 'error', error: `boom\n${'x'.repeat(120)}` });
  assert.equal(longLabel.startsWith('处理失败 · boom '), true);
  assert.equal(longLabel.endsWith('…'), true);
});

test('开合解析：不可折 / 手动记录 / 两档时机', () => {
  const base = { foldable: true, completed: true };

  // 不可折（无结果 / 未完成）永远展开。
  assert.equal(resolveTurnProcessOpen({ ...base, foldable: false, isLatest: false }), true);
  assert.equal(resolveTurnProcessOpen({ ...base, completed: false, isLatest: false }), true);

  // 手动记录优先于时机。
  assert.equal(resolveTurnProcessOpen({ ...base, timing: 'nextInput', isLatest: false, override: true }), true);
  assert.equal(resolveTurnProcessOpen({ ...base, timing: 'completion', isLatest: true, override: false }), false);

  // 回答结束后：一结束就收，最新与否无关。
  assert.equal(resolveTurnProcessOpen({ ...base, timing: 'completion', isLatest: true }), false);

  // 下次有新消息时：最新一个成功轮次保持展开。
  assert.equal(resolveTurnProcessOpen({ ...base, timing: 'nextInput', isLatest: true }), true);
  assert.equal(resolveTurnProcessOpen({ ...base, timing: 'nextInput', isLatest: false }), false);
  // 缺省时机按「回答结束后」处理：跑完就收，最新与否无关。
  assert.equal(resolveTurnProcessOpen({ ...base, isLatest: true }), false);
  assert.equal(resolveTurnProcessOpen({ ...base, isLatest: false }), false);
});

test('分区不丢 part：过程与结果合起来覆盖全部，且各自保序', () => {
  const parts = buildMessageParts(FULL_RUN, null, 'message-m1', 'run-1');
  const split = splitTurnProcess(parts, CONTENT);
  // 每条 part 恰好出现一次。
  const keys = [...split.process, ...split.result].map((part) => part.key);
  assert.equal(keys.length, parts.length);
  assert.deepEqual(keys.slice().sort(), parts.map((part) => part.key).sort());
  // 有结果区的内容时，整体顺序就是原顺序（分区只做切分，不做重排）。
  assert.equal(kinds(split.process) + ',' + kinds(split.result), kinds(parts));
  assert.deepEqual([...split.process, ...split.result], parts);
});

test('plan-only run：计划行归过程，正文归结果，banner 不出现', () => {
  // 计划行在 index 0，是这一轮唯一的 trace 行；banner 在投影层就被摘掉，
  // 所以过程区只剩计划行，答案上方不会露出一行 `Agent: …; CoreTools: …`。
  const parts = buildMessageParts(
    [BANNER, info('完成。')],
    { title: 'Execution plan', steps: ['读目录', '读文件'] },
    'message-m1',
    'run-1',
  );
  const split = splitTurnProcess(parts, '完成。');

  assert.equal(split.foldable, true);
  assert.deepEqual(textParts(split.result), ['完成。']);
  assert.deepEqual(textParts(split.process), []);
  assert.deepEqual(split.process.map((part) => part.type), ['trace']);
});

test('尾随的思维链留在过程里，不跟着答案进结果区', () => {
  // run 的典型尾部：tool_call_result → thinking → 最终答案。思维链排在最后一个工具行
  // 之后，按"最后一个 trace 行"划界会把它划进结果区——收起一轮之后答案上方就露出一行
  // 可以点开的「思考」，正好和"折起来只留结果"相反。
  const parts = buildMessageParts([
    info('先看目录\n'),
    start('read_file'), result('read_file'),
    { type: 'thinking', content: '想一下再答' },
    info('完成。'),
  ], null, 'message-m1', 'run-1');
  const split = splitTurnProcess(parts, CONTENT);

  assert.equal(split.foldable, true);
  assert.deepEqual(textParts(split.result), ['完成。']);
  assert.deepEqual(split.result.map((part) => part.type), ['text']);
  assert.equal(split.process.at(-1).type, 'thinking');
});

test('结果区只含被正文承认的文字块', () => {
  // 计划面板排在最后一个工具行之后也不许漏进结果区：它属于过程（且会被 pin 住）。
  const parts = buildMessageParts([
    info('先看目录\n'), start('read_file'), result('read_file'),
    { type: 'planning_panel', panel: { type: 'planning_panel' } },
    info('完成。'),
  ], null, 'message-m1', 'run-1');
  const split = splitTurnProcess(parts, CONTENT);

  assert.equal(split.foldable, true);
  assert.deepEqual(split.result.map((part) => part.type), ['text']);
  assert.deepEqual(split.pinned.map((part) => part.type), ['planning']);
});

test('只有思维链的过程也折叠：过程不必含工具行', () => {
  // 纯问答轮次的过程就是那段推理。若把它判成"不可折"，思维链与 System context 会
  // 永远摊在答案上方——恰恰是"过程简化"要消掉的东西。
  const parts = buildMessageParts([
    BANNER, { type: 'thinking', content: '想一下再答' }, info('完成。'),
  ], null, 'message-m1', 'run-1');
  const split = splitTurnProcess(parts, '完成。');

  assert.equal(split.foldable, true);
  assert.deepEqual(split.process.map((part) => part.type), ['thinking']);
  assert.deepEqual(textParts(split.result), ['完成。']);
  // 没有工具行 → 步数为零，折叠行只写"已完成 · 用时 …"。
  assert.equal(countSteps(split.process), 0);
});

test('isCompletedRun 要求 completed 且带 completedAt', () => {
  assert.equal(isCompletedRun({ status: 'completed', completedAt: '2026-01-01T00:00:00.000Z' }), true);
  // 缺 completedAt 说明记录不完整，不能当作"成功结束"去折叠。
  assert.equal(isCompletedRun({ status: 'completed' }), false);
  assert.equal(isCompletedRun({ status: 'error', completedAt: '2026-01-01T00:00:00.000Z' }), false);
  assert.equal(isCompletedRun({ status: 'running' }), false);
  assert.equal(isCompletedRun(undefined), false);
});

test('latestCompletedIndex 只认「最后一条恰好是刚完成的回答」', () => {
  const answer = (id, run) => ({ id, role: 'assistant', toolCalls: run ? { run } : null });
  const ask = (id) => ({ id, role: 'user', toolCalls: null });
  const done = { status: 'completed', completedAt: '2026-01-01T00:00:00.000Z' };

  // 最后一条是刚完成的回答 → 保持展开。
  assert.equal(latestCompletedIndex([ask('u1'), answer('a1', done)]), 1);
  // 用户已经发出下一条消息 → 上一轮让位。
  assert.equal(latestCompletedIndex([ask('u1'), answer('a1', done), ask('u2')]), -1);
  // 失败/中断的轮次不会顶替上一轮，也不会自己成为"最新成功"。
  assert.equal(latestCompletedIndex([ask('u1'), answer('a1', { status: 'error' })]), -1);
  assert.equal(latestCompletedIndex([ask('u1'), answer('a1', { status: 'completed' })]), -1);
  // 已经排队的消息算作用户"已发出"：避免 run 被占用回退时上一轮先收起再弹开。
  assert.equal(latestCompletedIndex([ask('u1'), answer('a1', done)], { pendingInput: true }), -1);
  assert.equal(latestCompletedIndex([]), -1);
  assert.equal(latestCompletedIndex(undefined), -1);
});

