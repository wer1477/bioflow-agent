/**
 * Searcher decision framework contracts.
 *
 * This module is intentionally model-free: it describes the data that moves between a
 * renderer, a scorer (mock/heuristic today, a trained head later), a policy, and the
 * ledger. Nothing here imports the sidecar, the tool dispatcher, or a role runtime.
 */

export type Role = 'searcher';
export type Mode = 'off' | 'shadow' | 'assist' | 'guard' | 'trigger' | 'cascade';
export type BudgetProfile =
  | 'rule'
  | 'short'
  | 'medium'
  | 'long'
  | 'max'
  | 'audit'
  | 'audit-max'
  | 'claim-audit'
  | 'claim-audit-max'
  | 'issue-audit'
  | 'issue-audit-max';

/** Searcher decision points implemented by this framework. s1.source/s4.stop are out of scope. */
export type DecisionPointId =
  | 's2.premise'
  | 's2.rerank'
  | 's2.policy'
  | 's3.trigger'
  | 's5.diversity';

export interface StateBudget {
  profile: BudgetProfile;
  /** Prompt + state + candidate rows. max=32768 is a future-training placeholder. */
  maxTotalTokens: number;
  /** Renderer-only cap for the state string. */
  maxStateTokens: number;
  maxCandidates: number;
  timeoutMs: number;
}

export interface Candidate {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface HypothesisPrediction {
  text: string;
  readout?: string;
  direction?: string;
  falsifier?: string;
}

export interface HypothesisEvidenceLink {
  eid: string;
  relation: 'supports' | 'conflicts' | 'neutral';
}

export interface HypothesisFeasibility {
  assay?: string;
  sample?: string;
  time?: string;
  costTier?: 'low' | 'med' | 'high';
}

export interface Premise {
  pid: string;
  text: string;
  type?: 'empirical' | 'mechanistic' | 'feasibility' | 'inferential';
}

export interface HypothesisCard {
  id: string;
  rqId?: string;
  gapIds: string[];
  claim: string;
  mechanism?: string;
  premises?: Premise[];
  predictions: HypothesisPrediction[];
  evidenceLinks: HypothesisEvidenceLink[];
  alternatives: string[];
  dataNeeded?: string;
  feasibility?: HypothesisFeasibility;
  noveltyArgument?: string;
  /** Kept for LLM/PI only; must not enter the H-rerank state. */
  expectedImpact?: string;
  noveltyProxy?: { nearestIds?: string[]; maxSimilarity?: number };
  risks?: string[];
}

export interface EvidenceContext {
  species?: string;
  system?: string;
  intervention?: string;
  direction?: string;
  sampleSize?: string;
}

export interface EvidenceRow {
  id: string;
  claimId?: string;
  sourceType?: string;
  locator: string;
  snippet?: string;
  studyDesign?: string;
  effect?: string;
  limitations?: string;
  retractionStatus?: string;
  context?: EvidenceContext;
}

export type PremiseVerdictValue = 'supported' | 'contradicted' | 'unknown';

export interface PremiseVerdict {
  hypId: string;
  pid: string;
  verdict: PremiseVerdictValue;
  confidence: number;
  evidenceId: string;
  reasonCode?: string;
}

/** One Searcher run's structured artifacts. Free text is never read by the framework. */
export interface SearcherArtifacts {
  rq?: string;
  reviewSummary?: string;
  gaps?: string[];
  hypotheses: HypothesisCard[];
  evidence: EvidenceRow[];
  premiseVerdicts?: PremiseVerdict[];
  /** Optional precomputed rerank scores, keyed by hyp id. */
  rerankScores?: Record<string, number>;
}

export interface FeatureSet {
  values: Record<string, number | boolean | string>;
  /** Per-card features for set-level decisions (S2 policy/rerank). */
  perCandidate?: Record<string, Record<string, number | boolean | string>>;
}

export interface DecisionRequest {
  requestId: string;
  runId: string;
  role: Role;
  decisionPoint: DecisionPointId;
  mode: Mode;
  artifacts: SearcherArtifacts;
  /** Which premise/evidence this request is about (S2.P); absent for set-level decisions. */
  focus?: { hypId?: string; pid?: string; evidenceId?: string };
  candidates?: Candidate[];
  features?: FeatureSet;
  budget: StateBudget;
  context: {
    sessionId: string;
    handoffId?: string;
    rolePromptVersion: string;
    rendererVersion: string;
  };
}

export interface Signal {
  kind: 'choice' | 'pointwise' | 'rerank' | 'binary' | 'rule';
  scores: Record<string, number>;
  choice?: string;
  confidence?: number;
  abstain: boolean;
  reasons: string[];
  modelVersion: string;
  latencyMs: number;
}

export interface DecisionFlag {
  code: string;
  target?: string;
  detail?: string;
}

export interface Decision {
  requestId: string;
  decisionPoint: DecisionPointId;
  mode: Mode;
  action: 'select' | 'rank' | 'flag' | 'trigger' | 'guard' | 'abstain';
  selected?: string[];
  ranked?: string[];
  deferred?: Array<{ id: string; reason: string }>;
  exploration?: string[];
  flags?: DecisionFlag[];
  confidence?: number;
  fallback: boolean;
  policyVersion: string;
  signalRef?: string;
}

export interface DecisionPointSpec {
  role: Role;
  scorer: string;
  renderer: string;
  policy: string;
  candidates: string;
  features: string;
  budget: BudgetProfile;
  minCandidates: number;
  modes: Mode[];
  fallback: 'baseline' | 'llm' | 'human' | 'escalate';
}

export interface CandidateBuilder {
  version: string;
  build(request: DecisionRequest): Promise<Candidate[]>;
}

export interface FeatureProvider {
  version: string;
  supports(decisionPoint: DecisionPointId): boolean;
  compute(request: DecisionRequest, signal: Signal): Promise<FeatureSet>;
}

export interface Renderer {
  version: string;
  render(input: unknown, budget: StateBudget): { state: string; estimatedTokens: number; truncated: boolean };
}

export interface Scorer {
  kind: Signal['kind'];
  modelVersion: string;
  supports(decisionPoint: DecisionPointId): boolean;
  score(input: {
    decisionPoint: DecisionPointId;
    state: string;
    candidates: Candidate[];
    labels?: Candidate[];
    budget: StateBudget;
  }): Promise<Signal>;
}

export interface Policy {
  version: string;
  decide(request: DecisionRequest, signal: Signal, features: FeatureSet): Decision;
}

export interface DecisionRecord {
  ts: string;
  requestId: string;
  runId: string;
  role: Role;
  decisionPoint: DecisionPointId;
  mode: Mode;
  rendererVersion: string;
  modelVersion: string;
  policyVersion: string;
  stateHash: string;
  stateChars: number;
  estimatedTokens: number;
  truncated: boolean;
  candidates: string[];
  scores: Record<string, number>;
  decision: Decision;
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

export interface DecisionLedger {
  append(record: DecisionRecord): void;
}

export const EMPTY_FEATURES: FeatureSet = { values: {} };

export function isDecisionPointId(value: unknown): value is DecisionPointId {
  return value === 's2.premise'
    || value === 's2.rerank'
    || value === 's2.policy'
    || value === 's3.trigger'
    || value === 's5.diversity';
}

export function failureDecision(
  request: DecisionRequest,
  policyVersion: string,
  reason: string,
): Decision {
  return {
    requestId: request.requestId,
    decisionPoint: request.decisionPoint,
    mode: request.mode,
    action: 'abstain',
    fallback: true,
    flags: [{ code: 'framework_fail_open', detail: reason }],
    policyVersion,
  };
}
