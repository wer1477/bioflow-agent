import { RoleHeadClient, clamp01, findPairItem, pairProbabilities, type PairItem } from '../head_client.js';
import type { Candidate, DecisionPointId, PremiseVerdictValue, Scorer, Signal, StateBudget } from './contracts.js';

export interface ScorerInput {
  decisionPoint: DecisionPointId;
  state: string;
  candidates: Candidate[];
  labels?: Candidate[];
  budget: StateBudget;
}

/** Deterministic scorer: same input, same output. Good for contract tests and replay. */
export class MockScorer implements Scorer {
  readonly kind: Signal['kind'];
  readonly modelVersion = 'mock-v1';

  constructor(kind: Signal['kind'] = 'choice') {
    this.kind = kind;
  }

  supports(decisionPoint: DecisionPointId): boolean {
    return decisionPoint === 's2.premise' || decisionPoint === 's2.rerank';
  }

  async score(input: ScorerInput): Promise<Signal> {
    const started = Date.now();
    if (input.decisionPoint === 's2.premise') {
      const labels = input.labels ?? input.candidates;
      const index = hash(input.state) % Math.max(1, labels.length);
      const choice = labels[index]?.id ?? 'unknown';
      return {
        kind: 'choice',
        scores: Object.fromEntries(labels.map((label, position) => [label.id, position === index ? 0.8 : 0.1])),
        choice,
        confidence: 0.8,
        abstain: false,
        reasons: ['mock'],
        modelVersion: this.modelVersion,
        latencyMs: Date.now() - started,
      };
    }
    const scores: Record<string, number> = {};
    for (const candidate of input.candidates) {
      scores[candidate.id] = Math.round(((hash(`${input.state}:${candidate.id}`) % 1000) / 1000) * 100) / 100;
    }
    return {
      kind: 'rerank',
      scores,
      confidence: 0.5,
      abstain: false,
      reasons: ['mock'],
      modelVersion: this.modelVersion,
      latencyMs: Date.now() - started,
    };
  }
}

/** Keyword rules for shadow runs before a trained head exists. */
export class HeuristicScorer implements Scorer {
  readonly kind: Signal['kind'] = 'choice';
  readonly modelVersion = 'heuristic-v1';

  supports(decisionPoint: DecisionPointId): boolean {
    return decisionPoint === 's2.premise' || decisionPoint === 's2.rerank';
  }

  async score(input: ScorerInput): Promise<Signal> {
    const started = Date.now();
    if (input.decisionPoint === 's2.premise') {
      const text = input.state.toLowerCase();
      const labels = input.labels ?? input.candidates;
      const choice = !text.includes(' e:') || /no evidence|not significant|no change|failed to detect/.test(text)
        ? 'unknown'
        : /increased|increase|upregulated|higher/.test(text) && /decreas|reduc|lower/.test(text)
          ? 'contradicted'
          : 'supported';
      const scores: Record<string, number> = {};
      for (const label of labels) scores[label.id] = label.id === choice ? 0.72 : 0.14;
      return {
        kind: 'choice',
        scores,
        choice,
        confidence: 0.72,
        abstain: false,
        reasons: ['heuristic'],
        modelVersion: this.modelVersion,
        latencyMs: Date.now() - started,
      };
    }
    const scores: Record<string, number> = {};
    for (const candidate of input.candidates) {
      const description = `${candidate.name} ${candidate.description ?? ''}`.toLowerCase();
      let score = 0.25;
      if (/readout|wb|scrna|qpcr|elisa/.test(description)) score += 0.2;
      if (/falsifier|falsif|direction/.test(description)) score += 0.2;
      if (/low|med/.test(description) && /cost|feasib/.test(description)) score += 0.1;
      if (/conflict/.test(description)) score -= 0.15;
      scores[candidate.id] = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
    }
    return {
      kind: 'rerank',
      scores,
      confidence: 0.4,
      abstain: false,
      reasons: ['heuristic'],
      modelVersion: this.modelVersion,
      latencyMs: Date.now() - started,
    };
  }
}

export interface HttpScorerOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * S2 premise adapter for the trained H6 pair head (`biod-mt-v2`).
 *
 * Text availability: `Scorer.score` only receives the rendered state and the label rows —
 * the `DecisionRequest` itself (and therefore `HypothesisCard` / `EvidenceRow`) is not
 * reachable here. The `s2.premise.short` renderer is the only carrier of the pair text:
 * `[S|P] C:<claim> P:<premise> E:<snippet> X:<context>`. We parse that string; the claim
 * segment is clipped to 10 chars by the renderer, so `left` is really "premise text with a
 * short claim label", and `right` is the evidence snippet. When the state does not look like
 * that rendering, we fall back to sending the whole state as `left` (and abstain because
 * there is no evidence text).
 *
 * The batch therefore carries exactly one item per decision: `candidates` lists the three
 * verdict labels, not three hypothesis/evidence pairs.
 *
 * Fail-open: a timeout, a 500 or a malformed payload becomes an abstain signal, never an
 * exception. The S2 policy then falls back to the role's own path.
 */
export class HttpScorer implements Scorer {
  readonly kind: Signal['kind'] = 'choice';
  readonly modelVersion = 'biod-mt-v2';
  private readonly client: RoleHeadClient;

  constructor(options: HttpScorerOptions) {
    this.client = new RoleHeadClient(options);
  }

  supports(decisionPoint: DecisionPointId): boolean {
    // Only s2.premise has a trained head; s2.rerank stays on the heuristic scorer.
    return decisionPoint === 's2.premise';
  }

  async score(input: ScorerInput): Promise<Signal> {
    const started = Date.now();
    if (input.decisionPoint !== 's2.premise') {
      return abstain(this.modelVersion, started, 'unsupported_decision_point');
    }
    const item = premisePairItem(input.state);
    if (!item) return abstain(this.modelVersion, started, 'missing_premise_text');
    if (!item.right.trim()) return abstain(this.modelVersion, started, 'missing_evidence_text');

    const response = await this.client.scorePairs('premise_judge', [item]);
    if (!response.ok) return abstain(this.modelVersion, started, response.reason);
    const scored = findPairItem(response, item.id);
    const probs = scored ? pairProbabilities(scored) : undefined;
    if (!scored || !probs) return abstain(this.modelVersion, started, 'bad_response');

    // H6 -> S2 grouping. Partial support is still support; unrelated/insufficient are
    // "cannot tell" for the three-way S2 label space.
    const scores: Record<PremiseVerdictValue, number> = {
      supported: probs.supports + probs.partially_supports,
      contradicted: probs.contradicts,
      unknown: probs.unrelated + probs.insufficient,
    };
    const choice = argmaxVerdict(scores);
    return {
      kind: 'choice',
      scores,
      choice,
      confidence: clamp01(scored.confidence ?? scores[choice]),
      abstain: false,
      reasons: ['biod-mt-v2', `relation:${scored.label ?? 'unknown'}`],
      modelVersion: response.value.modelVersion ?? this.modelVersion,
      latencyMs: response.value.latencyMs ?? response.latencyMs,
    };
  }
}

interface ParsedPremiseState {
  claim: string;
  premise: string;
  evidence: string;
  context: string;
}

/**
 * Parse the `s2.premise.short-v1` rendering. Marker splitting is intentionally shallow: the
 * snippet is free text, so an occurrence of `" E:"` inside it would split early, but the
 * resulting item is still a superset of the pair and the head sees the same evidence.
 */
function premisePairItem(state: string): PairItem | undefined {
  const fields = parsePremiseState(state);
  const hypothesis = [fields.claim, fields.premise].filter((part) => part.trim()).join(' | ').trim();
  const left = hypothesis || state.trim();
  if (!left) return undefined;
  return {
    id: 's2.premise',
    left,
    right: fields.evidence.trim(),
    ...(fields.context.trim() ? { context: fields.context.trim() } : {}),
    unit: 'hypothesis',
  };
}

function parsePremiseState(state: string): ParsedPremiseState {
  const body = String(state ?? '').replace(/^\[S\|P\]\s*/, '');
  const fields: ParsedPremiseState = { claim: '', premise: '', evidence: '', context: '' };
  const keys: Record<string, keyof ParsedPremiseState> = { C: 'claim', P: 'premise', E: 'evidence', X: 'context' };
  for (const segment of body.split(/\s(?=[CPEX]:)/)) {
    const match = /^([CPEX]):([\s\S]*)$/.exec(segment);
    if (!match) continue;
    const key = keys[match[1]];
    if (key) fields[key] = match[2].trim();
  }
  return fields;
}

function argmaxVerdict(scores: Record<PremiseVerdictValue, number>): PremiseVerdictValue {
  const order: PremiseVerdictValue[] = ['supported', 'contradicted', 'unknown'];
  let best = order[0];
  for (const verdict of order) if (scores[verdict] > scores[best]) best = verdict;
  return best;
}

export function createScorer(name: string, options?: HttpScorerOptions): Scorer | undefined {
  switch (name) {
    case 'mock': return new MockScorer();
    case 'heuristic': return new HeuristicScorer();
    case 'http': return options ? new HttpScorer(options) : undefined;
    default: return undefined;
  }
}

function abstain(modelVersion: string, started: number, reason: string): Signal {
  return {
    kind: 'choice',
    scores: {},
    abstain: true,
    reasons: [reason],
    modelVersion,
    latencyMs: Date.now() - started,
  };
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}
