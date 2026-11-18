import { createHash } from 'node:crypto';
import {
  AUDIT_FINDINGS,
  MANUSCRIPT_AUDIT_POLICY_VERSION,
  MANUSCRIPT_AUDIT_RENDERER_VERSION,
  SUPPORT_RELATIONS,
  type AuditFinding,
  type ClaimAudit,
  type ClaimEvidenceRow,
  type EvidenceAudit,
  type ManuscriptAuditReport,
  type ManuscriptAuditRequest,
  type ManuscriptAuditResult,
  type ManuscriptAuditScorer,
  type ManuscriptAuditSignal,
  type ManuscriptAuditSummary,
  type ParsedClaim,
  type PrecheckResult,
  type SupportRelation,
} from './contracts.js';
import { parseBibTeX } from './bib.js';
import { parseClaimMatrix } from './claim-matrix.js';
import { annotateClaims, parseManuscript } from './manuscript.js';
import { decideClaim } from './policy.js';
import { orphanCitationKeys, runPrecheck } from './precheck.js';
import { fitManuscriptAuditBudget, renderManuscriptAuditState } from './renderer.js';
import { renderManuscriptAuditReport } from './report.js';

export interface ManuscriptAuditDeps {
  scorer: ManuscriptAuditScorer;
}

/**
 * Run the W1 audit. Parsing/precheck/scoring/policy never throw out of this function:
 * a parse failure is a typed result, and a single bad claim becomes `unverifiable`
 * instead of taking down the report.
 */
export async function auditManuscript(
  request: ManuscriptAuditRequest,
  deps: ManuscriptAuditDeps,
): Promise<ManuscriptAuditResult> {
  const started = Date.now();
  const maxClaims = request.budget.profile === 'claim-audit-max' ? 512 : 128;
  const maxEdges = request.budget.profile === 'claim-audit-max' ? 4096 : 512;
  const parsedMatrix = parseClaimMatrix(request.matrixContent, {
    maxClaims,
    maxEdges,
    maxQuoteChars: request.precheck.maxQuoteChars,
  });
  if (!parsedMatrix.ok) {
    return { ok: false, reason: parsedMatrix.reason, message: parsedMatrix.message };
  }
  if (!request.manuscriptContent.trim()) {
    return { ok: false, reason: 'missing_manuscript', message: 'manuscript.md is empty' };
  }

  const manuscript = parseManuscript(request.manuscriptContent);
  const bib = parseBibTeX(request.referencesContent ?? '');
  const claims = annotateClaims(parsedMatrix.claims, manuscript);
  if (!claims.length) {
    return { ok: false, reason: 'no_claims', message: 'claim-evidence.csv has no claims' };
  }

  const audits: ClaimAudit[] = [];
  for (const claim of claims) {
    try {
      audits.push(await auditClaim(claim, request, manuscript, bib, deps.scorer));
    } catch (error) {
      audits.push(failedClaim(claim, error));
    }
  }

  const summary = summarize(audits);
  const orphanCitations = orphanCitationKeys(manuscript, bib);
  const precheckIssues = audits.flatMap((audit) => audit.edges.flatMap((edge) => edge.precheck.issues));
  const report: ManuscriptAuditReport = {
    requestId: request.requestId,
    runId: request.runId,
    role: 'writer',
    decisionPoint: 'w1.claim-evidence-audit',
    mode: request.mode,
    manuscriptPath: request.manuscriptPath,
    matrixPath: request.matrixPath,
    ...(request.referencesPath ? { referencesPath: request.referencesPath } : {}),
    manuscriptHash: hash(request.manuscriptContent),
    matrixHash: hash(request.matrixContent),
    claims: audits,
    summary,
    precheck: {
      citationKeysMissing: precheckIssues.filter((issue) => issue.code === 'citation_key_missing' || issue.code === 'citation_not_in_bib').length,
      orphanCitations: orphanCitations.length,
      figureRefsMissing: precheckIssues.filter((issue) => issue.code === 'figure_ref_missing').length,
      tableRefsMissing: precheckIssues.filter((issue) => issue.code === 'table_ref_missing').length,
      staleClaims: audits.filter((audit) => audit.finding === 'stale_claim').length,
      styleUnsupported: manuscript.citationStyle === 'numeric',
    },
    modelVersion: deps.scorer.modelVersion,
    policyVersion: MANUSCRIPT_AUDIT_POLICY_VERSION,
    rendererVersion: deps.scorer.variant === 'short' ? 'w1.claim-evidence-audit.short-v1' : MANUSCRIPT_AUDIT_RENDERER_VERSION,
    fallback: audits.some((audit) => audit.fallback),
    ...(audits.some((audit) => audit.fallback) ? { fallbackReason: 'one or more claims could not be scored' } : {}),
    latencyMs: Date.now() - started,
  };
  return { ok: true, report, markdown: renderManuscriptAuditReport(report) };
}

async function auditClaim(
  claim: ParsedClaim,
  request: ManuscriptAuditRequest,
  manuscript: ReturnType<typeof parseManuscript>,
  bib: ReturnType<typeof parseBibTeX>,
  scorer: ManuscriptAuditScorer,
): Promise<ClaimAudit> {
  if (claim.stale) return decideClaim({ claim, edges: [], thresholds: request.thresholds });

  const edges: EvidenceAudit[] = [];
  for (const row of claim.rows) {
    const precheck = runPrecheck({
      claim,
      evidence: row,
      manuscript,
      bib,
      figures: request.figures,
      tables: request.tables,
      maxQuoteChars: request.precheck.maxQuoteChars,
      referencesAvailable: Boolean(request.referencesContent?.trim()),
    });

    if (row.evidenceType === 'none') {
      edges.push({
        evidenceId: row.evidenceId,
        evidenceType: row.evidenceType,
        locator: row.evidenceLocator,
        quote: row.evidenceQuote,
        scope: row.evidenceScope,
        relation: 'unverifiable',
        scores: zeroScores('unverifiable'),
        confidence: 0,
        overclaim: [],
        precheck,
        reasons: ['no evidence is attached'],
        truncated: false,
        fallback: false,
      });
      continue;
    }

    if (precheck.blocking) {
      edges.push({
        evidenceId: row.evidenceId,
        evidenceType: row.evidenceType,
        locator: row.evidenceLocator,
        quote: row.evidenceQuote,
        scope: row.evidenceScope,
        relation: 'unverifiable',
        scores: zeroScores('unverifiable'),
        confidence: 0,
        overclaim: [],
        precheck,
        reasons: [`precheck blocked: ${precheck.issues.map((issue) => issue.code).join(', ')}`],
        truncated: false,
        fallback: false,
      });
      continue;
    }

    const rendered = renderManuscriptAuditState(claim, row, scorer.variant);
    const fitted = fitManuscriptAuditBudget(rendered.state, request.budget);
    try {
      const signal = await withTimeout(
        scorer.score({ claim, evidence: row, state: fitted.state, budget: request.budget }),
        request.budget.timeoutMs,
      );
      edges.push({
        evidenceId: row.evidenceId,
        evidenceType: row.evidenceType,
        locator: row.evidenceLocator,
        quote: row.evidenceQuote,
        scope: row.evidenceScope,
        relation: signal.abstain ? 'unverifiable' : topRelation(signal.scores),
        scores: signal.scores,
        confidence: signal.confidence,
        overclaim: signal.overclaim,
        precheck,
        reasons: signal.reasons,
        truncated: fitted.truncated,
        fallback: false,
      });
    } catch (error) {
      edges.push(fallbackEdge(row, precheck, error, fitted.truncated));
    }
  }

  return decideClaim({ claim, edges, thresholds: request.thresholds });
}

function fallbackEdge(
  row: ClaimEvidenceRow,
  precheck: PrecheckResult,
  error: unknown,
  truncated: boolean,
): EvidenceAudit {
  return {
    evidenceId: row.evidenceId,
    evidenceType: row.evidenceType,
    locator: row.evidenceLocator,
    quote: row.evidenceQuote,
    scope: row.evidenceScope,
    relation: 'unverifiable',
    scores: zeroScores('unverifiable'),
    confidence: 0,
    overclaim: [],
    precheck,
    reasons: [
      error instanceof TimeoutError ? 'scorer timeout' : `scorer error: ${error instanceof Error ? error.message : String(error)}`,
      ...(truncated ? ['state was truncated'] : []),
    ],
    truncated,
    fallback: true,
  };
}

function failedClaim(claim: ParsedClaim, error: unknown): ClaimAudit {
  return {
    claimId: claim.claimId,
    section: claim.section,
    claimText: claim.claimText,
    claimType: claim.claimType,
    writerStatus: claim.writerStatus,
    finding: 'unverifiable',
    priority: 'P1',
    confidence: 0,
    edges: [],
    reasons: [`claim audit failed: ${error instanceof Error ? error.message : String(error)}`],
    actions: ['read_source'],
    flags: ['audit_failed'],
    fallback: true,
  };
}

function summarize(claims: ClaimAudit[]): ManuscriptAuditSummary {
  const summary = Object.fromEntries(AUDIT_FINDINGS.map((finding) => [finding, 0])) as Record<AuditFinding, number>;
  for (const claim of claims) summary[claim.finding] += 1;
  return {
    ...summary,
    totalClaims: claims.length,
    totalEdges: claims.reduce((sum, claim) => sum + claim.edges.length, 0),
    p0: claims.filter((claim) => claim.priority === 'P0').length,
    p1: claims.filter((claim) => claim.priority === 'P1').length,
    p2: claims.filter((claim) => claim.priority === 'P2').length,
    fallback: claims.filter((claim) => claim.fallback).length,
  };
}

function topRelation(scores: Record<SupportRelation, number>): SupportRelation {
  let best: SupportRelation = 'unverifiable';
  for (const relation of SUPPORT_RELATIONS) {
    if (scores[relation] > scores[best]) best = relation;
  }
  return best;
}

function zeroScores(relation: SupportRelation): Record<SupportRelation, number> {
  return {
    supports: relation === 'supports' ? 1 : 0,
    partially_supports: relation === 'partially_supports' ? 1 : 0,
    contradicts: relation === 'contradicts' ? 1 : 0,
    unrelated: relation === 'unrelated' ? 1 : 0,
    unverifiable: relation === 'unverifiable' ? 1 : 0,
  };
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

class TimeoutError extends Error {
  constructor() {
    super('manuscript audit scorer timed out');
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
