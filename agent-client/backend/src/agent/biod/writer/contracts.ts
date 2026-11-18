/**
 * Writer W1 claim-evidence audit contracts.
 *
 * W1 runs after Writer has a first draft. It audits the draft's claim-evidence map,
 * one claim at a time, and returns a report. It never edits the manuscript or the CSV,
 * never loads a tool, and never gates submission. A future trained head only implements
 * `ManuscriptAuditScorer`.
 */

import type { StateBudget } from '../framework/contracts.js';

export const MANUSCRIPT_AUDIT_DECISION_POINT = 'w1.claim-evidence-audit' as const;

export type ManuscriptAuditMode = 'shadow' | 'assist';

export type ManuscriptAuditFailureReason =
  | 'disabled'
  | 'not_authorized'
  | 'missing_claim_matrix'
  | 'empty_claim_matrix'
  | 'invalid_claim_matrix'
  | 'missing_manuscript'
  | 'unsupported_manuscript_format'
  | 'no_claims'
  | 'timeout'
  | 'bad_response';

export const CLAIM_SECTIONS = [
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
export type ClaimSection = (typeof CLAIM_SECTIONS)[number];

export const CLAIM_TYPES = [
  'observation',
  'association',
  'causal',
  'mechanism',
  'generalization',
  'methodological',
  'interpretation',
  'background',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const EVIDENCE_TYPES = ['citation', 'figure', 'table', 'result_file', 'dataset', 'none'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const WRITER_RELATIONS = [
  'supports',
  'partially_supports',
  'contradicts',
  'unrelated',
  'unverifiable',
  'not_checked',
] as const;
export type WriterRelation = (typeof WRITER_RELATIONS)[number];

export const WRITER_CLAIM_STATUSES = [
  'supported',
  'partially-supported',
  'unsupported',
  'needs-citation',
  'needs-data',
] as const;
export type WriterClaimStatus = (typeof WRITER_CLAIM_STATUSES)[number];

export const SUPPORT_RELATIONS = [
  'supports',
  'partially_supports',
  'contradicts',
  'unrelated',
  'unverifiable',
] as const;
export type SupportRelation = (typeof SUPPORT_RELATIONS)[number];

export const AUDIT_FINDINGS = [
  'no_issue_found',
  'check_support',
  'support_mismatch',
  'overclaim',
  'missing_evidence',
  'needs_data',
  'unverifiable',
  'stale_claim',
] as const;
export type AuditFinding = (typeof AUDIT_FINDINGS)[number];

export type Priority = 'P0' | 'P1' | 'P2' | 'none';

export const OVERCLAIM_FLAGS = ['scope', 'causality', 'certainty', 'generalization', 'temporal'] as const;
export type OverclaimFlag = (typeof OVERCLAIM_FLAGS)[number];

export interface ClaimEvidenceRow {
  claimId: string;
  section: ClaimSection;
  claimText: string;
  claimType: ClaimType;
  evidenceId: string;
  evidenceType: EvidenceType;
  evidenceLocator: string;
  evidenceQuote: string;
  evidenceScope: string;
  writerRelation: WriterRelation;
  writerStatus: WriterClaimStatus;
  notes: string;
}

export interface ParsedClaim {
  claimId: string;
  section: ClaimSection;
  claimText: string;
  claimType: ClaimType;
  writerStatus: WriterClaimStatus;
  rows: ClaimEvidenceRow[];
  /** Sections where the claim text was actually found in the manuscript. */
  placements: ClaimSection[];
  /** True when the claim text is not in the manuscript at all. */
  stale: boolean;
  /** True when the CSV section is not one of the actual placements. */
  sectionMismatch: boolean;
}

export interface ClaimMatrixLimits {
  maxClaims: number;
  maxEdges: number;
  maxQuoteChars: number;
}

export const DEFAULT_CLAIM_MATRIX_LIMITS: ClaimMatrixLimits = {
  maxClaims: 128,
  maxEdges: 512,
  maxQuoteChars: 800,
};

export interface PrecheckIssue {
  code: string;
  severity: 'P0' | 'P1' | 'P2';
  message: string;
  evidenceId?: string;
}

export interface PrecheckResult {
  citationKey: 'ok' | 'missing' | 'not_applicable' | 'not_checked';
  citationMetadata: 'ok' | 'invalid' | 'not_checked' | 'not_applicable';
  retraction: 'clear' | 'retracted' | 'unknown' | 'not_checked';
  locator: 'ok' | 'missing';
  quote: 'ok' | 'missing' | 'too_long' | 'not_applicable';
  inline: 'ok' | 'not_found' | 'style_unsupported' | 'not_checked' | 'not_applicable';
  issues: PrecheckIssue[];
  /** A blocking precheck issue makes the edge unverifiable rather than supported. */
  blocking: boolean;
}

export interface EvidenceAudit {
  evidenceId: string;
  evidenceType: EvidenceType;
  locator: string;
  quote: string;
  scope: string;
  relation: SupportRelation;
  /** Full relation scores for ledger/replay; never shown as probabilities in the report. */
  scores: Record<SupportRelation, number>;
  confidence: number;
  overclaim: OverclaimFlag[];
  precheck: PrecheckResult;
  reasons: string[];
  truncated: boolean;
  fallback: boolean;
}

export interface ClaimAudit {
  claimId: string;
  section: ClaimSection;
  claimText: string;
  claimType: ClaimType;
  writerStatus: WriterClaimStatus;
  finding: AuditFinding;
  priority: Priority;
  confidence: number;
  edges: EvidenceAudit[];
  reasons: string[];
  actions: string[];
  flags: string[];
  fallback: boolean;
}

export type ManuscriptAuditSummary = Record<AuditFinding, number> & {
  totalClaims: number;
  totalEdges: number;
  p0: number;
  p1: number;
  p2: number;
  fallback: number;
};

export interface ManuscriptAuditReport {
  requestId: string;
  runId: string;
  role: 'writer';
  decisionPoint: typeof MANUSCRIPT_AUDIT_DECISION_POINT;
  mode: ManuscriptAuditMode;
  manuscriptPath: string;
  matrixPath: string;
  referencesPath?: string;
  manuscriptHash: string;
  matrixHash: string;
  claims: ClaimAudit[];
  summary: ManuscriptAuditSummary;
  precheck: {
    citationKeysMissing: number;
    orphanCitations: number;
    figureRefsMissing: number;
    tableRefsMissing: number;
    staleClaims: number;
    styleUnsupported: boolean;
  };
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

export interface ManuscriptAuditThresholds {
  minConfidence: number;
  tauMismatch: number;
  tauPartial: number;
  overclaimConfidence: number;
  topIssues: number;
}

export interface ManuscriptPrecheckConfig {
  /** Off by default: manuscript text must not be sent to an external service. */
  online: boolean;
  maxQuoteChars: number;
}

export const DEFAULT_MANUSCRIPT_AUDIT_THRESHOLDS: ManuscriptAuditThresholds = {
  minConfidence: 0.55,
  tauMismatch: 0.65,
  tauPartial: 0.5,
  overclaimConfidence: 0.6,
  topIssues: 10,
};

export const DEFAULT_MANUSCRIPT_PRECHECK: ManuscriptPrecheckConfig = {
  online: false,
  maxQuoteChars: 800,
};

export interface ManuscriptAuditRequest {
  requestId: string;
  runId: string;
  role: 'writer';
  manuscriptPath: string;
  matrixPath: string;
  referencesPath?: string;
  manuscriptContent: string;
  matrixContent: string;
  referencesContent?: string;
  figures: string[];
  tables: string[];
  mode: ManuscriptAuditMode;
  budget: StateBudget;
  thresholds: ManuscriptAuditThresholds;
  precheck: ManuscriptPrecheckConfig;
  context: {
    sessionId: string;
    rolePromptVersion: string;
    rendererVersion: string;
  };
}

export interface ManuscriptAuditServiceInput {
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
  manuscriptPath: string;
  matrixPath: string;
  referencesPath?: string;
  manuscriptContent: string;
  matrixContent: string;
  referencesContent?: string;
  figures: string[];
  tables: string[];
}

export type ManuscriptAuditResult =
  | { ok: true; report: ManuscriptAuditReport; markdown: string }
  | { ok: false; reason: ManuscriptAuditFailureReason; message?: string };

export interface ManuscriptAuditSignal {
  scores: Record<SupportRelation, number>;
  overclaim: OverclaimFlag[];
  confidence: number;
  abstain: boolean;
  reasons: string[];
  latencyMs: number;
}

export interface ManuscriptAuditScorer {
  readonly modelVersion: string;
  /** Full state for heuristic/future heads; short state for the v0 support adapter. */
  readonly variant: 'full' | 'short';
  score(input: {
    claim: ParsedClaim;
    evidence: ClaimEvidenceRow;
    state: string;
    budget: StateBudget;
  }): Promise<ManuscriptAuditSignal>;
}

export interface ManuscriptAuditRunner {
  runManuscriptAudit(input: ManuscriptAuditServiceInput): Promise<ManuscriptAuditResult>;
}

export const MANUSCRIPT_AUDIT_MODES = ['off', 'shadow', 'assist'] as const;
export const MANUSCRIPT_AUDIT_DEFAULT_SCORER = 'heuristic';
export const MANUSCRIPT_AUDIT_DEFAULT_BUDGET = 'claim-audit';
export const MANUSCRIPT_AUDIT_POLICY_VERSION = 'w1-claim-evidence-audit-v1';
export const MANUSCRIPT_AUDIT_RENDERER_VERSION = 'w1.claim-evidence-audit.full-v1';
