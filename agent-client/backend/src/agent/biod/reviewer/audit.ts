import { createHash } from 'node:crypto';
import {
  ISSUE_AUDIT_POLICY_VERSION,
  ISSUE_AUDIT_RENDERER_VERSION,
  ISSUE_AUDIT_SHORT_RENDERER_VERSION,
  MAX_ISSUE_MATRIX_LIMITS,
  DEFAULT_ISSUE_MATRIX_LIMITS,
  type IssueAudit,
  type IssueAuditReport,
  type IssueAuditRequest,
  type IssueAuditResult,
  type IssueAuditSummary,
  type IssueQueueEntry,
  type IssueTriageScorer,
  type OwnerSignal,
  type PairSignal,
  type ParsedIssue,
  type PremiseAuditResult,
  type PremiseSignal,
  type PremiseStatus,
} from './contracts.js';
import { parseDocument, type ParsedDocument } from './document.js';
import { parseIssueMatrix } from './issues.js';
import { decideIssue, decideOwner, decidePremise, buildQueue } from './policy.js';
import { rankByPairwise, type PairComparison, type PairwiseOutcome } from './rank.js';
import { runIssuePrecheck, summarizePrecheck, type IssuePrecheck } from './precheck.js';
import {
  fitIssueAuditBudget,
  renderOwnerState,
  renderPairState,
  renderPremiseState,
} from './renderer.js';
import { renderIssueAuditReport } from './report.js';

export interface IssueAuditDeps {
  scorer: IssueTriageScorer;
}

/**
 * Run Reviewer V1. Parsing/precheck/scoring/policy never throw out of this function: a
 * parse failure is a typed result, a single bad premise becomes `unresolved`, and issues
 * beyond the scoring budget are reported as `deferred` instead of being dropped.
 */
export async function auditIssues(
  request: IssueAuditRequest,
  deps: IssueAuditDeps,
): Promise<IssueAuditResult> {
  const started = Date.now();
  const limits = request.budget.profile === 'issue-audit-max'
    ? MAX_ISSUE_MATRIX_LIMITS
    : DEFAULT_ISSUE_MATRIX_LIMITS;
  const parsed = parseIssueMatrix(request.issuesContent, limits);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, message: parsed.message };
  }
  if (!request.documentContent.trim()) {
    return { ok: false, reason: 'missing_manuscript', message: 'the reviewed document is empty' };
  }

  const document = parseDocument(request.documentContent);
  const maxPassageChars = request.budget.profile === 'issue-audit-max' ? 4000 : 1200;
  const checks = runIssuePrecheck({
    issues: parsed.issues,
    document,
    duplicateThreshold: request.thresholds.duplicateThreshold,
    maxPassageChars,
  });
  if (!checks.length) {
    return { ok: false, reason: 'no_issues', message: 'issues.csv has no issues' };
  }

  const maxScoredIssues = Math.max(0, Math.floor(request.thresholds.maxScoredIssues));
  const scorable = checks.slice(0, maxScoredIssues);
  const deferredIssues = checks.slice(maxScoredIssues).map((check) => deferredAudit(check.issue));

  const audits: IssueAudit[] = [];
  for (const check of scorable) {
    try {
      audits.push(await auditIssue(check, request, deps.scorer));
    } catch (error) {
      audits.push(failedAudit(check.issue, error));
    }
  }

  const pairwise = await runPairwise(audits, request, document, deps.scorer);
  const all = [...audits, ...deferredIssues];
  const queue: IssueQueueEntry[] = buildQueue(all);
  const summary = summarize(all, checks);
  const report: IssueAuditReport = {
    requestId: request.requestId,
    runId: request.runId,
    role: 'reviewer',
    decisionPoint: 'v1.issue-triage',
    mode: request.mode,
    documentPath: request.documentPath,
    issuesPath: request.issuesPath,
    documentHash: hash(request.documentContent),
    issuesHash: hash(request.issuesContent),
    issues: all,
    queue,
    summary,
    pairwise: {
      candidates: pairwise.ranked.length,
      comparisons: pairwise.comparisons.length,
      truncated: pairwise.truncated,
    },
    modelVersion: deps.scorer.modelVersion,
    policyVersion: ISSUE_AUDIT_POLICY_VERSION,
    rendererVersion: deps.scorer.variant === 'short' ? ISSUE_AUDIT_SHORT_RENDERER_VERSION : ISSUE_AUDIT_RENDERER_VERSION,
    fallback: all.some((issue) => issue.fallback),
    ...(all.some((issue) => issue.fallback) ? { fallbackReason: 'one or more premises could not be scored' } : {}),
    latencyMs: Date.now() - started,
  };
  return { ok: true, report, markdown: renderIssueAuditReport(report) };
}

async function auditIssue(
  check: IssuePrecheck,
  request: IssueAuditRequest,
  scorer: IssueTriageScorer,
): Promise<IssueAudit> {
  const premises: PremiseAuditResult[] = [];
  for (const premiseCheck of check.premises) {
    premises.push(await auditPremise(premiseCheck, check, request, scorer));
  }
  const premiseStatus = aggregateStatus(premises);
  const ownerState = renderOwnerState({ issue: check.issue, premiseStatus });
  const owner = decideOwner({
    issue: check.issue,
    premiseStatus,
    signal: await ownerSignal(scorer, check.issue, premiseStatus, ownerState.state, request),
    thresholds: request.thresholds,
  });
  return decideIssue({
    issue: check.issue,
    premises,
    owner,
    precheckFlags: check.flags,
    duplicates: check.duplicates,
    thresholds: request.thresholds,
  });
}

async function auditPremise(
  premiseCheck: IssuePrecheck['premises'][number],
  check: IssuePrecheck,
  request: IssueAuditRequest,
  scorer: IssueTriageScorer,
): Promise<PremiseAuditResult> {
  const premise = premiseCheck.premise;
  const needsScorer = premise.premiseKind === 'passage' || premise.premiseKind === 'conflict';
  const anchorMissing = premiseCheck.flags.includes('anchor_missing')
    || premiseCheck.flags.includes('anchor_missing_2');
  // Conflict premises compare the anchor paragraphs themselves; a ±1 paragraph window would
  // pad each side with the other passage and flatten the contrast.
  const passage = premise.premiseKind === 'conflict'
    ? premiseCheck.anchor?.anchorText ?? premiseCheck.anchor?.passage
    : premiseCheck.anchor?.passage;
  const passage2 = premiseCheck.anchor2
    ? premiseCheck.anchor2.anchorText ?? premiseCheck.anchor2.passage
    : undefined;

  if (!needsScorer || anchorMissing || !passage) {
    return decidePremise({
      check: premiseCheck,
      ...(passage ? { passage } : {}),
      ...(passage2 ? { passage2 } : {}),
      thresholds: request.thresholds,
    });
  }

  const rendered = renderPremiseState({
    issue: check.issue,
    premise,
    passage,
    ...(passage2 ? { passage2 } : {}),
    variant: scorer.variant,
  });
  const fitted = fitIssueAuditBudget(rendered.state, request.budget);
  try {
    const signal = await withTimeout(
      scorer.scorePremise({
        issue: check.issue,
        premise,
        passage,
        ...(passage2 ? { passage2 } : {}),
        state: fitted.state,
        budget: request.budget,
      }),
      request.budget.timeoutMs,
    );
    const result = decidePremise({ check: premiseCheck, signal, passage, ...(passage2 ? { passage2 } : {}), thresholds: request.thresholds });
    return {
      ...result,
      truncated: result.truncated || rendered.truncated || fitted.truncated,
    };
  } catch (error) {
    const fallback = decidePremise({
      check: premiseCheck,
      signal: fallbackPremiseSignal(error),
      passage,
      ...(passage2 ? { passage2 } : {}),
      thresholds: request.thresholds,
    });
    return {
      ...fallback,
      verdict: 'unresolved',
      confidence: 0,
      flags: [...new Set([...fallback.flags, 'premise_fallback'])],
      reasons: [
        error instanceof TimeoutError ? 'premise scorer timed out' : `premise scorer failed: ${describe(error)}`,
        ...(rendered.truncated || fitted.truncated ? ['state was truncated'] : []),
      ],
      fallback: true,
    };
  }
}

async function ownerSignal(
  scorer: IssueTriageScorer,
  issue: ParsedIssue,
  premiseStatus: PremiseStatus,
  state: string,
  request: IssueAuditRequest,
): Promise<OwnerSignal> {
  const fitted = fitIssueAuditBudget(state, request.budget);
  try {
    return await withTimeout(
      scorer.scoreOwner({ issue, premiseStatus, state: fitted.state, budget: request.budget }),
      request.budget.timeoutMs,
    );
  } catch (error) {
    return {
      scores: { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 1 },
      confidence: 0,
      abstain: true,
      reasons: [error instanceof TimeoutError ? 'owner scorer timed out' : `owner scorer failed: ${describe(error)}`],
      latencyMs: 0,
    };
  }
}

async function runPairwise(
  audits: IssueAudit[],
  request: IssueAuditRequest,
  document: ParsedDocument,
  scorer: IssueTriageScorer,
): Promise<PairwiseOutcome> {
  const byId = new Map(audits.map((audit) => [audit.issueId, audit]));
  const candidates = audits.filter(
    (audit) => audit.severityClaim === 'blocking'
      && audit.premiseStatus !== 'premise_contradicted'
      && !audit.deferred,
  );
  if (candidates.length < 2) {
    return { ranked: [], comparisons: [], truncated: false, deferred: [] };
  }
  // Keep the parsed issue shape for the scorer/renderer; audits carry the same identity.
  const candidateIssues: ParsedIssue[] = candidates.map((audit) => ({
    issueId: audit.issueId,
    section: audit.section,
    issueText: audit.issueText,
    issueType: audit.issueType,
    severityClaim: audit.severityClaim,
    ...(audit.ownerSuggested ? { ownerSuggested: audit.ownerSuggested } : {}),
    premises: [],
    duplicates: audit.duplicates,
  }));

  const outcome = await rankByPairwise({
    issues: candidateIssues,
    maxCandidates: request.thresholds.maxPairwiseIssues,
    compare: async (a, b) => comparePair(a, b, document, scorer, request),
  });

  for (const entry of outcome.ranked) {
    const audit = byId.get(entry.issueId);
    if (!audit) continue;
    audit.rank = entry.rank;
    audit.pairwiseWins = entry.wins;
  }
  for (const issueId of outcome.deferred) {
    const audit = byId.get(issueId);
    if (!audit) continue;
    audit.flags.push('pairwise_deferred');
    if (audit.priority === 'none') audit.priority = 'P2';
  }
  return outcome;
}

async function comparePair(
  a: ParsedIssue,
  b: ParsedIssue,
  document: ParsedDocument,
  scorer: IssueTriageScorer,
  request: IssueAuditRequest,
): Promise<PairComparison> {
  const rendered = renderPairState({ a, b, title: document.title });
  const fitted = fitIssueAuditBudget(rendered.state, request.budget);
  try {
    const signal = await withTimeout(
      scorer.scorePair({ a, b, title: document.title, state: fitted.state, budget: request.budget }),
      request.budget.timeoutMs,
    );
    return {
      a: a.issueId,
      b: b.issueId,
      verdict: signal.abstain ? 'tie' : topPairVerdict(signal),
      confidence: signal.confidence,
      reasons: signal.reasons,
      fallback: false,
    };
  } catch (error) {
    return {
      a: a.issueId,
      b: b.issueId,
      verdict: 'tie',
      confidence: 0,
      reasons: [error instanceof TimeoutError ? 'pair scorer timed out' : `pair scorer failed: ${describe(error)}`],
      fallback: true,
    };
  }
}

function deferredAudit(issue: ParsedIssue): IssueAudit {
  return {
    issueId: issue.issueId,
    section: issue.section,
    issueText: issue.issueText,
    issueType: issue.issueType,
    severityClaim: issue.severityClaim,
    ...(issue.ownerSuggested ? { ownerSuggested: issue.ownerSuggested } : {}),
    premiseStatus: 'no_premise',
    finding: 'deferred',
    priority: 'none',
    premises: [],
    owner: {
      owner: 'pi',
      confidence: 0,
      scores: { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 1 },
      alternatives: [],
      undecided: true,
      disagreesWithSuggestion: false,
      reasons: ['not audited: maxScoredIssues reached'],
      fallback: false,
    },
    flags: ['deferred'],
    reasons: ['not audited: maxScoredIssues reached'],
    actions: ['no_action'],
    duplicates: issue.duplicates,
    fallback: false,
    deferred: true,
  };
}

function failedAudit(issue: ParsedIssue, error: unknown): IssueAudit {
  return {
    issueId: issue.issueId,
    section: issue.section,
    issueText: issue.issueText,
    issueType: issue.issueType,
    severityClaim: issue.severityClaim,
    ...(issue.ownerSuggested ? { ownerSuggested: issue.ownerSuggested } : {}),
    premiseStatus: 'premise_unresolved',
    finding: 'unverifiable',
    priority: 'P1',
    premises: [],
    owner: {
      owner: 'pi',
      confidence: 0,
      scores: { searcher: 0, researcher: 0, writer: 0, reviewer: 0, pi: 1 },
      alternatives: [],
      undecided: true,
      disagreesWithSuggestion: false,
      reasons: ['issue audit failed'],
      fallback: true,
    },
    flags: ['audit_failed'],
    reasons: [`issue audit failed: ${describe(error)}`],
    actions: ['re_read_passage'],
    duplicates: issue.duplicates,
    fallback: true,
    deferred: false,
  };
}

function summarize(
  issues: IssueAudit[],
  checks: IssuePrecheck[],
): IssueAuditSummary {
  const precheck = summarizePrecheck(checks);
  const premises = issues.flatMap((issue) => issue.premises);
  const checkable = premises.filter((premise) => premise.kind !== 'none');
  return {
    totalIssues: issues.length,
    totalPremises: premises.length,
    p0: issues.filter((issue) => issue.priority === 'P0').length,
    p1: issues.filter((issue) => issue.priority === 'P1').length,
    p2: issues.filter((issue) => issue.priority === 'P2').length,
    premisesHold: checkable.filter((premise) => premise.verdict === 'holds').length,
    premiseContradicted: checkable.filter((premise) => premise.verdict === 'contradicted').length,
    premiseUnresolved: checkable.filter((premise) => premise.verdict === 'unresolved').length,
    noPremise: issues.filter((issue) => issue.finding === 'no_checkable_premise').length,
    anchorsMissing: precheck.anchorsMissing,
    locatorMissing: precheck.locatorMissing,
    sectionsMissing: precheck.sectionsMissing,
    absenceChecks: precheck.absenceChecks,
    absenceHits: precheck.absenceHits,
    duplicates: precheck.duplicateIssues,
    ownerUndecided: issues.filter((issue) => issue.owner.undecided).length,
    ownerDisagreements: issues.filter((issue) => issue.owner.disagreesWithSuggestion).length,
    deferred: issues.filter((issue) => issue.deferred).length,
    fallback: issues.filter((issue) => issue.fallback).length,
  };
}

function aggregateStatus(premises: PremiseAuditResult[]): PremiseStatus {
  if (!premises.length || premises.every((premise) => premise.kind === 'none')) return 'no_premise';
  if (premises.some((premise) => premise.verdict === 'contradicted')) return 'premise_contradicted';
  if (premises.some((premise) => premise.verdict === 'unresolved')) return 'premise_unresolved';
  return 'premises_hold';
}

function topPairVerdict(signal: PairSignal): 'a' | 'b' | 'tie' {
  const candidates: Array<'a' | 'b' | 'tie'> = ['a', 'b', 'tie'];
  let best: 'a' | 'b' | 'tie' = 'tie';
  for (const verdict of candidates) {
    if ((signal.scores[verdict] ?? 0) > (signal.scores[best] ?? 0)) best = verdict;
  }
  return best;
}

function fallbackPremiseSignal(error: unknown): PremiseSignal {
  return {
    scores: { holds: 0, contradicted: 0, unresolved: 1 },
    confidence: 0,
    abstain: true,
    reasons: [error instanceof TimeoutError ? 'premise scorer timed out' : `premise scorer failed: ${describe(error)}`],
    latencyMs: 0,
  };
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TimeoutError extends Error {
  constructor() {
    super('issue-triage scorer timed out');
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
