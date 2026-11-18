import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseName,
  buildEditDiff,
  classifyToolCard,
  dotStateFor,
  formatBytes,
  languageForPath,
  parseToolOutput,
  parseUnifiedDiff,
  summarizeValue,
  toolCardModel,
} from '../src/domain/tool_kind.js';

test('classifyToolCard maps every backend core tool', () => {
  const expected = {
    exec_command: 'terminal',
    shell_output: 'terminal',
    shell_kill: 'terminal',
    execute_python: 'code',
    read_file: 'file',
    write_file: 'file',
    edit_file: 'diff',
    apply_patch: 'diff',
    glob: 'search',
    grep: 'search',
    web_fetch: 'web',
    web_search: 'web',
    planning: 'plan',
    toollibrary: 'capability',
    toolload: 'capability',
    knowledgebase: 'capability',
  };
  for (const [name, card] of Object.entries(expected)) {
    assert.equal(classifyToolCard({ title: name }), card, `${name} 应映射到 ${card}`);
  }
});

test('classifyToolCard handles MCP names, kind fallbacks and unknowns', () => {
  assert.equal(classifyToolCard({ title: 'filesystem__read_file' }), 'generic');
  assert.equal(classifyToolCard({ title: 'anything', kind: 'plan' }), 'plan');
  assert.equal(classifyToolCard({ title: 'anything', kind: 'skill' }), 'capability');
  assert.equal(classifyToolCard({ title: 'anything', kind: 'mcp' }), 'capability');
  assert.equal(classifyToolCard({ title: 'anything', kind: 'knowledge' }), 'capability');
  assert.equal(classifyToolCard({ title: 'mystery_tool' }), 'generic');
  assert.equal(classifyToolCard({}), 'generic');
});

test('dotStateFor normalises the four statuses', () => {
  assert.equal(dotStateFor('running'), 'running');
  assert.equal(dotStateFor('completed'), 'done');
  assert.equal(dotStateFor('warning'), 'warning');
  assert.equal(dotStateFor('failed'), 'error');
  assert.equal(dotStateFor(undefined), 'idle');
});

test('parseToolOutput tolerates objects, JSON strings and plain text', () => {
  assert.deepEqual(parseToolOutput('{"ok":true}'), { ok: true });
  assert.deepEqual(parseToolOutput({ ok: true }), { ok: true });
  assert.equal(parseToolOutput('not json at all'), 'not json at all');
  assert.equal(parseToolOutput(''), null);
  assert.equal(parseToolOutput(null), null);
});

test('summarizeValue takes the first non-empty line and truncates', () => {
  assert.equal(summarizeValue('\n\n  hello   world \nsecond'), 'hello world');
  assert.equal(summarizeValue({ a: 1 }), '{"a":1}');
  assert.equal(summarizeValue(''), '');
  assert.equal(summarizeValue(null), '');
  const long = summarizeValue('x'.repeat(200), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});

test('path helpers read the basename and the highlight language', () => {
  assert.equal(baseName('/a/b/c.py'), 'c.py');
  assert.equal(baseName('c.py'), 'c.py');
  assert.equal(baseName(''), '');
  assert.equal(languageForPath('/a/b/c.py'), 'python');
  assert.equal(languageForPath('x.tsx'), 'typescript');
  assert.equal(languageForPath('Makefile'), '');
  assert.equal(languageForPath('a.unknown'), '');
});

test('formatBytes keeps small sizes exact and scales the rest', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(undefined), '');
});

test('buildEditDiff derives a real diff from edit_file arguments', () => {
  const diff = buildEditDiff({ old_string: 'a\nb\nc', new_string: 'a\nB\nc' });
  assert.deepEqual(diff.removed, [{ type: 'del', text: 'b' }]);
  assert.deepEqual(diff.added, [{ type: 'add', text: 'B' }]);
  assert.deepEqual(diff.context, [{ type: 'ctx', text: 'a' }, { type: 'ctx', text: 'c' }]);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
});

test('parseUnifiedDiff types each line of an apply_patch payload', () => {
  const lines = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n ctx');
  assert.deepEqual(lines.map((line) => line.type), ['meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
  assert.equal(lines[3].text, 'old');
  assert.equal(lines[4].text, 'new');
  assert.equal(lines[5].text, 'ctx');
});

test('toolCardModel renders an exec_command as a terminal card', () => {
  const model = toolCardModel({
    title: 'exec_command',
    status: 'completed',
    input: { command: 'ls' },
    output: JSON.stringify({ ok: true, cwd: '/tmp', command: 'ls -la', exit_code: 0, stdout: 'a.txt\nb.txt' }),
  });
  assert.equal(model.card, 'terminal');
  assert.equal(model.title, 'Terminal');
  assert.equal(model.subtitle, '/tmp');
  assert.equal(model.summary, 'a.txt');
  assert.equal(model.body.command, 'ls -la');
  assert.equal(model.body.exitCode, 0);
  assert.equal(model.dotState, 'done');
  assert.equal(model.language, 'bash');
});

test('toolCardModel surfaces a failed tool as an error with the backend message', () => {
  const model = toolCardModel({
    title: 'read_file',
    status: 'completed',
    input: { path: '/a/missing.txt' },
    output: JSON.stringify({ ok: false, error: { code: 'not_found', message: 'file does not exist' } }),
  });
  assert.equal(model.dotState, 'error');
  assert.equal(model.error, 'file does not exist');
});

test('toolCardModel keeps a running tool free of stale output', () => {
  const model = toolCardModel({ title: 'exec_command', status: 'running', input: { command: 'sleep 1' }, output: null });
  assert.equal(model.dotState, 'running');
  assert.equal(model.body.stdout, '');
  assert.equal(model.summary, '');
});

test('toolCardModel describes a read_file with its line range', () => {
  const model = toolCardModel({
    title: 'read_file',
    status: 'completed',
    input: { path: '/proj/src/main.py' },
    output: JSON.stringify({ ok: true, path: '/proj/src/main.py', content: 'print(1)', returned_lines: 1, total_lines: 10, size: 2048 }),
  });
  assert.equal(model.card, 'file');
  assert.equal(model.title, 'main.py');
  assert.equal(model.subtitle, '/proj/src/main.py');
  assert.equal(model.summary, '1/10 行 · 2.0 KB');
  assert.equal(model.language, 'python');
  assert.equal(model.body.action, 'read');
});

test('toolCardModel builds a diff card from edit_file arguments', () => {
  const model = toolCardModel({
    title: 'edit_file',
    status: 'completed',
    input: { path: '/proj/a.py', old_string: 'x = 1', new_string: 'x = 2' },
    output: JSON.stringify({ ok: true, path: '/proj/a.py', replacements: 1, size: 100 }),
  });
  assert.equal(model.card, 'diff');
  assert.equal(model.title, 'a.py');
  assert.equal(model.body.kind, 'edit');
  assert.equal(model.body.additions, 1);
  assert.equal(model.body.deletions, 1);
  assert.match(model.summary, /\+1 −1/);
});

test('toolCardModel builds a patch card from apply_patch arguments', () => {
  const model = toolCardModel({
    title: 'apply_patch',
    status: 'completed',
    input: { patch: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new' },
    output: JSON.stringify({ ok: true, cwd: '/proj', files: [{ path: '/proj/f', change: 'modified', hunks: 1 }], count: 1 }),
  });
  assert.equal(model.card, 'diff');
  assert.equal(model.body.kind, 'patch');
  assert.equal(model.title, 'f');
  assert.equal(model.summary, '1 个文件 · +1 −1');
  assert.equal(model.body.lines.length, 5);
});

test('toolCardModel renders grep and glob as search cards', () => {
  const grep = toolCardModel({
    title: 'grep',
    status: 'completed',
    input: { query: 'TODO' },
    output: JSON.stringify({ ok: true, path: '/proj', query: 'TODO', count: 1, matches: [{ path: 'a.py', line: 3, preview: 'TODO fix' }] }),
  });
  assert.equal(grep.card, 'search');
  assert.equal(grep.title, 'Search');
  assert.equal(grep.subtitle, 'TODO');
  assert.equal(grep.summary, '1 个结果');
  assert.equal(grep.body.mode, 'grep');

  const glob = toolCardModel({
    title: 'glob',
    status: 'completed',
    input: { pattern: '*.py' },
    output: JSON.stringify({ ok: true, path: '/proj', pattern: '*.py', count: 2, matches: ['a.py', 'b.py'] }),
  });
  assert.equal(glob.title, 'Files');
  assert.equal(glob.body.mode, 'glob');
  assert.equal(glob.summary, '2 个结果');
});

test('toolCardModel renders web_fetch with its title and status', () => {
  const model = toolCardModel({
    title: 'web_fetch',
    status: 'completed',
    input: { url: 'https://example.com' },
    output: JSON.stringify({ ok: true, url: 'https://example.com', status: 200, title: 'Example', content: '# hi', content_kind: 'markdown' }),
  });
  assert.equal(model.card, 'web');
  assert.equal(model.title, 'Example');
  assert.equal(model.subtitle, 'https://example.com');
  assert.equal(model.summary, '200 · markdown');
});

test('toolCardModel falls back to a JSON tree for unknown tools', () => {
  const model = toolCardModel({ title: 'mystery', status: 'completed', input: { a: 1 }, output: '{"b":2}' });
  assert.equal(model.card, 'generic');
  assert.deepEqual(model.body.input, { a: 1 });
  assert.deepEqual(model.body.output, { b: 2 });
});

test('toolCardModel survives a non-JSON tool result', () => {
  // 异常路径上后端可能直接回纯文本；卡片要把它当正文展示，而不是显示空白。
  const model = toolCardModel({ title: 'exec_command', status: 'completed', input: {}, output: 'plain text output' });
  assert.equal(model.card, 'terminal');
  assert.equal(model.summary, 'plain text output');
  assert.equal(model.body.stdout, 'plain text output');
  assert.equal(model.body.plainText, 'plain text output');
});
