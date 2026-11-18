import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GrepEventCollector,
  buildGrepArguments,
  executeGrep,
  parseGrepOptions,
  type GrepMatchRecord,
} from '../src/agent/core_tools/search_executor.js';

/** Integration tests need a real ripgrep; this machine's dev box has none, so they self-skip. */
function resolveRipgrepPath(): string | null {
  const explicit = process.env.RG_PATH?.trim();
  for (const candidate of explicit ? [explicit] : ['rg']) {
    try {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      if (!probe.error && probe.status === 0) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const ripgrepPath = resolveRipgrepPath();
const ripgrepSkip = ripgrepPath
  ? false
  : 'ripgrep is not installed (set RG_PATH or install rg); only pure grep tests run';

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bioflow-grep-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rgEvent(type: 'match' | 'context', file: string, line: number, text: string): Record<string, unknown> {
  return { type, data: { path: { text: file }, lines: { text: `${text}\n` }, line_number: line } };
}

function rgBoundary(type: 'begin' | 'end', file: string): Record<string, unknown> {
  return { type, data: { path: { text: file } } };
}

test('parseGrepOptions applies defaults for a bare query', () => {
  const options = parseGrepOptions({ query: 'needle' });

  assert.equal(options.query, 'needle');
  assert.equal(options.outputMode, 'content');
  assert.equal(options.context, 0);
  assert.equal(options.headLimit, 100);
  assert.equal(options.offset, 0);
  assert.equal(options.regex, false);
  assert.equal(options.caseSensitive, false);
  assert.equal(options.include, undefined);
  assert.equal(options.exclude, undefined);
  assert.equal(options.type, undefined);
});

test('parseGrepOptions keeps max_results as a deprecated head_limit alias', () => {
  assert.equal(parseGrepOptions({ query: 'x', max_results: 7 }).headLimit, 7);
  assert.equal(parseGrepOptions({ query: 'x', max_results: 7, head_limit: 3 }).headLimit, 3);
  assert.equal(parseGrepOptions({ query: 'x', max_results: 100, head_limit: null }).headLimit, 100);
});

test('parseGrepOptions clamps context, head_limit and offset', () => {
  assert.equal(parseGrepOptions({ query: 'x', context: 99 }).context, 10);
  assert.equal(parseGrepOptions({ query: 'x', context: -1 }).context, 0);
  assert.equal(parseGrepOptions({ query: 'x', context: 2.9 }).context, 2);
  assert.equal(parseGrepOptions({ query: 'x', head_limit: 0 }).headLimit, 1);
  assert.equal(parseGrepOptions({ query: 'x', head_limit: 99_999 }).headLimit, 2_000);
  assert.equal(parseGrepOptions({ query: 'x', offset: -5 }).offset, 0);
  assert.equal(parseGrepOptions({ query: 'x', offset: 12.9 }).offset, 12);
});

test('parseGrepOptions normalizes output_mode and drops context outside content mode', () => {
  assert.equal(parseGrepOptions({ query: 'x', output_mode: 'files' }).outputMode, 'files');
  assert.equal(parseGrepOptions({ query: 'x', output_mode: 'count' }).outputMode, 'count');
  assert.equal(parseGrepOptions({ query: 'x', output_mode: 'FILES' }).outputMode, 'files');
  assert.equal(parseGrepOptions({ query: 'x', output_mode: 'bogus' }).outputMode, 'content');
  assert.equal(parseGrepOptions({ query: 'x', output_mode: 'count', context: 5 }).context, 0);
});

test('parseGrepOptions validates the ripgrep type filter and string arrays', () => {
  assert.equal(parseGrepOptions({ query: 'x', type: ' py ' }).type, 'py');
  assert.equal(parseGrepOptions({ query: 'x', type: '' }).type, undefined);
  assert.equal(parseGrepOptions({ query: 'x', type: 'py; rm -rf /' }).type, undefined);
  assert.deepEqual(parseGrepOptions({ query: 'x', include: ['**/*.ts', 42] }).include, ['**/*.ts', '42']);
});

test('buildGrepArguments builds the default content command', () => {
  const args = buildGrepArguments(parseGrepOptions({ query: '-1' }), '.');

  assert.deepEqual(args.slice(0, 4), ['--json', '--line-number', '--hidden', '--no-messages']);
  assert.ok(args.includes('--ignore-case'));
  assert.ok(args.includes('--fixed-strings'));
  assert.ok(args.includes('--glob'));
  assert.ok(args.includes('!.git/**'));
  assert.ok(args.includes('!node_modules/**'));
  assert.ok(args.includes('--'));
  assert.deepEqual(args.slice(-2), ['-1', '.']);
  assert.ok(!args.includes('--context'));
});

test('buildGrepArguments adds context, type and globs and drops literal-matching flags', () => {
  const args = buildGrepArguments(parseGrepOptions({
    query: 'pattern',
    regex: true,
    case_sensitive: true,
    context: 2,
    type: 'py',
    include: ['*.py'],
    exclude: ['build/**'],
  }), 'src');

  assert.ok(!args.includes('--ignore-case'));
  assert.ok(!args.includes('--fixed-strings'));
  assert.deepEqual(args.slice(args.indexOf('--context'), args.indexOf('--context') + 2), ['--context', '2']);
  assert.deepEqual(args.slice(args.indexOf('--type'), args.indexOf('--type') + 2), ['--type', 'py']);
  assert.ok(args.includes('*.py'));
  assert.ok(args.includes('!build/**'));
  assert.deepEqual(args.slice(-2), ['pattern', 'src']);
});

test('buildGrepArguments only adds context in content mode', () => {
  assert.ok(!buildGrepArguments(parseGrepOptions({ query: 'x', output_mode: 'files', context: 3 }), '.').includes('--context'));
  assert.ok(!buildGrepArguments(parseGrepOptions({ query: 'x', output_mode: 'count', context: 3 }), '.').includes('--context'));
});

test('GrepEventCollector associates before/after context lines with a content match', () => {
  const collector = new GrepEventCollector({ outputMode: 'content', context: 1, headLimit: 10, offset: 0 });
  collector.push(rgBoundary('begin', 'src/a.ts'));
  collector.push(rgEvent('context', 'src/a.ts', 1, 'const before = 1;'));
  collector.push(rgEvent('match', 'src/a.ts', 2, 'const needle = 2;'));
  collector.push(rgEvent('context', 'src/a.ts', 3, 'const after = 3;'));
  collector.push(rgBoundary('end', 'src/a.ts'));

  const result = collector.result();
  assert.equal(result.output_mode, 'content');
  assert.equal(result.count, 1);
  assert.equal(result.total_matches, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.next_offset, 1);
  assert.deepEqual(result.matches, [{
    path: 'src/a.ts',
    line: 2,
    preview: 'const needle = 2;',
    context: {
      before: [{ line: 1, preview: 'const before = 1;' }],
      after: [{ line: 3, preview: 'const after = 3;' }],
    },
  }]);
});

test('GrepEventCollector pages content matches by offset/head_limit and stops after one extra', () => {
  const collector = new GrepEventCollector({ outputMode: 'content', context: 0, headLimit: 1, offset: 1 });
  collector.push(rgBoundary('begin', 'a.txt'));
  collector.push(rgEvent('match', 'a.txt', 1, 'needle one'));
  collector.push(rgEvent('match', 'a.txt', 2, 'needle two'));
  assert.equal(collector.shouldStop(), false);
  collector.push(rgEvent('match', 'a.txt', 3, 'needle three'));
  assert.equal(collector.shouldStop(), true);
  // Further events must not grow memory after the child was asked to stop.
  collector.push(rgEvent('match', 'a.txt', 4, 'needle four'));

  const result = collector.result();
  assert.deepEqual(result.matches, [{ path: 'a.txt', line: 2, preview: 'needle two' }]);
  assert.equal(result.count, 1);
  assert.equal(result.total_matches, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.next_offset, 2);
});

test('GrepEventCollector returns unique files and pages them by path', () => {
  const collector = new GrepEventCollector({ outputMode: 'files', context: 0, headLimit: 2, offset: 0 });
  for (const file of ['a.txt', 'a.txt', 'b.txt', 'c.txt']) {
    collector.push(rgBoundary('begin', file));
    collector.push(rgEvent('match', file, 1, 'needle'));
    collector.push(rgBoundary('end', file));
  }

  const result = collector.result();
  assert.equal(result.output_mode, 'files');
  assert.deepEqual(result.files, ['a.txt', 'b.txt']);
  assert.equal(result.count, 2);
  assert.equal(result.total_matches, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.next_offset, 2);

  const paged = new GrepEventCollector({ outputMode: 'files', context: 0, headLimit: 1, offset: 1 });
  for (const file of ['a.txt', 'b.txt', 'c.txt']) paged.push(rgEvent('match', file, 1, 'needle'));
  const pagedResult = paged.result();
  assert.deepEqual(pagedResult.files, ['b.txt']);
  assert.equal(pagedResult.truncated, true);
  assert.equal(pagedResult.next_offset, 2);
});

test('GrepEventCollector aggregates per-file counts without truncating the total', () => {
  const collector = new GrepEventCollector({ outputMode: 'count', context: 0, headLimit: 10, offset: 0 });
  for (const [file, line] of [['a.txt', 1], ['a.txt', 2], ['b.txt', 1]] as const) {
    collector.push(rgEvent('match', file, line, 'needle'));
  }

  const result = collector.result();
  assert.equal(result.output_mode, 'count');
  assert.deepEqual(result.counts, [{ path: 'a.txt', count: 2 }, { path: 'b.txt', count: 1 }]);
  assert.equal(result.count, 2);
  assert.equal(result.total_matches, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.next_offset, 2);

  const paged = new GrepEventCollector({ outputMode: 'count', context: 0, headLimit: 1, offset: 0 });
  for (const [file, line] of [['a.txt', 1], ['a.txt', 2], ['b.txt', 1]] as const) {
    paged.push(rgEvent('match', file, line, 'needle'));
  }
  const pagedResult = paged.result();
  assert.deepEqual(pagedResult.counts, [{ path: 'a.txt', count: 2 }]);
  assert.equal(pagedResult.total_matches, 3);
  assert.equal(pagedResult.truncated, true);
});

test('GrepEventCollector stops at the 200k event cap and flags truncation', () => {
  const collector = new GrepEventCollector({ outputMode: 'count', context: 0, headLimit: 10, offset: 0 });
  for (let index = 0; index < 200_001; index += 1) {
    collector.push(rgEvent('match', 'big.txt', index + 1, 'needle'));
  }

  const result = collector.result();
  assert.equal(collector.shouldStop(), true);
  assert.equal(result.truncated, true);
  assert.equal(result.total_matches, 200_000);
});

test('GrepEventCollector truncates long previews to 2000 characters', () => {
  const collector = new GrepEventCollector({ outputMode: 'content', context: 0, headLimit: 10, offset: 0 });
  collector.push(rgEvent('match', 'long.txt', 1, 'x'.repeat(5_000)));

  const matches = collector.result().matches as GrepMatchRecord[];
  assert.equal(matches[0].preview.length, 2_000);
});

test('executeGrep rejects a missing query before spawning ripgrep', async () => {
  await assert.rejects(executeGrep({ path: '.' }, { projectPath: process.cwd() }), /grep requires query/i);
});

test('grep integration: content matches carry context lines', { skip: ripgrepSkip }, async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(path.join(directory, 'notes.txt'), 'alpha\nneedle one\nbeta\nneedle two\ngamma\n');

    const result = await executeGrep(
      { query: 'needle', path: directory, case_sensitive: true, context: 1 },
      { projectPath: directory },
    );

    assert.equal(result.ok, true);
    assert.equal(result.output_mode, 'content');
    assert.equal(result.count, 2);
    const matches = result.matches as GrepMatchRecord[];
    assert.deepEqual(matches.map((match) => match.line), [2, 4]);
    assert.deepEqual(matches[0].context?.before.map((line) => line.preview), ['alpha']);
    assert.deepEqual(matches[0].context?.after.map((line) => line.preview), ['beta']);
    assert.deepEqual(matches[1].context?.after.map((line) => line.preview), ['gamma']);
    assert.equal(result.truncated, false);
  });
});

test('grep integration: offset/head_limit page through content matches', { skip: ripgrepSkip }, async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(path.join(directory, 'many.txt'), ['needle 1', 'needle 2', 'needle 3', 'needle 4', 'needle 5'].join('\n') + '\n');

    const result = await executeGrep(
      { query: 'needle', path: directory, case_sensitive: true, offset: 1, head_limit: 2 },
      { projectPath: directory },
    );

    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    const matches = result.matches as GrepMatchRecord[];
    assert.deepEqual(matches.map((match) => match.preview), ['needle 2', 'needle 3']);
    assert.equal(result.truncated, true);
    assert.equal(result.next_offset, 3);
  });
});

test('grep integration: files mode returns unique paths', { skip: ripgrepSkip }, async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(path.join(directory, 'a.txt'), 'needle\nneedle again\n');
    await writeFile(path.join(directory, 'b.txt'), 'needle\n');
    await writeFile(path.join(directory, 'c.txt'), 'nothing here\n');

    const result = await executeGrep(
      { query: 'needle', path: directory, case_sensitive: true, output_mode: 'files' },
      { projectPath: directory },
    );

    assert.equal(result.ok, true);
    const files = (result.files as string[]).map((file) => path.basename(file)).sort();
    assert.deepEqual(files, ['a.txt', 'b.txt']);
    assert.equal(result.count, 2);
    assert.equal(result.truncated, false);
  });
});

test('grep integration: count mode aggregates per-file matches', { skip: ripgrepSkip }, async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(path.join(directory, 'a.txt'), 'needle\nneedle again\n');
    await writeFile(path.join(directory, 'b.txt'), 'needle\n');

    const result = await executeGrep(
      { query: 'needle', path: directory, case_sensitive: true, output_mode: 'count' },
      { projectPath: directory },
    );

    assert.equal(result.ok, true);
    const counts = result.counts as Array<{ path: string; count: number }>;
    const byFile = Object.fromEntries(counts.map((entry) => [path.basename(entry.path), entry.count]));
    assert.deepEqual(byFile, { 'a.txt': 2, 'b.txt': 1 });
    assert.equal(result.total_matches, 3);
    assert.equal(result.truncated, false);
  });
});

test('grep integration: type filter limits matches to one ripgrep file type', { skip: ripgrepSkip }, async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(path.join(directory, 'script.py'), 'needle = 1\n');
    await writeFile(path.join(directory, 'notes.txt'), 'needle\n');

    const result = await executeGrep(
      { query: 'needle', path: directory, case_sensitive: true, type: 'py' },
      { projectPath: directory },
    );

    assert.equal(result.ok, true);
    const matches = result.matches as GrepMatchRecord[];
    assert.deepEqual(matches.map((match) => path.basename(match.path)), ['script.py']);
  });
});
