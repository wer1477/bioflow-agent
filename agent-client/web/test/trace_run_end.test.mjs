import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessageParts, buildTraceItems } from '../src/domain/trace.js';

const start = (toolName) => ({ type: 'tool_call_start', tool_name: toolName, arguments: {} });
const cancelledEvent = { type: 'error', error: 'Run cancelled by user.' };

test('a tool the run never finished stops spinning once the run ends', () => {
  const parts = buildMessageParts([start('exec_command'), cancelledEvent], null, 'message-m1', 'run-1');
  const item = parts.find((part) => part.type === 'trace').item;
  assert.equal(item.status, 'cancelled', 'an interrupted tool is not still running');
  assert.equal(item.output, null);
});

test('the live projection entry point applies the same rule', () => {
  const items = buildTraceItems([start('exec_command'), { type: 'run_status', status: 'cancelled' }], null, 'live', 'run-1');
  assert.equal(items[0].status, 'cancelled');
});

test('a tool that is still executing keeps running until the run settles', () => {
  const parts = buildMessageParts([
    { type: 'run_status', status: 'tool_execution' },
    start('exec_command'),
  ], null, 'message-m1', 'run-1');
  assert.equal(parts.find((part) => part.type === 'trace').item.status, 'running');
});

test('results that did arrive stay completed, and only the tail is settled', () => {
  const parts = buildMessageParts([
    start('read_file'),
    { type: 'tool_call_result', tool_name: 'read_file', result: '{"ok":true}' },
    start('exec_command'),
    cancelledEvent,
  ], null, 'message-m1', 'run-1');
  // 只数工具行：error 事件本身也会投影成一行 runtime trace（状态 failed）。
  const statuses = parts.filter((part) => part.type === 'trace' && part.item.callId).map((part) => part.item.status);
  assert.deepEqual(statuses, ['completed', 'cancelled']);
});

test('a completed run without a terminal event leaves no tool marked interrupted', () => {
  const parts = buildMessageParts([
    start('read_file'),
    { type: 'tool_call_result', tool_name: 'read_file', result: '{"ok":true}' },
  ], null, 'message-m1', 'run-1');
  assert.equal(parts.find((part) => part.type === 'trace').item.status, 'completed');
});
