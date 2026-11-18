import type { DecisionPointId, DecisionPointSpec } from './contracts.js';

/**
 * Searcher-only registry. Defaults are off: a framework instance can be wired and shadowed
 * without changing any role behavior.
 */
export const SEARCHER_SPECS: Record<DecisionPointId, DecisionPointSpec> = {
  's2.premise': {
    role: 'searcher',
    scorer: 'heuristic',
    renderer: 's2.premise.short',
    policy: 's2.premise',
    candidates: 's2.labels',
    features: 'none',
    budget: 'short',
    minCandidates: 3,
    modes: ['off', 'shadow', 'assist'],
    fallback: 'llm',
  },
  's2.rerank': {
    role: 'searcher',
    scorer: 'heuristic',
    renderer: 's2.rerank.long',
    policy: 's2.rerank',
    candidates: 's2.cards',
    features: 's2.features',
    budget: 'long',
    minCandidates: 4,
    modes: ['off', 'shadow', 'assist'],
    fallback: 'baseline',
  },
  's2.policy': {
    role: 'searcher',
    scorer: 'none',
    renderer: 'rule',
    policy: 's2.policy',
    candidates: 's2.cards',
    features: 's2.features',
    budget: 'rule',
    minCandidates: 0,
    modes: ['off', 'shadow', 'assist'],
    fallback: 'baseline',
  },
  's3.trigger': {
    role: 'searcher',
    scorer: 'none',
    renderer: 'rule',
    policy: 's3.trigger',
    candidates: 's2.cards',
    features: 's2.features',
    budget: 'rule',
    minCandidates: 0,
    modes: ['off', 'shadow', 'trigger'],
    fallback: 'baseline',
  },
  's5.diversity': {
    role: 'searcher',
    scorer: 'none',
    renderer: 'rule',
    policy: 's5.diversity',
    candidates: 's2.cards',
    features: 's2.features',
    budget: 'rule',
    minCandidates: 0,
    modes: ['off', 'shadow', 'guard'],
    fallback: 'baseline',
  },
};

export function searcherSpec(decisionPoint: DecisionPointId): DecisionPointSpec {
  return { ...SEARCHER_SPECS[decisionPoint], modes: [...SEARCHER_SPECS[decisionPoint].modes] };
}

export function searcherSpecs(): Record<DecisionPointId, DecisionPointSpec> {
  return Object.fromEntries(
    (Object.keys(SEARCHER_SPECS) as DecisionPointId[]).map((decisionPoint) => [decisionPoint, searcherSpec(decisionPoint)]),
  ) as Record<DecisionPointId, DecisionPointSpec>;
}
