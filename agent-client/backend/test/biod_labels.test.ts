import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PARTIAL_CONFIDENCE_FACTOR,
  PAIR_RELATIONS,
  MODEL_OVERCLAIM_FLAGS,
  asPairRelation,
  toReviewerVerdict,
  toSearcherVerdict,
  toWriterOverclaim,
  toWriterRelation,
} from '../src/agent/biod/labels.js';

test('label spaces are the ones the trained heads emit', () => {
  assert.deepEqual([...PAIR_RELATIONS], [
    'supports',
    'partially_supports',
    'contradicts',
    'unrelated',
    'insufficient',
  ]);
  assert.deepEqual([...MODEL_OVERCLAIM_FLAGS], [
    'scope',
    'causality',
    'certainty',
    'generalization',
    'temporal',
  ]);
});

test('H6 -> searcher premise verdict', () => {
  assert.deepEqual(toSearcherVerdict('supports', 0.9), { verdict: 'supported', confidence: 0.9 });
  assert.deepEqual(toSearcherVerdict('contradicts', 0.8), { verdict: 'contradicted', confidence: 0.8 });
  assert.deepEqual(toSearcherVerdict('partially_supports', 0.9), {
    verdict: 'supported',
    confidence: 0.9 * PARTIAL_CONFIDENCE_FACTOR,
  });
  assert.equal(toSearcherVerdict('unrelated', 0.9).verdict, 'unknown');
  assert.equal(toSearcherVerdict('insufficient', 0.9).verdict, 'unknown');
});

test('H6 -> writer relation is near identity, insufficient becomes unverifiable', () => {
  assert.equal(toWriterRelation('supports'), 'supports');
  assert.equal(toWriterRelation('partially_supports'), 'partially_supports');
  assert.equal(toWriterRelation('contradicts'), 'contradicts');
  assert.equal(toWriterRelation('unrelated'), 'unrelated');
  assert.equal(toWriterRelation('insufficient'), 'unverifiable');
});

test('H6 -> reviewer premise verdict', () => {
  assert.equal(toReviewerVerdict('supports', 0.9).verdict, 'holds');
  assert.equal(toReviewerVerdict('partially_supports', 0.9).verdict, 'holds');
  assert.equal(toReviewerVerdict('partially_supports', 0.9).confidence, 0.9 * PARTIAL_CONFIDENCE_FACTOR);
  assert.equal(toReviewerVerdict('contradicts', 0.9).verdict, 'contradicted');
  assert.equal(toReviewerVerdict('unrelated', 0.9).verdict, 'unresolved');
  assert.equal(toReviewerVerdict('insufficient', 0.9).verdict, 'unresolved');
});

test('H7 -> writer overclaim drops unknown flags and preserves model order', () => {
  assert.deepEqual(toWriterOverclaim(['causality', 'scope']), ['scope', 'causality']);
  assert.deepEqual(toWriterOverclaim(['unknown', 'temporal']), ['temporal']);
  assert.deepEqual(toWriterOverclaim([]), []);
});

test('asPairRelation narrows only known values', () => {
  assert.equal(asPairRelation('supports'), 'supports');
  assert.equal(asPairRelation('unverifiable'), undefined);
  assert.equal(asPairRelation(''), undefined);
});
