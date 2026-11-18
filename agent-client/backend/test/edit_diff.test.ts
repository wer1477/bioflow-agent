import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextEdits, type TextEdit, type TextEditResult } from '../src/agent/core_tools/edit_diff.js';

function success(result: TextEditResult): { content: string; replacements: number; diff: string } {
  if (!result.ok) throw new Error(`expected success but got ${result.error.code}: ${result.error.message}`);
  return result;
}

function failure(result: TextEditResult): { code: string; message: string } {
  if (result.ok) throw new Error('expected a failure but the edit succeeded');
  return result.error;
}

test('applyTextEdits replaces a unique exact match and returns a diff', () => {
  const result = success(applyTextEdits('alpha\nbeta\ngamma\n', [{ oldString: 'beta', newString: 'delta' }]));

  assert.equal(result.content, 'alpha\ndelta\ngamma\n');
  assert.equal(result.replacements, 1);
  assert.match(result.diff, /^-beta$/m);
  assert.match(result.diff, /^\+delta$/m);
});

test('applyTextEdits replaceAll replaces every occurrence', () => {
  const result = success(applyTextEdits('foo foo\nfoo\n', [{ oldString: 'foo', newString: 'bar', replaceAll: true }]));

  assert.equal(result.content, 'bar bar\nbar\n');
  assert.equal(result.replacements, 3);
});

test('applyTextEdits reports a missing old_string with the documented message', () => {
  const error = failure(applyTextEdits('alpha\nbeta\n', [{ oldString: 'zeta', newString: 'x' }]));

  assert.equal(error.code, 'FS_EDIT_NOT_FOUND');
  assert.match(error.message, /old_string was not found \(exact or fuzzy\)/);
});

test('applyTextEdits rejects an ambiguous exact match with count and line numbers', () => {
  const error = failure(applyTextEdits('x\nsame\ny\nsame\n', [{ oldString: 'same', newString: 'other' }]));

  assert.equal(error.code, 'FS_EDIT_AMBIGUOUS');
  assert.match(error.message, /matched 2 times/);
  assert.match(error.message, /lines 2, 4/);
});

test('applyTextEdits replaceAll resolves an otherwise ambiguous exact match', () => {
  const result = success(applyTextEdits('same\nsame\n', [{ oldString: 'same', newString: 'other', replaceAll: true }]));

  assert.equal(result.content, 'other\nother\n');
  assert.equal(result.replacements, 2);
});

test('applyTextEdits reports no-change edits', () => {
  assert.equal(failure(applyTextEdits('alpha\n', [{ oldString: 'alpha', newString: 'alpha' }])).code, 'FS_EDIT_NO_CHANGE');

  const normalized = failure(applyTextEdits('alpha\r\nbeta\n', [{ oldString: 'alpha\r\nbeta', newString: 'alpha\nbeta' }]));
  assert.equal(normalized.code, 'FS_EDIT_NO_CHANGE');
  assert.match(normalized.message, /produce no change/);
});

test('applyTextEdits validates the edits array', () => {
  assert.equal(failure(applyTextEdits('alpha\n', [])).code, 'FS_EDIT_INVALID');
  assert.equal(failure(applyTextEdits('alpha\n', [{ oldString: '', newString: 'x' }])).code, 'FS_EDIT_INVALID');

  const tooMany: TextEdit[] = Array.from({ length: 21 }, (_, index) => ({ oldString: `line ${index}`, newString: `changed ${index}` }));
  const error = failure(applyTextEdits('alpha\n', tooMany));
  assert.equal(error.code, 'FS_EDIT_INVALID');
  assert.match(error.message, /at most 20/);
});

test('applyTextEdits fuzzy-matches smart quotes, dashes and trailing whitespace per line', () => {
  const original = 'The quick \u201cbrown\u201d fox \u2013 jumps  \nsecond line\nplain with trailing   \n';
  const result = success(applyTextEdits(original, [{ oldString: 'The quick "brown" fox - jumps', newString: 'REPLACED' }]));

  assert.equal(result.content, 'REPLACED\nsecond line\nplain with trailing   \n');
  assert.equal(result.replacements, 1);
});

test('applyTextEdits fuzzy-matches multiple consecutive lines and keeps untouched lines verbatim', () => {
  const original = 'alpha  \n\u201cbeta\u201d line\nplain with trailing   \n';
  const result = success(applyTextEdits(original, [{ oldString: 'alpha\n"beta" line', newString: 'first\nsecond' }]));

  assert.equal(result.content, 'first\nsecond\nplain with trailing   \n');
});

test('applyTextEdits rejects an ambiguous fuzzy match with line numbers', () => {
  const error = failure(applyTextEdits('same\nsame\n', [{ oldString: 'same  ', newString: 'other' }]));

  assert.equal(error.code, 'FS_EDIT_AMBIGUOUS');
  assert.match(error.message, /2 locations/);
  assert.match(error.message, /lines 1, 2/);
});

test('applyTextEdits matches every edit against the original content', () => {
  const sequential = success(applyTextEdits('foo bar\n', [
    { oldString: 'foo', newString: 'bar' },
    { oldString: 'bar', newString: 'baz' },
  ]));
  assert.equal(sequential.content, 'bar baz\n');
  assert.equal(sequential.replacements, 2);

  const disjoint = success(applyTextEdits('one two three\n', [
    { oldString: 'one', newString: '1' },
    { oldString: 'three', newString: '3' },
  ]));
  assert.equal(disjoint.content, '1 two 3\n');
});

test('applyTextEdits rejects overlapping ranges', () => {
  const error = failure(applyTextEdits('abcdef\n', [
    { oldString: 'abc', newString: 'x' },
    { oldString: 'bcd', newString: 'y' },
  ]));

  assert.equal(error.code, 'FS_EDIT_OVERLAP');
  assert.match(error.message, /overlap/i);
  assert.match(error.message, /line 1/);
});

test('applyTextEdits returns LF content for CRLF input', () => {
  const result = success(applyTextEdits('a\r\nb\r\nc\r\n', [{ oldString: 'b', newString: 'B' }]));

  assert.equal(result.content, 'a\nB\nc\n');
});

test('applyTextEdits does not fuzzy-match a partial line', () => {
  // The exact substring is not present (smart quotes differ) and whole-line
  // fuzzy matching must not silently accept a fragment of the line.
  const error = failure(applyTextEdits('prefix \u201cfoo\u201d suffix\n', [{ oldString: 'foo bar', newString: 'x' }]));

  assert.equal(error.code, 'FS_EDIT_NOT_FOUND');
});

test('applyTextEdits bounds the diff size for large multi-line edits', () => {
  const original = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');
  const result = success(applyTextEdits(original, [{ oldString: 'line ', newString: 'changed ', replaceAll: true }]));

  assert.equal(result.replacements, 500);
  assert.ok(result.diff.split('\n').length <= 122);
  assert.match(result.diff, /diff truncated/);
});
