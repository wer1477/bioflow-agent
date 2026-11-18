import type { DecisionPointId, DecisionRequest, FeatureProvider, FeatureSet, PremiseVerdict, Signal } from './contracts.js';

/**
 * Deterministic, model-free features for the Searcher screen. These are intentionally
 * simple: they give Policy a working signal before any trained head exists, and they are
 * replaced/calibrated later without changing the policy interface.
 */
export class SearcherFeatureProvider implements FeatureProvider {
  readonly version = 'searcher-features-v1';

  supports(decisionPoint: DecisionPointId): boolean {
    return decisionPoint === 's2.policy' || decisionPoint === 's2.rerank' || decisionPoint === 's3.trigger' || decisionPoint === 's5.diversity';
  }

  async compute(request: DecisionRequest, _signal: Signal): Promise<FeatureSet> {
    const artifacts = request.artifacts;
    const verdicts = artifacts.premiseVerdicts ?? [];
    const perCandidate: Record<string, Record<string, number | boolean | string>> = {};
    const claims = artifacts.hypotheses.map((card) => ({ id: card.id, claim: card.claim }));
    const clusters = artifacts.hypotheses.map((card) => `${card.id}:${card.gapIds.join(',')}`);

    for (const card of artifacts.hypotheses) {
      const cardVerdicts = verdicts.filter((verdict) => verdict.hypId === card.id);
      const supported = cardVerdicts.filter((verdict) => verdict.verdict === 'supported').length;
      const contradicted = cardVerdicts.filter((verdict) => verdict.verdict === 'contradicted').length;
      const unknown = cardVerdicts.filter((verdict) => verdict.verdict === 'unknown').length;
      const total = cardVerdicts.length;
      const redundancy = maxSimilarity(card.claim, claims.filter((other) => other.id !== card.id).map((other) => other.claim));
      perCandidate[card.id] = {
        grounding: total ? supported / total : 0,
        coverage: total ? (supported + contradicted) / total : 0,
        n_contradicted: contradicted,
        unknown_ratio: total ? unknown / total : 1,
        gap_fit: card.gapIds.length ? (artifacts.gaps?.length ? 0.8 : 0.5) : 0,
        testability: testability(card),
        feasibility: feasibility(card),
        redundancy: redundancy,
        novelty_similarity: card.noveltyProxy?.maxSimilarity ?? 0,
        card_quality: cardQuality(card),
        cluster: clusters[artifacts.hypotheses.findIndex((item) => item.id === card.id)] ?? card.id,
      };
    }

    return {
      values: {
        candidate_count: artifacts.hypotheses.length,
        evidence_count: artifacts.evidence.length,
        premise_verdict_count: verdicts.length,
        unknown_ratio: verdicts.length ? verdicts.filter((verdict) => verdict.verdict === 'unknown').length / verdicts.length : 1,
      },
      perCandidate,
    };
  }
}

function testability(card: DecisionRequest['artifacts']['hypotheses'][number]): number {
  if (!card.predictions.length) return 0;
  const checks = card.predictions.map((prediction) => {
    let score = 0;
    if (prediction.readout) score += 1;
    if (prediction.direction) score += 1;
    if (prediction.falsifier) score += 1;
    return score / 3;
  });
  const predictions = checks.reduce((sum, value) => sum + value, 0) / checks.length;
  const alternatives = card.alternatives.length ? 1 : 0;
  return Math.round(((predictions * 0.7) + (alternatives * 0.3)) * 100) / 100;
}

function feasibility(card: DecisionRequest['artifacts']['hypotheses'][number]): number {
  const feasibility = card.feasibility;
  if (!feasibility) return 0;
  const fields = [feasibility.assay, feasibility.sample, feasibility.time].filter(Boolean).length / 3;
  const cost = feasibility.costTier === 'low' ? 1 : feasibility.costTier === 'med' ? 0.6 : feasibility.costTier === 'high' ? 0.2 : 0;
  return Math.round(((fields * 0.6) + (cost * 0.4)) * 100) / 100;
}

function cardQuality(card: DecisionRequest['artifacts']['hypotheses'][number]): number {
  const fields = [card.claim, card.mechanism, card.gapIds.length, card.predictions.length, card.evidenceLinks.length, card.alternatives.length, card.dataNeeded, card.feasibility];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100) / 100;
}

function maxSimilarity(text: string, others: string[]): number {
  const tokens = tokenSet(text);
  if (!tokens.size || !others.length) return 0;
  let max = 0;
  for (const other of others) {
    const otherTokens = tokenSet(other);
    if (!otherTokens.size) continue;
    let shared = 0;
    for (const token of tokens) if (otherTokens.has(token)) shared += 1;
    max = Math.max(max, shared / Math.max(tokens.size, otherTokens.size));
  }
  return Math.round(max * 100) / 100;
}

function tokenSet(text: string): Set<string> {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return new Set(tokens);
}

export function groupVerdicts(verdicts: PremiseVerdict[]): Record<string, PremiseVerdict[]> {
  const grouped: Record<string, PremiseVerdict[]> = {};
  for (const verdict of verdicts) {
    (grouped[verdict.hypId] ??= []).push(verdict);
  }
  return grouped;
}
