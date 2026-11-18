import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSegment, encodeSegment, projectKey, validateProjectName } from '../src/agent/config/project_key.js';

test('encodeSegment keeps safe characters and escapes everything else', () => {
  assert.equal(encodeSegment('my-project'), 'my-project');
  assert.equal(encodeSegment('a b'), 'a_0020_b');
  assert.equal(encodeSegment('..'), '_002E__002E_');
  assert.equal(encodeSegment('_'), '_005F_');
  assert.equal(encodeSegment('生信分析'), '_751F__4FE1__5206__6790_');
  assert.match(encodeSegment('生信 分析/x'), /^[A-Za-z0-9_-]+$/);
});

test('escaping is injective: every input survives a round trip', () => {
  for (const value of ['my-project', 'a b', '..', '_', '生信分析', 'a_0020_b', '.sessions']) {
    assert.equal(decodeSegment(encodeSegment(value)), value);
  }
  const names = ['a b', 'a_0020_b', '生信分析', '_751F__4FE1__5206__6790_'];
  assert.equal(new Set(names.map(projectKey)).size, names.length);
});

test('validateProjectName rejects separators, dot prefixes, reserved names and oversized escapes', () => {
  assert.deepEqual(validateProjectName('正常项目'), { ok: true, value: '正常项目' });
  assert.equal(validateProjectName('a/b').ok, false);
  assert.equal(validateProjectName('a\\b').ok, false);
  assert.equal(validateProjectName('.hidden').ok, false);
  assert.equal(validateProjectName('.sessions').ok, false);
  assert.equal(validateProjectName('   ').ok, false);
  // 64 CJK characters escape to 448 bytes, past the 255-byte path-segment limit.
  assert.equal(validateProjectName('中'.repeat(64)).ok, false);
});
