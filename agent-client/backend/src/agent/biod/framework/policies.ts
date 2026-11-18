import type {
  Decision,
  DecisionRequest,
  FeatureSet,
  Policy,
  PremiseVerdict,
  Signal,
} from './contracts.js';

export class S2PremisePolicy implements Policy {
  readonly version = 's2.premise-policy-v1';

  decide(request: DecisionRequest, signal: Signal, _features: FeatureSet): Decision {
    if (signal.abstain || !signal.choice) {
      return fallback(request, this.version, 'premise_scorer_abstained');
    }
    return {
      requestId: request.requestId,
      decisionPoint: request.decisionPoint,
      mode: request.mode,
      action: 'select',
      selected: [signal.choice],
      confidence: signal.confidence,
      fallback: false,
      policyVersion: this.version,
    };
  }
}

export class S2RerankPolicy implements Policy {
  readonly version = 's2.rerank-policy-v1';

  decide(request: DecisionRequest, signal: Signal, _features: FeatureSet): Decision {
    if (signal.abstain || Object.keys(signal.scores).length === 0) {
      return fallback(request, this.version, 'rerank_scorer_abstained');
    }
    const ranked = Object.entries(signal.scores)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([id]) => id);
    return {
      requestId: request.requestId,
      decisionPoint: request.decisionPoint,
      mode: request.mode,
      action: 'rank',
      ranked,
      confidence: signal.confidence,
      fallback: false,
      policyVersion: this.version,
    };
  }
}

export class S2FusionPolicy implements Policy {
  readonly version = 's2.policy-v1';

  decide(request: DecisionRequest, _signal: Signal, features: FeatureSet): Decision {
    const cards = request.artifacts.hypotheses;
    const verdicts = request.artifacts.premiseVerdicts ?? [];
    const grouped = groupVerdicts(verdicts);
    const perCandidate = features.perCandidate ?? {};
    const rerank = request.artifacts.rerankScores ?? {};
    if (!cards.length) return fallback(request, this.version, 'no_cards');

    const scored = cards.map((card) => {
      const cardVerdicts = grouped[card.id] ?? [];
      const feature = perCandidate[card.id] ?? {};
      const grounding = numberValue(feature.grounding, ratio(cardVerdicts, 'supported'));
      const contradicted = numberValue(feature.n_contradicted, count(cardVerdicts, 'contradicted'));
      const coverage = numberValue(feature.coverage, (count(cardVerdicts, 'supported') + count(cardVerdicts, 'contradicted')) / Math.max(1, cardVerdicts.length));
      const score = 0.35 * normalize(rerank[card.id])
        + 0.25 * grounding
        + 0.10 * numberValue(feature.gap_fit, card.gapIds.length ? 0.5 : 0)
        + 0.15 * numberValue(feature.testability, 0)
        + 0.10 * numberValue(feature.feasibility, 0)
        - 0.10 * numberValue(feature.redundancy, 0)
        - 0.10 * numberValue(feature.novelty_similarity, 0)
        - 0.20 * Math.min(1, contradicted);
      return { card, score, contradicted, coverage, feature };
    });

    if (scored.every((entry) => entry.coverage < 0.5) || scored.every((entry) => entry.contradicted > 0)) {
      return {
        ...fallback(request, this.version, 'low_evidence_coverage'),
        flags: [{ code: 'low_evidence_coverage' }],
      };
    }

    scored.sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id));
    const topK = Math.min(5, scored.length);
    const shortlist: string[] = [];
    const deferred: Array<{ id: string; reason: string }> = [];
    const clusterCounts = new Map<string, number>();
    for (const entry of scored) {
      if (entry.contradicted > 0) {
        deferred.push({ id: entry.card.id, reason: `premise_conflict:${firstContradicted(grouped[entry.card.id] ?? [])}` });
        continue;
      }
      const cluster = String(entry.feature.cluster ?? entry.card.gapIds.join(',') ?? entry.card.id);
      const count = clusterCounts.get(cluster) ?? 0;
      if (shortlist.length < topK && count < 2) {
        shortlist.push(entry.card.id);
        clusterCounts.set(cluster, count + 1);
      } else {
        deferred.push({ id: entry.card.id, reason: shortlist.length >= topK ? 'top_k_cutoff' : 'diversity_cluster_cap' });
      }
    }
    if (!shortlist.length && scored.length) {
      shortlist.push(scored[0].card.id);
    }
    const exploration = pickExploration(request.requestId, deferred);
    return {
      requestId: request.requestId,
      decisionPoint: request.decisionPoint,
      mode: request.mode,
      action: 'rank',
      ranked: scored.map((entry) => entry.card.id),
      selected: shortlist,
      deferred,
      exploration: exploration ? [exploration] : undefined,
      confidence: scored[0]?.score,
      fallback: false,
      policyVersion: this.version,
    };
  }
}

export class S3TriggerPolicy implements Policy {
  readonly version = 's3.trigger-v1';

  decide(request: DecisionRequest, _signal: Signal, features: FeatureSet): Decision {
    const perCandidate = features.perCandidate ?? {};
    const targets = request.artifacts.hypotheses
      .filter((card) => {
        const feature = perCandidate[card.id] ?? {};
        return numberValue(feature.unknown_ratio, 1) > 0.5
          || numberValue(feature.n_contradicted, 0) > 0
          || numberValue(feature.novelty_similarity, 0) > 0.8;
      })
      .map((card) => card.id);
    return {
      requestId: request.requestId,
      decisionPoint: request.decisionPoint,
      mode: request.mode,
      action: 'trigger',
      selected: targets,
      flags: targets.length ? [{ code: 'deep_review_recommended', detail: `${targets.length} cards` }] : [],
      fallback: false,
      policyVersion: this.version,
    };
  }
}

export class S5DiversityPolicy implements Policy {
  readonly version = 's5.diversity-v1';

  decide(request: DecisionRequest, _signal: Signal, features: FeatureSet): Decision {
    const selected = request.candidates?.length ? request.candidates.map((candidate) => candidate.id) : request.artifacts.hypotheses.map((card) => card.id);
    const cards = request.artifacts.hypotheses;
    if (selected.length < 2) {
      return { requestId: request.requestId, decisionPoint: request.decisionPoint, mode: request.mode, action: 'guard', selected, fallback: false, policyVersion: this.version };
    }
    const similarity = maxPairSimilarity(cards.filter((card) => selected.includes(card.id)).map((card) => card.claim));
    if (similarity <= 0.8) {
      return { requestId: request.requestId, decisionPoint: request.decisionPoint, mode: request.mode, action: 'guard', selected, fallback: false, policyVersion: this.version };
    }
    const extra = cards.find((card) => !selected.includes(card.id));
    return {
      requestId: request.requestId,
      decisionPoint: request.decisionPoint,
      mode: request.mode,
      action: 'guard',
      selected: extra ? [...selected, extra.id] : selected,
      flags: [{ code: 'top_k_redundant', detail: String(similarity) }],
      fallback: false,
      policyVersion: this.version,
    };
  }
}

function fallback(request: DecisionRequest, policyVersion: string, reason: string): Decision {
  return {
    requestId: request.requestId,
    decisionPoint: request.decisionPoint,
    mode: request.mode,
    action: 'abstain',
    fallback: true,
    flags: [{ code: 'policy_fallback', detail: reason }],
    policyVersion,
  };
}

function groupVerdicts(verdicts: PremiseVerdict[]): Record<string, PremiseVerdict[]> {
  const grouped: Record<string, PremiseVerdict[]> = {};
  for (const verdict of verdicts) (grouped[verdict.hypId] ??= []).push(verdict);
  return grouped;
}

function count(verdicts: PremiseVerdict[], value: PremiseVerdict['verdict']): number {
  return verdicts.filter((verdict) => verdict.verdict === value).length;
}

function ratio(verdicts: PremiseVerdict[], value: PremiseVerdict['verdict']): number {
  return verdicts.length ? count(verdicts, value) / verdicts.length : 0;
}

function firstContradicted(verdicts: PremiseVerdict[]): string {
  return verdicts.find((verdict) => verdict.verdict === 'contradicted')?.evidenceId ?? 'unknown';
}

function numberValue(value: unknown, fallbackValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallbackValue;
}

function normalize(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function pickExploration(requestId: string, deferred: Array<{ id: string }>): string | undefined {
  if (!deferred.length) return undefined;
  let hash = 0;
  for (const char of requestId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return deferred[hash % deferred.length].id;
}

function maxPairSimilarity(texts: string[]): number {
  let max = 0;
  for (let left = 0; left < texts.length; left += 1) {
    for (let right = left + 1; right < texts.length; right += 1) {
      max = Math.max(max, jaccard(texts[left], texts[right]));
    }
  }
  return Math.round(max * 100) / 100;
}

function jaccard(left: string, right: string): number {
  const a = new Set(left.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const b = new Set(right.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}
