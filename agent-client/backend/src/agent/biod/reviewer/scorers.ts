import {
  PAIR_VERDICTS,
  PREMISE_VERDICTS,
  REVIEWER_ROLES,
  type IssuePremiseRow,
  type IssueTriageScorer,
  type OwnerSignal,
  type PairSignal,
  type PairVerdict,
  type ParsedIssue,
  type PremiseSignal,
  type PremiseStatus,
  type ReviewerRole,
} from './contracts.js';
import {
  RoleHeadClient,
  clamp01,
  findPairItem,
  pairProbabilities,
  ROLE_HEAD_MODEL_VERSION,
  type HeadScorerOptions,
  type PairItem,
} from '../head_client.js';

/**
 * Deterministic test/replay scorer. Signals are keyed by `issueId:premiseId`, `premiseId`,
 * owner by `issueId`, pair by `a:b` (issue ids). Unspecified keys fall back to a mild default.
 */
export class MockIssueTriageScorer implements IssueTriageScorer {
  readonly modelVersion = 'mock-v1-v1';
  readonly variant = 'full' as const;

  constructor(
    private readonly signals: {
      premise?: Record<string, Partial<PremiseSignal>>;
      owner?: Record<string, Partial<OwnerSignal>>;
      pair?: Record<string, Partial<PairSignal>>;
    } = {},
  ) {}

  async scorePremise(input: { issue: ParsedIssue; premise: IssuePremiseRow }): Promise<PremiseSignal> {
    const key = `${input.issue.issueId}:${input.premise.premiseId}`;
    const signal = this.signals.premise?.[key] ?? this.signals.premise?.[input.premise.premiseId] ?? {};
    return normalizePremiseSignal(signal, 'mock premise signal');
  }

  async scoreOwner(input: { issue: ParsedIssue }): Promise<OwnerSignal> {
    const signal = this.signals.owner?.[input.issue.issueId] ?? {};
    return normalizeOwnerSignal(signal, 'mock owner signal');
  }

  async scorePair(input: { a: ParsedIssue; b: ParsedIssue }): Promise<PairSignal> {
    const key = `${input.a.issueId}:${input.b.issueId}`;
    const reverse = `${input.b.issueId}:${input.a.issueId}`;
    const signal = this.signals.pair?.[key];
    if (signal) return normalizePairSignal(signal, 'mock pair signal');
    const mirrored = this.signals.pair?.[reverse];
    if (mirrored) {
      return normalizePairSignal(
        {
          ...mirrored,
          scores: mirrored.scores
            ? { a: mirrored.scores.b ?? 0, b: mirrored.scores.a ?? 0, tie: mirrored.scores.tie ?? 0 }
            : undefined,
        },
        'mock pair signal',
      );
    }
    return normalizePairSignal({ scores: { a: 0.34, b: 0.33, tie: 0.33 } }, 'mock pair signal');
  }
}

/**
 * Zero-training baseline. It is deliberately shallow: lexical overlap, negation/contrast,
 * direction and number conflicts for premises; issue-type/keyword mapping for ownership;
 * a weighted blocking score for pairwise order. It is a triage screen, not a verdict.
 */
export class HeuristicIssueTriageScorer implements IssueTriageScorer {
  readonly modelVersion = 'heuristic-v1-v1';
  readonly variant = 'full' as const;

  constructor(private readonly options: { pairMargin?: number } = {}) {}

  async scorePremise(input: {
    issue: ParsedIssue;
    premise: IssuePremiseRow;
    passage: string;
    passage2?: string;
  }): Promise<PremiseSignal> {
    if (input.premise.premiseKind === 'conflict') {
      return conflictSignal(input.premise.premiseText, input.passage, input.passage2 ?? '');
    }
    const premiseText = input.premise.premiseText;
    const passage = input.passage;
    const premiseTokens = contentTokens(premiseText);
    const passageTokens = contentTokens(passage);
    const overlap = overlapRatio(premiseTokens, passageTokens);
    const tooShort = premiseText.trim().length < 20 || passage.trim().length < 20;
    const abstain = tooShort || premiseTokens.length === 0 || passageTokens.length === 0;

    const numberMismatch = numbersConflict(premiseText, passage);
    const contrastMismatch = contrastWordsConflict(premiseTokens, passageTokens);
    const negationMismatch = hasNegation(premiseText) !== hasNegation(passage);
    const directionMismatch = direction(premiseText) !== 'none'
      && direction(passage) !== 'none'
      && direction(premiseText) !== direction(passage);

    // Any concrete conflict signal must beat a high lexical overlap: a modified quote that
    // shares most words with the premise is exactly the dangerous case.
    const hasConflictSignal = negationMismatch || contrastMismatch || directionMismatch || numberMismatch;
    const holds = 0.15 + 0.7 * overlap + (hasConflictSignal ? -0.35 : 0.05);
    const contradicted = 0.03
      + (negationMismatch ? 0.5 : 0)
      + (contrastMismatch ? 0.55 : 0)
      + (directionMismatch ? 0.85 : 0)
      + (numberMismatch ? 0.7 : 0);
    const unresolved = abstain ? 0.9 : overlap < 0.12 ? 0.55 : 0.05;
    const scores = normalizePremiseScores({ holds, contradicted, unresolved });

    const conflictFlags = [
      ...(numberMismatch ? ['number mismatch'] : []),
      ...(contrastMismatch ? ['contrast/negation mismatch'] : []),
      ...(negationMismatch ? ['negation mismatch'] : []),
      ...(directionMismatch ? ['direction mismatch'] : []),
    ];
    const strongest = Math.max(...Object.values(scores));
    return {
      scores,
      confidence: abstain ? 0 : clamp(0.35, 0.9, 0.4 + 0.5 * overlap + (contradicted > 0.5 ? 0.15 : 0)),
      abstain,
      reasons: [
        `lexical overlap=${overlap.toFixed(2)}`,
        ...conflictFlags,
        ...(abstain ? ['premise/passage too short for a judgement'] : []),
        `top=${strongest.toFixed(2)}`,
      ],
      latencyMs: 0,
    };
  }

  async scoreOwner(input: { issue: ParsedIssue; premiseStatus: PremiseStatus }): Promise<OwnerSignal> {
    const issue = input.issue;
    const text = issue.issueText.toLowerCase();
    const scores: Record<ReviewerRole, number> = {
      searcher: 0.02,
      researcher: 0.02,
      writer: 0.02,
      reviewer: 0.02,
      pi: 0.02,
    };
    for (const [role, weight] of Object.entries(baseOwnerWeights(issue.issueType))) {
      scores[role as ReviewerRole] += weight ?? 0;
    }
    if (/re-?analy|compute|run |experiment|power|sample size|statistic|model fit/.test(text)) scores.researcher += 0.25;
    if (/literature|prior work|preprint|search|citation|reference/.test(text)) scores.searcher += 0.2;
    if (/rewrite|clarify|wording|report|describe|figure legend/.test(text)) scores.writer += 0.2;
    if (/irb|consent|ethic|policy|accept|reject|decision|dispute/.test(text)) scores.pi += 0.25;
    if (/re-?review|second reviewer|meta-review/.test(text)) scores.reviewer += 0.15;
    if (issue.severityClaim === 'blocking' && issue.issueType === 'ethics') scores.pi += 0.15;

    const normalized = normalizeOwnerScores(scores);
    const top = Math.max(...Object.values(normalized));
    const abstain = issue.issueText.trim().length < 20;
    return {
      scores: normalized,
      confidence: abstain ? 0 : top,
      abstain,
      reasons: [`issue_type=${issue.issueType}`, `premise status=${input.premiseStatus}`],
      latencyMs: 0,
    };
  }

  async scorePair(input: { a: ParsedIssue; b: ParsedIssue; title: string }): Promise<PairSignal> {
    const a = blockingWeight(input.a);
    const b = blockingWeight(input.b);
    const diff = Math.abs(a - b);
    const reason = `blocking weight a=${a.toFixed(2)} b=${b.toFixed(2)}`;
    if (diff < (this.options.pairMargin ?? 0.05)) {
      return {
        scores: { a: 0.25, b: 0.25, tie: 0.5 },
        confidence: 0.5,
        abstain: false,
        reasons: [reason, 'weights are within the margin'],
        latencyMs: 0,
      };
    }
    const winner: PairVerdict = a > b ? 'a' : 'b';
    return {
      scores: { a: winner === 'a' ? 0.6 : 0.25, b: winner === 'b' ? 0.6 : 0.25, tie: 0.15 },
      confidence: clamp(0.5, 0.9, 0.55 + diff),
      abstain: false,
      reasons: [reason, `higher weight: ${winner}`],
      latencyMs: 0,
    };
  }
}

/** Placeholder adapter for a future 3-way premise head; never fabricates a verdict. */
export class BiodPremiseScorer implements IssueTriageScorer {
  readonly modelVersion = 'biod-premise-unavailable';
  readonly variant = 'short' as const;

  async scorePremise(): Promise<PremiseSignal> {
    return {
      scores: { holds: 0, contradicted: 0, unresolved: 1 },
      confidence: 0,
      abstain: true,
      reasons: ['biod premise head is not wired in this build'],
      latencyMs: 0,
    };
  }

  async scoreOwner(): Promise<OwnerSignal> {
    return {
      scores: { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 1 },
      confidence: 0,
      abstain: true,
      reasons: ['biod owner head is not wired in this build'],
      latencyMs: 0,
    };
  }

  async scorePair(): Promise<PairSignal> {
    return {
      scores: { a: 0, b: 0, tie: 1 },
      confidence: 0,
      abstain: true,
      reasons: ['biod pair head is not wired in this build'],
      latencyMs: 0,
    };
  }
}

/**
 * V1 adapter for the trained heads (`biod-mt-v2`).
 *
 * - premise: H6 `premise_judge` with `unit: "issue"`; the two passages are joined because
 *   the head takes one right-hand side per item (conflict premises use both).
 * - owner: `/v1/decide/role_select` (zero-shot transfer from the role head).
 * - pair: no trained head yet, so it always abstains; `rankByPairwise` turns the abstain
 *   into a `tie`, which is the caller's contract.
 *
 * Every method is fail-open: an error becomes an abstain signal with a reason.
 */
export class HttpIssueTriageScorer implements IssueTriageScorer {
  readonly modelVersion = ROLE_HEAD_MODEL_VERSION;
  readonly variant = 'full' as const;
  private readonly client: RoleHeadClient;

  constructor(options: HeadScorerOptions) {
    this.client = new RoleHeadClient(options);
  }

  async scorePremise(input: {
    issue: ParsedIssue;
    premise: IssuePremiseRow;
    passage: string;
    passage2?: string;
  }): Promise<PremiseSignal> {
    const started = Date.now();
    const passage = [input.passage, input.passage2 ?? '']
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    const item: PairItem = {
      id: `${input.issue.issueId}:${input.premise.premiseId}`,
      left: input.premise.premiseText.trim(),
      right: passage,
      context: [
        `issue_type=${input.issue.issueType}`,
        `section=${input.issue.section}`,
        `premise_kind=${input.premise.premiseKind}`,
        input.premise.anchorLocator ? `locator=${input.premise.anchorLocator}` : '',
      ].filter(Boolean).join(' | '),
      unit: 'issue',
    };
    if (!item.left) return abstainPremise('missing_premise_text', started);
    if (!item.right) return abstainPremise('missing_passage', started);

    const response = await this.client.scorePairs('premise_judge', [item]);
    if (!response.ok) return abstainPremise(response.reason, started);
    const scored = findPairItem(response, item.id);
    const probs = scored ? pairProbabilities(scored) : undefined;
    if (!scored || !probs) return abstainPremise('bad_response', started);

    // H6 -> V1: partial support still holds the premise; unrelated/insufficient are unresolved.
    const scores = normalizePremiseScores({
      holds: probs.supports + probs.partially_supports,
      contradicted: probs.contradicts,
      unresolved: probs.unrelated + probs.insufficient,
    });
    return {
      scores,
      confidence: clamp01(scored.confidence ?? Math.max(...Object.values(scores))),
      abstain: false,
      reasons: ['biod-mt-v2', `relation:${scored.label ?? 'unknown'}`],
      latencyMs: response.value.latencyMs ?? response.latencyMs,
    };
  }

  async scoreOwner(input: { issue: ParsedIssue; premiseStatus: PremiseStatus }): Promise<OwnerSignal> {
    const started = Date.now();
    const state = ownerState(input.issue);
    if (!state.trim()) return abstainOwner('empty_state', started);

    const response = await this.client.selectRole(state);
    if (!response.ok) return abstainOwner(response.reason, started);
    if (!response.value.scores.length) return abstainOwner('bad_response', started);

    const raw: Record<ReviewerRole, number> = { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 0 };
    for (const entry of response.value.scores) {
      if ((REVIEWER_ROLES as readonly string[]).includes(entry.role)) {
        raw[entry.role as ReviewerRole] = clamp01(entry.p);
      }
    }
    const scores = normalizeOwnerScores(raw);
    return {
      scores,
      confidence: clamp01(response.value.confidence),
      abstain: false,
      reasons: ['biod-mt-v2', ...(response.value.role ? [`role:${response.value.role}`] : [])],
      latencyMs: response.value.latencyMs ?? response.latencyMs,
    };
  }

  async scorePair(): Promise<PairSignal> {
    return {
      scores: { a: 0, b: 0, tie: 1 },
      confidence: 0,
      abstain: true,
      reasons: ['model_unavailable'],
      latencyMs: 0,
    };
  }
}

/**
 * Owner state = issue statement + premises + expected fix.
 *
 * `issues.csv` has no dedicated title/expected-fix column: `issue_text` is the reviewer's
 * issue statement (title + problem) and `notes` is the only free-text slot that may carry
 * the expected fix, so it is appended when present.
 */
function ownerState(issue: ParsedIssue): string {
  const premises = issue.premises
    .map((premise) => premise.premiseText.trim())
    .filter(Boolean)
    .join(' | ');
  const expectedFix = issue.premises
    .map((premise) => premise.notes.trim())
    .filter(Boolean)
    .join(' | ');
  return [
    `Issue: ${issue.issueText.trim()}`,
    premises ? `Premise: ${premises}` : '',
    expectedFix ? `Expected fix: ${expectedFix}` : '',
    `Type: ${issue.issueType} | Section: ${issue.section} | Claimed severity: ${issue.severityClaim}`,
  ].filter(Boolean).join('\n');
}

function abstainPremise(reason: string, started: number): PremiseSignal {
  return {
    scores: { holds: 0, contradicted: 0, unresolved: 1 },
    confidence: 0,
    abstain: true,
    reasons: [reason],
    latencyMs: Date.now() - started,
  };
}

function abstainOwner(reason: string, started: number): OwnerSignal {
  return {
    scores: { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 1 },
    confidence: 0,
    abstain: true,
    reasons: [reason],
    latencyMs: Date.now() - started,
  };
}

export function createIssueTriageScorer(
  name: string,
  options: {
    pairMargin?: number;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): IssueTriageScorer {
  switch (name) {
    case 'mock':
      return new MockIssueTriageScorer();
    case 'biod-premise':
      return new BiodPremiseScorer();
    case 'http': {
      if (!options.baseUrl?.trim()) {
        throw new Error('createIssueTriageScorer("http") requires a base URL (biod.service.baseUrl)');
      }
      return new HttpIssueTriageScorer({
        baseUrl: options.baseUrl,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    }
    case 'heuristic':
    default:
      return new HeuristicIssueTriageScorer(options);
  }
}

function conflictSignal(premiseText: string, passageA: string, passageB: string): PremiseSignal {
  const a = contentTokens(passageA);
  const b = contentTokens(passageB);
  const overlap = overlapRatio(a, b);
  const directionMismatch = direction(passageA) !== 'none'
    && direction(passageB) !== 'none'
    && direction(passageA) !== direction(passageB);
  const negationMismatch = hasNegation(passageA) !== hasNegation(passageB);
  const contrastMismatch = contrastWordsConflict(a, b);
  const numberMismatch = numbersConflict(passageA, passageB);
  const tooShort = passageA.trim().length < 20 || passageB.trim().length < 20;

  const conflictSignals = directionMismatch || negationMismatch || contrastMismatch || numberMismatch;
  const holds = conflictSignals ? 0.55 + (directionMismatch ? 0.2 : 0) + (numberMismatch ? 0.1 : 0) : 0.12 + overlap * 0.3;
  const contradicted = !conflictSignals && overlap >= 0.5 && direction(passageA) === direction(passageB)
    ? 0.55 + overlap * 0.2
    : 0.08;
  const unresolved = tooShort || !conflictSignals ? 0.55 : 0.06;
  const scores = normalizePremiseScores({ holds, contradicted, unresolved });
  return {
    scores,
    confidence: tooShort ? 0 : clamp(0.35, 0.9, 0.5 + (conflictSignals ? 0.2 : 0) + overlap * 0.1),
    abstain: tooShort,
    reasons: [
      `passage-to-passage overlap=${overlap.toFixed(2)}`,
      ...(directionMismatch ? ['direction mismatch'] : []),
      ...(negationMismatch ? ['negation mismatch'] : []),
      ...(contrastMismatch ? ['contrast mismatch'] : []),
      ...(numberMismatch ? ['number mismatch'] : []),
      ...(!conflictSignals ? ['no conflict signal between the passages'] : []),
      ...(tooShort ? ['passages too short for a judgement'] : []),
    ],
    latencyMs: 0,
  };
}

function baseOwnerWeights(issueType: ParsedIssue['issueType']): Partial<Record<ReviewerRole, number>> {
  switch (issueType) {
    case 'claim_support':
      return { writer: 0.45, reviewer: 0.3, searcher: 0.15 };
    case 'statistical':
      return { researcher: 0.6, reviewer: 0.25, pi: 0.05 };
    case 'methodological':
      return { researcher: 0.5, reviewer: 0.35, writer: 0.05 };
    case 'reproducibility':
      return { writer: 0.4, researcher: 0.4, pi: 0.05 };
    case 'novelty':
      return { searcher: 0.55, reviewer: 0.25, pi: 0.05 };
    case 'citation':
      return { writer: 0.5, searcher: 0.35, reviewer: 0.05 };
    case 'scope':
      return { writer: 0.45, reviewer: 0.35, pi: 0.05 };
    case 'writing':
      return { writer: 0.8, reviewer: 0.1 };
    case 'data_availability':
      return { writer: 0.45, researcher: 0.4, pi: 0.05 };
    case 'ethics':
      return { pi: 0.55, reviewer: 0.25, writer: 0.1 };
    case 'other':
    default:
      return { reviewer: 0.45, writer: 0.25, pi: 0.15 };
  }
}

const TYPE_WEIGHTS: Record<ParsedIssue['issueType'], number> = {
  statistical: 0.5,
  methodological: 0.45,
  claim_support: 0.45,
  ethics: 0.5,
  data_availability: 0.3,
  reproducibility: 0.3,
  scope: 0.25,
  novelty: 0.2,
  other: 0.2,
  citation: 0.15,
  writing: 0.1,
};

function blockingWeight(issue: ParsedIssue): number {
  let weight = TYPE_WEIGHTS[issue.issueType] ?? 0.2;
  if (issue.severityClaim === 'blocking') weight += 0.15;
  if (issue.severityClaim === 'suggestion') weight -= 0.1;
  if (issue.section === 'abstract' || issue.section === 'conclusion' || issue.section === 'results') weight += 0.1;
  if (issue.section === 'supplementary') weight -= 0.1;
  const text = issue.issueText.toLowerCase();
  if (/primary endpoint|primary outcome|randomis|randomiz|control group|causal|confound|leakage/.test(text)) weight += 0.08;
  return Math.max(0, weight);
}

function normalizePremiseSignal(
  signal: Partial<PremiseSignal>,
  fallbackReason: string,
): PremiseSignal {
  const scores = normalizePremiseScores({
    holds: signal.scores?.holds ?? 0.6,
    contradicted: signal.scores?.contradicted ?? 0.05,
    unresolved: signal.scores?.unresolved ?? 0.35,
  });
  return {
    scores,
    confidence: signal.confidence ?? 0.7,
    abstain: signal.abstain ?? false,
    reasons: signal.reasons ?? [fallbackReason],
    latencyMs: signal.latencyMs ?? 0,
  };
}

function normalizeOwnerSignal(signal: Partial<OwnerSignal>, fallbackReason: string): OwnerSignal {
  const scores = normalizeOwnerScores({
    searcher: signal.scores?.searcher ?? 0.05,
    researcher: signal.scores?.researcher ?? 0.05,
    writer: signal.scores?.writer ?? 0.7,
    reviewer: signal.scores?.reviewer ?? 0.15,
    pi: signal.scores?.pi ?? 0.05,
  });
  return {
    scores,
    confidence: signal.confidence ?? 0.7,
    abstain: signal.abstain ?? false,
    reasons: signal.reasons ?? [fallbackReason],
    latencyMs: signal.latencyMs ?? 0,
  };
}

function normalizePairSignal(signal: Partial<PairSignal>, fallbackReason: string): PairSignal {
  const scores = normalizePairScores({
    a: signal.scores?.a ?? 0.5,
    b: signal.scores?.b ?? 0.3,
    tie: signal.scores?.tie ?? 0.2,
  });
  return {
    scores,
    confidence: signal.confidence ?? 0.6,
    abstain: signal.abstain ?? false,
    reasons: signal.reasons ?? [fallbackReason],
    latencyMs: signal.latencyMs ?? 0,
  };
}

function normalizePremiseScores(scores: Record<(typeof PREMISE_VERDICTS)[number], number>): Record<(typeof PREMISE_VERDICTS)[number], number> {
  return normalizeDistribution(scores, { holds: 0, contradicted: 0, unresolved: 1 });
}

function normalizeOwnerScores(scores: Record<ReviewerRole, number>): Record<ReviewerRole, number> {
  return normalizeDistribution(scores, { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 1 });
}

function normalizePairScores(scores: Record<(typeof PAIR_VERDICTS)[number], number>): Record<(typeof PAIR_VERDICTS)[number], number> {
  return normalizeDistribution(scores, { a: 0, b: 0, tie: 1 });
}

function normalizeDistribution<T extends string>(scores: Record<T, number>, fallback: Record<T, number>): Record<T, number> {
  const keys = Object.keys(scores) as T[];
  const total = keys.reduce((sum, key) => sum + Math.max(0, scores[key]), 0);
  if (total <= 0) return { ...fallback };
  const result = {} as Record<T, number>;
  for (const key of keys) {
    result[key] = Math.max(0, scores[key]) / total;
  }
  return result;
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
  const setA = new Set(a);
  const setB = new Set(b);
  let hit = 0;
  for (const token of setA) if (setB.has(token)) hit += 1;
  return hit / Math.min(setA.size, setB.size);
}

function hasNegation(text: string): boolean {
  return /\b(not|no|never|without|lack|absent|failed to|did not|does not|none)\b/i.test(text);
}

function direction(text: string): 'up' | 'down' | 'none' {
  const value = String(text ?? '');
  const up = /\b(increase|increased|higher|upregulat|elevat|enhanc|promot|gain|rise|rose)\b/i.test(value);
  const down = /\b(decrease|decreased|lower|downregulat|reduc|inhibit|suppress|loss|drop|fell)\b/i.test(value);
  if (up && !down) return 'up';
  if (down && !up) return 'down';
  return 'none';
}

function numbersConflict(a: string, b: string): boolean {
  const left = extractNumbers(a);
  const right = extractNumbers(b);
  if (!left.length || !right.length) return false;
  const rightSet = new Set(right);
  return !left.some((number) => rightSet.has(number));
}

function extractNumbers(text: string): string[] {
  // Figure/table/section numbers are labels, not measurements: "Fig. 2" vs "Fig. 3" must
  // not be read as a numeric conflict between two passages.
  const withoutLabels = String(text ?? '').replace(
    /\b(?:fig(?:ure)?\.?|table|section|step|eq(?:uation)?\.?)\s*\d+[A-Za-z]?/gi,
    ' ',
  );
  const matches = withoutLabels.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return [...new Set(matches)];
}

/** Detect `unadjusted` vs `adjusted`-style contrasts that plain negation regexes miss. */
function contrastWordsConflict(tokens: string[], otherTokens: string[]): boolean {
  const other = new Set(otherTokens);
  for (const token of tokens) {
    const match = /^(un|non|dis|de)([a-z]{3,})$/.exec(token);
    if (match && other.has(match[2])) return true;
  }
  return false;
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}
