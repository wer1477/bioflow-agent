import fs from 'node:fs';
import path from 'node:path';
import type {
  AuditFinding,
  ManuscriptAuditReport,
  OverclaimFlag,
  Priority,
  SupportRelation,
} from './contracts.js';

export interface ManuscriptAuditRecord {
  ts: string;
  requestId: string;
  runId: string;
  role: 'writer';
  decisionPoint: 'w1.claim-evidence-audit';
  mode: ManuscriptAuditReport['mode'];
  manuscriptPath: string;
  matrixPath: string;
  referencesPath?: string;
  manuscriptHash: string;
  matrixHash: string;
  claimCount: number;
  edgeCount: number;
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  claims: Array<{
    claimId: string;
    finding: AuditFinding;
    priority: Priority;
    edges: Array<{
      evidenceId: string;
      relation: string;
      relationScores: Record<SupportRelation, number>;
      confidence: number;
      overclaim: OverclaimFlag[];
      precheckCodes: string[];
      truncated: boolean;
      fallback: boolean;
      order: number;
    }>;
  }>;
  summary: ManuscriptAuditReport['summary'];
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

export interface ManuscriptAuditLedger {
  append(record: ManuscriptAuditRecord): void;
}

export class JsonlManuscriptAuditLedger implements ManuscriptAuditLedger {
  constructor(private readonly file: string = '') {}

  append(record: ManuscriptAuditRecord): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // The report is the product; a full disk must not take the Writer run down.
    }
  }
}

export function toManuscriptAuditRecord(report: ManuscriptAuditReport): ManuscriptAuditRecord {
  return {
    ts: new Date().toISOString(),
    requestId: report.requestId,
    runId: report.runId,
    role: report.role,
    decisionPoint: report.decisionPoint,
    mode: report.mode,
    manuscriptPath: report.manuscriptPath,
    matrixPath: report.matrixPath,
    ...(report.referencesPath ? { referencesPath: report.referencesPath } : {}),
    manuscriptHash: report.manuscriptHash,
    matrixHash: report.matrixHash,
    claimCount: report.summary.totalClaims,
    edgeCount: report.summary.totalEdges,
    modelVersion: report.modelVersion,
    policyVersion: report.policyVersion,
    rendererVersion: report.rendererVersion,
    claims: report.claims.map((claim) => ({
      claimId: claim.claimId,
      finding: claim.finding,
      priority: claim.priority,
      edges: claim.edges.map((edge, index) => ({
        evidenceId: edge.evidenceId,
        relation: edge.relation,
        relationScores: edge.scores,
        confidence: edge.confidence,
        overclaim: edge.overclaim,
        precheckCodes: edge.precheck.issues.map((issue) => issue.code),
        truncated: edge.truncated,
        fallback: edge.fallback,
        order: index,
      })),
    })),
    summary: report.summary,
    fallback: report.fallback,
    ...(report.fallbackReason ? { fallbackReason: report.fallbackReason } : {}),
    latencyMs: report.latencyMs,
  };
}
