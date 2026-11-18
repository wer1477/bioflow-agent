/**
 * Reviewer V1 issue-triage contracts.
 *
 * V1 runs after the Reviewer has written the issue list. It checks the factual premises of
 * issues that already exist, suggests an owner role, and orders blocking candidates pairwise.
 * It never writes issues, assigns severity grades, edits the review, or gates a decision.
 * A future trained head only implements `IssueTriageScorer`.
 */

import type { StateBudget } from '../framework/contracts.js';

export const ISSUE_TRIAGE_DECISION_POINT = 'v1.issue-triage' as const;

export type IssueAuditMode = 'shadow' | 'assist';

export type IssueAuditFailureReason =
  | 'disabled'
  | 'not_authorized'
  | 'missing_issues'
  | 'empty_issues'
  | 'invalid_issues'
  | 'missing_manuscript'
  | 'unsupported_manuscript_format'
  | 'no_issues'
  | 'timeout'
  | 'bad_response';

export const ISSUE_SECTIONS = [
  'title',
  'abstract',
  'introduction',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'supplementary',
  'unknown',
] as const;
export type IssueSection = (typeof ISSUE_SECTIONS)[number];

export const ISSUE_TYPES = [
  'claim_support',
  'statistical',
  'methodological',
  'reproducibility',
  'novelty',
  'citation',
  'scope',
  'writing',
  'data_availability',
  'ethics',
  'other',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const SEVERITY_CLAIMS = ['blocking', 'important', 'suggestion'] as const;
export type SeverityClaim = (typeof SEVERITY_CLAIMS)[number];

export const PREMISE_KINDS = ['passage', 'absence', 'conflict', 'none'] as const;
export type PremiseKind = (typeof PREMISE_KINDS)[number];

export const PREMISE_VERDICTS = ['holds', 'contradicted', 'unresolved'] as const;
export type IssuePremiseVerdict = (typeof PREMISE_VERDICTS)[number];

export const REVIEWER_ROLES = ['searcher', 'researcher', 'writer', 'reviewer', 'pi'] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const PAIR_VERDICTS = ['a', 'b', 'tie'] as const;
export type PairVerdict = (typeof PAIR_VERDICTS)[number];

export const PREMISE_STATUSES = [
  'premises_hold',
  'premise_contradicted',
  'premise_unresolved',
  'no_premise',
] as const;
export type PremiseStatus = (typeof PREMISE_STATUSES)[number];

export const ISSUE_FINDINGS = [
  'premises_hold',
  'premise_contradicted',
  'premise_unresolved',
  'no_checkable_premise',
  'deferred',
  'unverifiable',
] as const;
export type IssueFinding = (typeof ISSUE_FINDINGS)[number];

export type IssuePriority = 'P0' | 'P1' | 'P2' | 'none';

/** One CSV row: one issue-premise edge. Issue fields repeat across the issue's rows. */
export interface IssuePremiseRow {
  issueId: string;
  section: IssueSection;
  issueText: string;
  issueType: IssueType;
  severityClaim: SeverityClaim;
  /** `P1`..`P9` or `NONE` when the issue states no checkable premise. */
  premiseId: string;
  premiseKind: PremiseKind;
  premiseText: string;
  anchorLocator: string;
  anchorQuote: string;
  anchorQuote2: string;
  searchTerms: string[];
  ownerSuggested?: ReviewerRole;
  notes: string;
}

export interface ParsedIssue {
  issueId: string;
  section: IssueSection;
  issueText: string;
  issueType: IssueType;
  severityClaim: SeverityClaim;
  ownerSuggested?: ReviewerRole;
  premises: IssuePremiseRow[];
  /** Ids of other issues whose text overlaps this one (deterministic duplicate check). */
  duplicates: string[];
}

export interface IssueMatrixLimits {
  maxIssues: number;
  maxPremises: number;
  maxIssueChars: number;
  maxPremiseChars: number;
  maxQuoteChars: number;
  maxSearchTerms: number;
}

export const DEFAULT_ISSUE_MATRIX_LIMITS: IssueMatrixLimits = {
  maxIssues: 64,
  maxPremises: 256,
  maxIssueChars: 500,
  maxPremiseChars: 300,
  maxQuoteChars: 800,
  maxSearchTerms: 5,
};

export const MAX_ISSUE_MATRIX_LIMITS: IssueMatrixLimits = {
  maxIssues: 256,
  maxPremises: 1024,
  maxIssueChars: 500,
  maxPremiseChars: 300,
  maxQuoteChars: 4000,
  maxSearchTerms: 5,
};

/** A passage extracted from the document by code, never supplied by the Reviewer. */
export interface AnchorLocation {
  found: boolean;
  section?: IssueSection;
  paragraphIndex?: number;
  /** Window around the anchor (previous/next paragraph included), used for premise context. */
  passage?: string;
  /**
   * The anchor paragraph(s) only, without neighbours. Conflict premises use this so the
   * two passages are not padded with each other's context.
   */
  anchorText?: string;
  ambiguous: boolean;
  missingFragments: string[];
}

export interface AbsenceSearchResult {
  terms: string[];
  hit?: { term: string; section: IssueSection; paragraphIndex: number; excerpt: string };
  searchedSections: number;
}

export interface PremiseAuditResult {
  premiseId: string;
  kind: PremiseKind;
  premiseText: string;
  anchorLocator: string;
  verdict: IssuePremiseVerdict;
  /** Full distribution for ledger/replay; never shown as a probability in the report. */
  scores: Record<IssuePremiseVerdict, number>;
  confidence: number;
  reasons: string[];
  passage?: string;
  passageSection?: IssueSection;
  passage2?: string;
  flags: string[];
  truncated: boolean;
  fallback: boolean;
}

export interface OwnerRoute {
  owner: ReviewerRole;
  confidence: number;
  scores: Record<ReviewerRole, number>;
  alternatives: Array<{ role: ReviewerRole; score: number }>;
  undecided: boolean;
  disagreesWithSuggestion: boolean;
  reasons: string[];
  fallback: boolean;
}

export interface IssueAudit {
  issueId: string;
  section: IssueSection;
  issueText: string;
  issueType: IssueType;
  severityClaim: SeverityClaim;
  ownerSuggested?: ReviewerRole;
  premiseStatus: PremiseStatus;
  finding: IssueFinding;
  priority: IssuePriority;
  premises: PremiseAuditResult[];
  owner: OwnerRoute;
  flags: string[];
  reasons: string[];
  actions: string[];
  /** 1-based order among pairwise candidates; undefined when not compared. */
  rank?: number;
  pairwiseWins?: number;
  duplicates: string[];
  fallback: boolean;
  deferred: boolean;
}

export interface IssueAuditSummary {
  totalIssues: number;
  totalPremises: number;
  p0: number;
  p1: number;
  p2: number;
  premisesHold: number;
  premiseContradicted: number;
  premiseUnresolved: number;
  noPremise: number;
  anchorsMissing: number;
  locatorMissing: number;
  sectionsMissing: number;
  absenceChecks: number;
  absenceHits: number;
  duplicates: number;
  ownerUndecided: number;
  ownerDisagreements: number;
  deferred: number;
  fallback: number;
}

export interface PairwiseSummary {
  candidates: number;
  comparisons: number;
  truncated: boolean;
}

export interface IssueQueueEntry {
  issueId: string;
  priority: IssuePriority;
  rank?: number;
  owner: ReviewerRole;
  premiseStatus: PremiseStatus;
  why: string;
}

export interface IssueAuditReport {
  requestId: string;
  runId: string;
  role: 'reviewer';
  decisionPoint: typeof ISSUE_TRIAGE_DECISION_POINT;
  mode: IssueAuditMode;
  documentPath: string;
  issuesPath: string;
  documentHash: string;
  issuesHash: string;
  issues: IssueAudit[];
  queue: IssueQueueEntry[];
  summary: IssueAuditSummary;
  pairwise: PairwiseSummary;
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

export interface IssueTriageThresholds {
  minConfidence: number;
  tauContradicted: number;
  tauHolds: number;
  ownerMargin: number;
  pairMargin: number;
  duplicateThreshold: number;
  maxPairwiseIssues: number;
  maxScoredIssues: number;
  topIssues: number;
}

export const DEFAULT_ISSUE_TRIAGE_THRESHOLDS: IssueTriageThresholds = {
  minConfidence: 0.55,
  tauContradicted: 0.65,
  tauHolds: 0.55,
  ownerMargin: 0.15,
  pairMargin: 0.05,
  duplicateThreshold: 0.7,
  maxPairwiseIssues: 8,
  maxScoredIssues: 64,
  topIssues: 10,
};

export interface IssueAuditRequest {
  requestId: string;
  runId: string;
  role: 'reviewer';
  documentPath: string;
  issuesPath: string;
  documentContent: string;
  issuesContent: string;
  mode: IssueAuditMode;
  budget: StateBudget;
  thresholds: IssueTriageThresholds;
  context: {
    sessionId: string;
    rolePromptVersion: string;
    rendererVersion: string;
  };
}

export interface IssueAuditServiceInput {
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
  documentPath: string;
  issuesPath: string;
  documentContent: string;
  issuesContent: string;
}

export type IssueAuditResult =
  | { ok: true; report: IssueAuditReport; markdown: string }
  | { ok: false; reason: IssueAuditFailureReason; message?: string };

export interface PremiseSignal {
  scores: Record<IssuePremiseVerdict, number>;
  confidence: number;
  abstain: boolean;
  reasons: string[];
  latencyMs: number;
}

export interface OwnerSignal {
  scores: Record<ReviewerRole, number>;
  confidence: number;
  abstain: boolean;
  reasons: string[];
  latencyMs: number;
}

export interface PairSignal {
  scores: Record<PairVerdict, number>;
  confidence: number;
  abstain: boolean;
  reasons: string[];
  latencyMs: number;
}

export interface IssueTriageScorer {
  readonly modelVersion: string;
  /** Full state for heuristic/future heads; short state for the v0 premise adapter. */
  readonly variant: 'full' | 'short';
  scorePremise(input: {
    issue: ParsedIssue;
    premise: IssuePremiseRow;
    passage: string;
    passage2?: string;
    state?: string;
    budget?: StateBudget;
  }): Promise<PremiseSignal>;
  scoreOwner(input: {
    issue: ParsedIssue;
    premiseStatus: PremiseStatus;
    state?: string;
    budget?: StateBudget;
  }): Promise<OwnerSignal>;
  scorePair(input: {
    a: ParsedIssue;
    b: ParsedIssue;
    title: string;
    state?: string;
    budget?: StateBudget;
  }): Promise<PairSignal>;
}

export interface IssueAuditRunner {
  runIssueAudit(input: IssueAuditServiceInput): Promise<IssueAuditResult>;
}

export const ISSUE_AUDIT_MODES = ['off', 'shadow', 'assist'] as const;
export const ISSUE_AUDIT_DEFAULT_SCORER = 'heuristic';
export const ISSUE_AUDIT_DEFAULT_BUDGET = 'issue-audit';
export const ISSUE_AUDIT_POLICY_VERSION = 'v1-issue-triage-v1';
export const ISSUE_AUDIT_RENDERER_VERSION = 'v1.issue-triage.full-v1';
export const ISSUE_AUDIT_SHORT_RENDERER_VERSION = 'v1.issue-triage.short-v1';
