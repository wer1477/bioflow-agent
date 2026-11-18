import assert from 'node:assert/strict';
import test from 'node:test';
import { extractToolResultEvents, producedFilesOf } from '../src/agent/tool_result_events.js';

test('extractToolResultEvents derives artifact and planning events from one successful result', () => {
  const events = extractToolResultEvents(JSON.stringify({
    ok: true,
    file: { id: 'artifact-1', path: '/workspace/planning/plan.md', workspacePath: 'planning/plan.md', title: 'Plan', type: 'markdown' },
    uiEvent: { type: 'planning_panel', panel: 'plan', status: 'waiting', title: 'Plan', markdown: '# Plan', filePath: 'planning/plan.md' },
  }));

  assert.deepEqual(events, [
    { type: 'workspace_artifact', artifact: { id: 'artifact-1', title: 'Plan', path: 'planning/plan.md', type: 'markdown' } },
    { type: 'planning_panel', panel: 'plan', status: 'waiting', title: 'Plan', questions: undefined, markdown: '# Plan', filePath: 'planning/plan.md', todos: undefined, note: undefined },
  ]);
});

test('extractToolResultEvents ignores malformed and failed tool results', () => {
  assert.deepEqual(extractToolResultEvents('not JSON'), []);
  assert.deepEqual(extractToolResultEvents(JSON.stringify({ ok: false, file: { id: 'artifact-1', path: 'ignored.txt' } })), []);
});

test('producedFilesOf reads the single-file shape a generic tool returns', () => {
  assert.deepEqual(
    producedFilesOf(JSON.stringify({ ok: true, file: { id: 'a1', path: 'fallback.txt', workspacePath: 'Result/plot.png' } })),
    ['Result/plot.png'],
  );
  assert.deepEqual(producedFilesOf(JSON.stringify({ ok: true, file: { path: 'only-path.txt' } })), ['only-path.txt']);
});

test('producedFilesOf reads the kernel artifacts execute_python reports', () => {
  // Kernel figures never appear as a `file` field, so without this shape the most
  // important "where did this plot come from" case would be invisible.
  const result = JSON.stringify({
    ok: true,
    stdout: 'done',
    artifacts: [
      { id: 'f1', path: '.bioflow/kernel/run-1/cell-1/volcano.png', type: 'figure' },
      { id: 'f2', path: '.bioflow/kernel/run-1/cell-1/heatmap.png', type: 'figure' },
    ],
  });
  assert.deepEqual(producedFilesOf(result), [
    '.bioflow/kernel/run-1/cell-1/volcano.png',
    '.bioflow/kernel/run-1/cell-1/heatmap.png',
  ]);
});

test('producedFilesOf reports nothing it cannot read', () => {
  assert.deepEqual(producedFilesOf('not JSON'), []);
  assert.deepEqual(producedFilesOf(JSON.stringify({ ok: true })), []);
  assert.deepEqual(producedFilesOf(JSON.stringify({ ok: true, artifacts: [{ id: 'x' }, null, 'nope'] })), []);
  // A failed cell can still have written figures; the files are facts either way.
  assert.deepEqual(
    producedFilesOf(JSON.stringify({ ok: false, artifacts: [{ path: 'Result/partial.png' }] })),
    ['Result/partial.png'],
  );
});
