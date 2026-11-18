import fs from 'node:fs';
import path from 'node:path';
import type {
  IssueAuditReport,
  IssueFinding,
  IssueTriageThresholds,
  PairwiseSummary,
  PremiseKind,
  PremiseStatus,
  IssuePremiseVerdict,
  IssuePriority,
  ReviewerRole,
  SeverityClaim,
} from './contracts.js';

export interface IssueAuditRecord {
  ts: string;
  requestId: string;
  runId: string;
  role: 'reviewer';
  decisionPoint: 'v1.issue-triage';
  mode: IssueAuditReport['mode'];
  documentPath: string;
  issuesPath: string;
  documentHash: string;
  issuesHash: string;
  issueCount: number;
  premiseCount: number;
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  budgetProfile: string;
  issues: Array<{
    issueId: string;
    severityClaim: SeverityClaim;
    premiseStatus: PremiseStatus;
    finding: IssueFinding;
    priority: IssuePriority;
    owner: ReviewerRole;
    ownerConfidence: number;
    ownerUndecided: boolean;
    rank?: number;
    pairwiseWins?: number;
    premises: Array<{
      premiseId: string;
      kind: PremiseKind;
      verdict: IssuePremiseVerdict;
      scores: Record<IssuePremiseVerdict, number>;
      confidence: number;
      flags: string[];
      fallback: boolean;
    }>;
  }>;
  pairwise: PairwiseSummary;
  summary: IssueAuditReport['summary'];
  thresholds: IssueTriageThresholds;
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

/** Append-only audit ledger; diagnostics only, never allowed to fail a Reviewer decision. */
export interface IssueAuditLedger {
  append(record: IssueAuditRecord): void;
}

export class JsonlIssueAuditLedger implements IssueAuditLedger {
  constructor(private readonly file: string = '') {}

  append(record: IssueAuditRecord): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // The report is the product; a full disk must not take the Reviewer run down.
    }
  }
}

export function toIssueAuditRecord(
  report: IssueAuditReport,
  context: { budgetProfile: string; thresholds: IssueTriageThresholds },
): IssueAuditRecord {
  return {
    ts: new Date().toISOString(),
    requestId: report.requestId,
    runId: report.runId,
    role: report.role,
    decisionPoint: report.decisionPoint,
    mode: report.mode,
    documentPath: report.documentPath,
    issuesPath: report.issuesPath,
    documentHash: report.documentHash,
    issuesHash: report.issuesHash,
    issueCount: report.summary.totalIssues,
    premiseCount: report.summary.totalPremises,
    modelVersion: report.modelVersion,
    policyVersion: report.policyVersion,
    rendererVersion: report.rendererVersion,
    budgetProfile: context.budgetProfile,
    issues: report.issues.map((issue) => ({
      issueId: issue.issueId,
      severityClaim: issue.severityClaim,
      premiseStatus: issue.premiseStatus,
      finding: issue.finding,
      priority: issue.priority,
      owner: issue.owner.owner,
      ownerConfidence: issue.owner.confidence,
      ownerUndecided: issue.owner.undecided,
      ...(issue.rank !== undefined ? { rank: issue.rank } : {}),
      ...(issue.pairwiseWins !== undefined ? { pairwiseWins: issue.pairwiseWins } : {}),
      premises: issue.premises.map((premise) => ({
        premiseId: premise.premiseId,
        kind: premise.kind,
        verdict: premise.verdict,
        scores: premise.scores,
        confidence: premise.confidence,
        flags: premise.flags,
        fallback: premise.fallback,
      })),
    })),
    pairwise: report.pairwise,
    summary: report.summary,
    thresholds: context.thresholds,
    fallback: report.fallback,
    ...(report.fallbackReason ? { fallbackReason: report.fallbackReason } : {}),
    latencyMs: report.latencyMs,
  };
}
