import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPathSegment, isPathSegment } from '../src/agent/config/path_segments.js';

test('path segments must match the session-store character set', () => {
  assert.equal(isPathSegment('abc-123_X'), true);
  assert.equal(isPathSegment('a/b'), false);
  assert.equal(isPathSegment('..'), false);
  assert.equal(isPathSegment(''), false);
  assert.equal(isPathSegment(undefined), false);
});

test('a malformed id throws instead of being silently rewritten into another directory', () => {
  assert.throws(() => assertPathSegment('a/b', 'conversation id'), /Invalid conversation id/);
  assert.throws(() => assertPathSegment('..', 'project key'), /Invalid project key/);
  assert.equal(assertPathSegment('ok-1', 'conversation id'), 'ok-1');
});
