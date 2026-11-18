import {
  asPairRelation,
  toWriterOverclaim,
  toWriterRelation,
  type PairRelation,
} from '../labels.js';
import {
  RoleHeadClient,
  clamp01,
  findPairItem,
  pairProbabilities,
  ROLE_HEAD_MODEL_VERSION,
  type HeadScorerOptions,
  type PairItem,
} from '../head_client.js';
import {
  type ClaimEvidenceRow,
  type ManuscriptAuditScorer,
  type ManuscriptAuditSignal,
  type OverclaimFlag,
  type ParsedClaim,
  type SupportRelation,
} from './contracts.js';

/**
 * Deterministic test/replay scorer. Signals can be keyed by `claimId:evidenceId`,
 * `claimId`, or `evidenceId`; unspecified pairs resolve to a mild "supports".
 */
export class MockManuscriptAuditScorer implements ManuscriptAuditScorer {
  readonly modelVersion = 'mock-w1-v1';
  readonly variant = 'full' as const;

  constructor(private readonly signals: Record<string, Partial<ManuscriptAuditSignal>> = {}) {}

  async score(input: { claim: ParsedClaim; evidence: ClaimEvidenceRow }): Promise<ManuscriptAuditSignal> {
    const signal = this.signals[`${input.claim.claimId}:${input.evidence.evidenceId}`]
      ?? this.signals[input.claim.claimId]
      ?? this.signals[input.evidence.evidenceId]
      ?? {};
    return normalizeSignal(signal, 'mock signal');
  }
}

/**
 * Zero-training baseline. It is deliberately shallow: lexical overlap, negation/direction,
 * and a small set of overclaim patterns. It is a risk screen, not a support verdict.
 */
export class HeuristicManuscriptAuditScorer implements ManuscriptAuditScorer {
  readonly modelVersion = 'heuristic-w1-v1';
  readonly variant = 'full' as const;

  async score(input: { claim: ParsedClaim; evidence: ClaimEvidenceRow }): Promise<ManuscriptAuditSignal> {
    const claimText = input.claim.claimText;
    const quote = input.evidence.evidenceQuote;
    const claimTokens = contentTokens(claimText);
    const quoteTokens = contentTokens(quote);
    const overlap = overlapRatio(claimTokens, quoteTokens);
    const tooShort = claimText.trim().length < 20 || quote.trim().length < 20;
    const abstain = tooShort || claimTokens.length === 0 || quoteTokens.length === 0;

    const negationMismatch = hasNegation(claimText) !== hasNegation(quote);
    const directionMismatch = direction(claimText) !== 'none' && direction(quote) !== 'none' && direction(claimText) !== direction(quote);
    const causalHedge = input.claim.claimType === 'causal' && /\b(associated|correlated|linked|suggest|may|might|could)\b/i.test(quote);
    const overclaim: OverclaimFlag[] = [];

    if (causalHedge) overclaim.push('causality');
    if (input.claim.claimType === 'generalization' && input.evidence.evidenceScope.trim()) overclaim.push('scope');
    if (hasCertaintyClaim(claimText) && /\b(may|might|suggest|associated|preliminary|could)\b/i.test(quote)) overclaim.push('certainty');
    if (hasBroadScope(claimText) && hasNarrowScope(input.evidence.evidenceScope)) overclaim.push('generalization');
    if (hasTemporalClaim(claimText) && !hasTemporalMarkers(quote)) overclaim.push('temporal');

    const supports = 0.18 + 0.72 * overlap;
    const partial = 0.12 + 0.3 * overlap + (causalHedge ? 0.18 : 0);
    const contradicts = 0.02 + (negationMismatch ? 0.55 : 0) + (directionMismatch ? 0.6 : 0);
    const unrelated = overlap < 0.08 ? 0.72 : 0.04;
    const unverifiable = abstain ? 0.9 : overlap < 0.04 ? 0.35 : 0.03;
    const raw: Record<SupportRelation, number> = {
      supports,
      partially_supports: partial,
      contradicts,
      unrelated,
      unverifiable,
    };
    const scores = normalizeScores(raw);
    const top = Math.max(...Object.values(scores));
    const confidence = abstain ? 0 : Math.min(0.9, Math.max(0.35, 0.4 + 0.5 * overlap + (contradicts > 0.5 ? 0.15 : 0)));

    return {
      scores,
      overclaim: [...new Set(overclaim)],
      confidence,
      abstain,
      reasons: [
        `lexical overlap=${overlap.toFixed(2)}`,
        ...(negationMismatch ? ['negation mismatch'] : []),
        ...(directionMismatch ? ['direction mismatch'] : []),
        ...(causalHedge ? ['causal claim but evidence is hedged/associational'] : []),
        ...(overclaim.length ? [`overclaim flags: ${overclaim.join(', ')}`] : []),
        ...(abstain ? ['claim/quote too short for a support judgement'] : []),
        `top relation=${top.toFixed(2)}`,
      ],
      latencyMs: 0,
    };
  }
}

/** Placeholder adapter for the future W2 support head; never fabricates a verdict. */
export class BiodSupportScorer implements ManuscriptAuditScorer {
  readonly modelVersion = 'biod-support-unavailable';
  readonly variant = 'short' as const;

  async score(): Promise<ManuscriptAuditSignal> {
    return {
      scores: { supports: 0, partially_supports: 0, contradicts: 0, unrelated: 0, unverifiable: 1 },
      overclaim: [],
      confidence: 0,
      abstain: true,
      reasons: ['biod support head is not wired in this build'],
      latencyMs: 0,
    };
  }
}

/**
 * W1 adapter for the trained heads (`biod-mt-v2`): H6 gives the claim-evidence relation and
 * H7 gives the overclaim flags. Both tasks score the same pair, so each claim costs two
 * `/v1/score-pairs` calls (one item each) issued in parallel.
 *
 * Fail-open: if the relation call fails the distribution degrades to `unverifiable`; if the
 * flags call fails the flags are empty. Only when both calls fail does the signal abstain.
 */
export class HttpManuscriptAuditScorer implements ManuscriptAuditScorer {
  readonly modelVersion = ROLE_HEAD_MODEL_VERSION;
  readonly variant = 'full' as const;
  private readonly client: RoleHeadClient;

  constructor(options: HeadScorerOptions) {
    this.client = new RoleHeadClient(options);
  }

  async score(input: { claim: ParsedClaim; evidence: ClaimEvidenceRow }): Promise<ManuscriptAuditSignal> {
    const started = Date.now();
    const item: PairItem = {
      id: `${input.claim.claimId}:${input.evidence.evidenceId}`,
      left: input.claim.claimText,
      right: input.evidence.evidenceQuote,
      ...(input.evidence.evidenceScope.trim() ? { context: input.evidence.evidenceScope } : {}),
      unit: 'claim',
    };
    const [relation, flags] = await Promise.all([
      this.client.scorePairs('premise_judge', [item]),
      this.client.scorePairs('overclaim_flag', [item]),
    ]);

    const relationItem = findPairItem(relation, item.id);
    const probs = relationItem ? pairProbabilities(relationItem) : undefined;
    const flagItem = findPairItem(flags, item.id);
    const relationUsable = Boolean(probs);
    const flagsUsable = Boolean(flags.ok && flagItem);

    const reasons: string[] = ['biod-mt-v2'];
    const mapped = relationItem?.label ? asPairRelation(relationItem.label) : undefined;
    if (relationUsable && mapped) reasons.push(`relation:${toWriterRelation(mapped)}`);
    else reasons.push(relation.ok ? 'relation_unscored' : relation.reason);
    if (flagsUsable && flagItem) {
      if (flagItem.flags.length) reasons.push(`overclaim:${flagItem.flags.join(',')}`);
    } else {
      reasons.push(flags.ok ? 'flags_unscored' : flags.reason);
    }

    return {
      scores: probs
        ? toSupportScores(probs)
        : normalizeScores({ supports: 0, partially_supports: 0, contradicts: 0, unrelated: 0, unverifiable: 1 }),
      overclaim: flagsUsable && flagItem ? toWriterOverclaim(flagItem.flags) : [],
      confidence: clamp01(relationItem?.confidence ?? 0),
      abstain: !relationUsable && !flagsUsable,
      reasons,
      latencyMs: Date.now() - started,
    };
  }
}

/** H6 -> W1: `insufficient` is the W1 `unverifiable` class; the other four names are shared. */
function toSupportScores(probs: Record<PairRelation, number>): Record<SupportRelation, number> {
  return {
    supports: probs.supports,
    partially_supports: probs.partially_supports,
    contradicts: probs.contradicts,
    unrelated: probs.unrelated,
    unverifiable: probs.insufficient,
  };
}

export function createManuscriptAuditScorer(
  name: string,
  options?: HeadScorerOptions,
): ManuscriptAuditScorer {
  switch (name) {
    case 'mock':
      return new MockManuscriptAuditScorer();
    case 'biod-support':
      return new BiodSupportScorer();
    case 'http': {
      if (!options?.baseUrl?.trim()) {
        throw new Error('createManuscriptAuditScorer("http") requires a base URL (biod.service.baseUrl)');
      }
      return new HttpManuscriptAuditScorer(options);
    }
    case 'heuristic':
    default:
      return new HeuristicManuscriptAuditScorer();
  }
}

function normalizeSignal(signal: Partial<ManuscriptAuditSignal>, fallbackReason: string): ManuscriptAuditSignal {
  const scores = normalizeScores({
    supports: signal.scores?.supports ?? 0.8,
    partially_supports: signal.scores?.partially_supports ?? 0.05,
    contradicts: signal.scores?.contradicts ?? 0.02,
    unrelated: signal.scores?.unrelated ?? 0.03,
    unverifiable: signal.scores?.unverifiable ?? 0.1,
  });
  return {
    scores,
    overclaim: signal.overclaim ?? [],
    confidence: signal.confidence ?? 0.8,
    abstain: signal.abstain ?? false,
    reasons: signal.reasons ?? [fallbackReason],
    latencyMs: signal.latencyMs ?? 0,
  };
}

function normalizeScores(scores: Record<SupportRelation, number>): Record<SupportRelation, number> {
  const total = Object.values(scores).reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) {
    return { supports: 0, partially_supports: 0, contradicts: 0, unrelated: 0, unverifiable: 1 };
  }
  return {
    supports: scores.supports / total,
    partially_supports: scores.partially_supports / total,
    contradicts: scores.contradicts / total,
    unrelated: scores.unrelated / total,
    unverifiable: scores.unverifiable / total,
  };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those', 'we', 'our', 'as', 'by',
  'from', 'at', 'it', 'its', 'than', 'then', 'also', 'can', 'may', 'might', 'not', 'no',
]);

function contentTokens(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  const tokens = lower.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  return tokens.filter((token) => !STOPWORDS.has(token));
}

function overlapRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const hit = a.filter((token) => setB.has(token)).length;
  return hit / Math.min(a.length, b.length);
}

function hasNegation(text: string): boolean {
  return /\b(not|no|never|without|lack|absent|failed to|did not|does not)\b/i.test(text);
}

function direction(text: string): 'up' | 'down' | 'none' {
  const value = String(text ?? '');
  const up = /\b(increase|increased|higher|upregulat|elevat|enhanc|promot|gain)\b/i.test(value);
  const down = /\b(decrease|decreased|lower|downregulat|reduc|inhibit|suppress|loss)\b/i.test(value);
  if (up && !down) return 'up';
  if (down && !up) return 'down';
  return 'none';
}

function hasCertaintyClaim(text: string): boolean {
  return /\b(prove|proves|proven|demonstrate|demonstrates|establish|establishes|always|never|must)\b/i.test(text);
}

function hasBroadScope(text: string): boolean {
  return /\b(all|always|every|humans|patients|across|universal)\b/i.test(text);
}

function hasNarrowScope(scope: string): boolean {
  return /\b(mouse|mice|rat|in vitro|cell line|organoid|one cohort|single)\b/i.test(scope);
}

function hasTemporalClaim(text: string): boolean {
  return /\b(first|previously|after|before|during|follow-up)\b/i.test(text);
}

function hasTemporalMarkers(text: string): boolean {
  return /\b(first|previously|after|before|during|follow-up|week|day|month|year)\b/i.test(text);
}
