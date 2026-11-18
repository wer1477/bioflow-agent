/**
 * Bridging layer between the trained role-head label spaces (`biod-mt-v2`) and the
 * per-role audit contracts used by the agent runtime.
 *
 * The model emits a **superset**: five pair relations and five overclaim flags.
 * Each consumer narrows that superset here, in one place, so the mapping can be
 * reviewed and pinned by `test/biod_labels.test.ts` instead of being scattered
 * across the three audit pipelines.
 *
 * Model side (see `Biod/docs/role-heads.md`):
 *   - H6 `pair_relation` : supports | partially_supports | contradicts | unrelated | insufficient
 *   - H7 `overclaim`     : scope | causality | certainty | generalization | temporal
 */

import type { PremiseVerdictValue } from './framework/contracts.js';
import type { IssuePremiseVerdict } from './reviewer/contracts.js';
import type { OverclaimFlag, SupportRelation } from './writer/contracts.js';

/** H6 `pair_relation` head output space. */
export const PAIR_RELATIONS = [
  'supports',
  'partially_supports',
  'contradicts',
  'unrelated',
  'insufficient',
] as const;
export type PairRelation = (typeof PAIR_RELATIONS)[number];

/** H7 `overclaim` head output space. */
export const MODEL_OVERCLAIM_FLAGS = [
  'scope',
  'causality',
  'certainty',
  'generalization',
  'temporal',
] as const;
export type ModelOverclaimFlag = (typeof MODEL_OVERCLAIM_FLAGS)[number];

/**
 * Partial support is still support, but it must not keep full confidence: every
 * mapping that turns `partially_supports` into a two-value verdict discounts the
 * confidence by this factor.
 */
export const PARTIAL_CONFIDENCE_FACTOR = 0.8;

export interface MappedVerdict<T extends string> {
  verdict: T;
  confidence: number;
}

/** H6 -> Searcher `s2.premise` (`supported | contradicted | unknown`). */
export function toSearcherVerdict(relation: PairRelation, confidence: number): MappedVerdict<PremiseVerdictValue> {
  switch (relation) {
    case 'supports':
      return { verdict: 'supported', confidence };
    case 'partially_supports':
      return { verdict: 'supported', confidence: confidence * PARTIAL_CONFIDENCE_FACTOR };
    case 'contradicts':
      return { verdict: 'contradicted', confidence };
    case 'unrelated':
    case 'insufficient':
    default:
      return { verdict: 'unknown', confidence: confidence * PARTIAL_CONFIDENCE_FACTOR };
  }
}

/** H6 -> Writer `relation` (`SupportRelation`, five values, one of which is `unverifiable`). */
export function toWriterRelation(relation: PairRelation): SupportRelation {
  return relation === 'insufficient' ? 'unverifiable' : relation;
}

/** H6 -> Reviewer premise verdict (`holds | contradicted | unresolved`). */
export function toReviewerVerdict(relation: PairRelation, confidence: number): MappedVerdict<IssuePremiseVerdict> {
  switch (relation) {
    case 'supports':
      return { verdict: 'holds', confidence };
    case 'partially_supports':
      return { verdict: 'holds', confidence: confidence * PARTIAL_CONFIDENCE_FACTOR };
    case 'contradicts':
      return { verdict: 'contradicted', confidence };
    case 'unrelated':
    case 'insufficient':
    default:
      return { verdict: 'unresolved', confidence: confidence * PARTIAL_CONFIDENCE_FACTOR };
  }
}

/** H7 -> Writer `overclaim` flags. Unknown strings are dropped, order is model order. */
export function toWriterOverclaim(flags: readonly string[]): OverclaimFlag[] {
  const active = new Set(flags);
  return MODEL_OVERCLAIM_FLAGS.filter((flag) => active.has(flag));
}

/** Narrow an arbitrary string to a `PairRelation`, or `undefined` if it is not one. */
export function asPairRelation(value: string): PairRelation | undefined {
  return (PAIR_RELATIONS as readonly string[]).includes(value) ? (value as PairRelation) : undefined;
}
