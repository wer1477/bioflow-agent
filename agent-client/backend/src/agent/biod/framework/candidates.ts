import type { Candidate, CandidateBuilder, DecisionRequest, HypothesisCard } from './contracts.js';

export const PREMISE_LABELS: Candidate[] = [
  { id: 'supported', name: 'supported', description: '证据在相同上下文（物种/体系/干预/方向）中直接蕴含前提' },
  { id: 'contradicted', name: 'contradicted', description: '证据在相同上下文中直接否定前提，或方向/显著性与前提相反' },
  { id: 'unknown', name: 'unknown', description: '无证据、上下文不可比、证据只部分相关，或 snippet 不足以判断' },
];

/**
 * Role-scoped candidates for Searcher decision points. Candidate descriptions are the rows
 * a pointer head scores; they must stay short and stable. `noveltyArgument` and
 * `expectedImpact` are intentionally excluded from the H-rerank candidate text.
 */
export class SearcherCandidateBuilder implements CandidateBuilder {
  readonly version = 'searcher-candidates-v1';

  async build(request: DecisionRequest): Promise<Candidate[]> {
    switch (request.decisionPoint) {
      case 's2.premise':
        return PREMISE_LABELS.map((candidate) => ({ ...candidate }));
      case 's2.rerank':
      case 's2.policy':
        return request.artifacts.hypotheses.map((card) => cardCandidate(card));
      case 's3.trigger':
      case 's5.diversity':
        return request.artifacts.hypotheses.map((card) => ({ id: card.id, name: card.id }));
      default:
        return [];
    }
  }
}

export function cardCandidate(card: HypothesisCard): Candidate {
  const predictions = card.predictions
    .slice(0, 3)
    .map((prediction) => [prediction.text, prediction.readout, prediction.direction].filter(Boolean).join(' / '))
    .join('; ');
  const evidence = card.evidenceLinks
    .slice(0, 4)
    .map((link) => `${link.eid}:${link.relation}`)
    .join(',');
  const feasibility = card.feasibility
    ? [card.feasibility.assay, card.feasibility.sample, card.feasibility.time, card.feasibility.costTier].filter(Boolean).join('/')
    : '';
  const description = [
    card.claim,
    card.mechanism,
    predictions,
    evidence,
    feasibility,
    card.alternatives.length ? `alt:${card.alternatives.slice(0, 2).join('|')}` : '',
  ].filter(Boolean).join(' | ');
  return {
    id: card.id,
    name: card.id,
    description,
    metadata: { gapIds: card.gapIds, evidenceLinks: card.evidenceLinks },
  };
}
