import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_TOTAL_DESCRIPTION_MAX_CHARS,
  NATIVE_CANDIDATE_LIMIT,
  candidateFingerprint,
  prepareCandidatePayload,
  shortlistCandidates,
} from '../src/agent/biod/candidate_shortlist.js';
import type { BiodCandidate } from '../src/agent/biod/types.js';

function candidate(index: number, description: string): BiodCandidate {
  return { id: `asset-${index}`, name: `asset ${index}`, description, kind: 'skill' };
}

test('shortlist keeps the relevant asset inside the cap', () => {
  const rows = Array.from({ length: 80 }, (_value, index) =>
    candidate(index, index === 57 ? 'Validate sample identifiers and matrix headers.' : 'Unrelated plotting helper.'));
  const result = shortlistCandidates('Validate sample identifiers and matrix headers', rows, 32);
  assert.equal(result.candidates.length, 32);
  assert.ok(result.candidates.some((row) => row.id === 'asset-57'));
  assert.ok((result.scores.get('asset-57') ?? 0) > 0);
});

test('Chinese paraphrase recalls a new asset at the end of a large catalog', () => {
  const rows = Array.from({ length: 79 }, (_value, index) =>
    candidate(index, 'Unrelated plotting helper for figures.'));
  rows.push({
    id: 'zzz-new-asset',
    name: '样本表头校验',
    description: '验证样本标识与矩阵表头的一致性，检查缺失与重复。',
    kind: 'skill',
  });
  const first = shortlistCandidates('核对样本编号和矩阵表头是否一致', rows, 32);
  assert.equal(first.signal, 'lexical');
  assert.ok(first.candidates.some((row) => row.id === 'zzz-new-asset'));
  const second = shortlistCandidates('检查样本编号与表头一致性', rows, 32);
  assert.ok(second.candidates.some((row) => row.id === 'zzz-new-asset'));
});

test('mixed Chinese/Latin descriptions still match a Chinese request', () => {
  const rows = Array.from({ length: 40 }, (_value, index) =>
    candidate(index, 'Unrelated plotting helper.'));
  rows.push({
    id: 'zzz-mixed',
    name: 'metadata check',
    description: 'Validate 样本标识 and 矩阵表头 for duplicates.',
    kind: 'skill',
  });
  const result = shortlistCandidates('核对样本与表头', rows, 32);
  assert.equal(result.signal, 'lexical');
  assert.ok(result.candidates.some((row) => row.id === 'zzz-mixed'));
});

test('zero lexical signal is an explicit fallback, not an alphabetical cut', () => {
  const rows = Array.from({ length: 80 }, (_value, index) =>
    candidate(index, 'Unrelated plotting helper.'));
  const result = shortlistCandidates('完成一个完全无关的中文任务', rows, 32);
  assert.equal(result.signal, 'none');
  assert.equal(result.fallback, 'no_lexical_signal');
  assert.equal(result.dropped, 48);
  assert.deepEqual(result.candidates.map((row) => row.id), rows.slice(0, 32).map((row) => row.id));
});

test('shortlist is deterministic and keeps catalog order below the cap', () => {
  const rows = [candidate(2, 'b'), candidate(0, 'a'), candidate(1, 'c')];
  const result = shortlistCandidates('anything', rows, 32);
  assert.deepEqual(result.candidates.map((row) => row.id), ['asset-2', 'asset-0', 'asset-1']);
  const again = shortlistCandidates('anything', rows, 32);
  assert.deepEqual(again.candidates.map((row) => row.id), result.candidates.map((row) => row.id));
});

test('fingerprint is order independent and changes with a description', () => {
  const one = [candidate(0, 'alpha'), candidate(1, 'beta')];
  const two = [candidate(1, 'beta'), candidate(0, 'alpha')];
  assert.equal(candidateFingerprint(one), candidateFingerprint(two));
  const changed = [candidate(0, 'alpha changed'), candidate(1, 'beta')];
  assert.notEqual(candidateFingerprint(one), candidateFingerprint(changed));
});

test('payload budget caps count and characters while preserving ids', () => {
  const rows = Array.from({ length: 100 }, (_value, index) =>
    candidate(index, `${'x'.repeat(1_000)} ${index}`));
  const prepared = prepareCandidatePayload(rows);
  assert.ok(prepared.candidateCount <= NATIVE_CANDIDATE_LIMIT);
  assert.ok(prepared.descriptionChars <= CANDIDATE_TOTAL_DESCRIPTION_MAX_CHARS);
  assert.equal(prepared.truncated, true);
  assert.match(prepared.payload[0].id, /^asset-/);
});
