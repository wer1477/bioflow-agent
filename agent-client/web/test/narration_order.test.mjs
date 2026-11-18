import assert from 'node:assert/strict';
import test from 'node:test';
import { appendLiveNarration, appendLiveThinking, buildMessageParts, findUnrenderedNarration } from '../src/domain/trace.js';

const start = (toolName) => ({ type: 'tool_call_start', tool_name: toolName, arguments: {} });
const result = (toolName) => ({ type: 'tool_call_result', tool_name: toolName, result: '{}' });

/**
 * 一个 run 重建后的事件流：`info` 行既有 run 上下文 banner，也有从 `model_response`
 * 投影出来的叙事。区别在于 banner 不属于 `message.content`。
 */
const BANNER = { type: 'info', content: 'Agent: Main Agent; CoreTools: read_file; Skills: 3; MCP: tavily; Workspace: 2 artifacts; project /tmp/p' };
const PROJECTED = [
  BANNER,
  { type: 'info', content: '先看目录\n' },
  start('read_file'),
  result('read_file'),
  { type: 'info', content: '再看文件\n' },
  start('exec_command'),
  result('exec_command'),
  { type: 'info', content: '完成。' },
];
const CONTENT = '先看目录\n再看文件\n完成。';

const textParts = (parts) => parts.filter((part) => part.type === 'text').map((part) => part.content);
/** T=文字块，C=工具行。`tool_call_result` 只回填已有行，不新增 part。 */
const shape = (parts) => parts.map((part) => (part.type === 'text' ? 'T' : 'C')).join('');

test('文字与工具行按投影顺序交错，而不是全部堆到末尾', () => {
  const parts = buildMessageParts(PROJECTED, null, 'message-m1', 'run-1');
  // banner 已在投影层被摘掉（见 domain/trace.js 的 isBackendStatusEvent），
  // 所以开头的 T 就是第一段真正的叙述。
  assert.equal(shape(parts), 'TCTCT');
  assert.deepEqual(textParts(parts), ['先看目录\n', '再看文件\n', '完成。']);
});

test('投影完整的 run 没有需要追加到末尾的剩余文字', () => {
  // 回归守卫：过去重建后的事件流里一个文字事件都没有，于是整段 content
  // 被当作「未渲染的叙事」追加在所有工具行之后。
  const parts = buildMessageParts(PROJECTED, null, 'message-m1', 'run-1');
  assert.equal(findUnrenderedNarration(CONTENT, parts), '');
});

test('run 上下文 banner 不属于 content，不会被当成剩余文字', () => {
  const parts = buildMessageParts(PROJECTED, null, 'message-m1', 'run-1');
  assert.ok(!CONTENT.includes(BANNER.content), '前提：banner 不是 content 的子串');
  assert.equal(findUnrenderedNarration(CONTENT, parts), '', 'banner 不应污染剩余文字');
});

test('回合中途被杀时，投影未覆盖的尾部仍会渲染而不是丢失', () => {
  // 崩溃发生在回合结束前：content 已按 250ms 防抖落盘，但该回合还没有 model_response。
  const crashed = '先看目录\n再看文件\n半句话没写完';
  const parts = buildMessageParts(PROJECTED.slice(0, 7), null, 'message-m1', 'run-1');
  assert.equal(shape(parts), 'TCTC');
  assert.equal(findUnrenderedNarration(crashed, parts), '半句话没写完');
});

test('纯空白回合不产生文字块', () => {
  // 只调用工具的回合常常只产出 '\n\n'；投影侧不为它产出 info，因此没有可渲染文字。
  const parts = buildMessageParts([BANNER, start('read_file'), result('read_file')], null, 'message-m1', 'run-1');
  assert.equal(shape(parts), 'C');
  assert.equal(findUnrenderedNarration('\n\n', parts), '');
});

test('思维链是独立 part：按位置渲染，且不参与剩余文字相减', () => {
  const events = [
    BANNER,
    { type: 'thinking', content: '先想一下目录结构' },
    { type: 'info', content: '先看目录\n' },
    start('read_file'),
    result('read_file'),
    { type: 'thinking', content: '再想一下' },
    { type: 'info', content: '完成。' },
  ];
  const parts = buildMessageParts(events, null, 'message-m1', 'run-1');
  assert.deepEqual(parts.map((part) => part.type), ['thinking', 'text', 'trace', 'thinking', 'text']);
  // 思维链不属于 message.content；若它参与了相减，这里会算出错误的"未覆盖尾部"。
  assert.equal(findUnrenderedNarration('先看目录\n完成。', parts), '');
});

test('思维链为空或缺失时不产生 part', () => {
  const parts = buildMessageParts([
    BANNER,
    { type: 'thinking', content: '' },
    { type: 'thinking' },
    start('read_file'),
  ], null, 'message-m1', 'run-1');
  assert.deepEqual(parts.map((part) => part.type), ['trace']);
});

test('直播思维链 delta 连续合并，遇到别的类型就断开', () => {
  let events = [];
  events = appendLiveThinking(events, 'a');
  events = appendLiveThinking(events, 'b');
  events = appendLiveNarration(events, 'text');
  events = appendLiveThinking(events, 'c');
  assert.deepEqual(events.map((event) => [event.type, event.content]), [
    ['thinking', 'ab'],
    ['info', 'text'],
    ['thinking', 'c'],
  ]);
  assert.deepEqual(appendLiveThinking(events, ''), events, '空 delta 不应改变事件流');
});
