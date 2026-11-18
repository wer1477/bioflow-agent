import { createHash } from 'node:crypto';
import { buildStepCandidates } from './candidates.js';
import {
  type PlanAuditRequest,
  type PlanAuditScorer,
  type PlanAuditSignal,
  type PlanAuditStepTrace,
  type PlanAuditSummary,
  type PlanAuditThresholds,
  type PlanAuditTrace,
  type PlanAuditReport,
  type PlanStep,
  type PlanToolCandidate,
  type StepAudit,
} from './contracts.js';
import { decidePlanStep } from './policy.js';
import { fitPlanAuditBudget, renderPlanAuditState } from './renderer.js';

/**
 * Runs one audit pass over all steps. Every step is isolated: a scorer timeout or a bad
 * candidate row turns into an `uncertain` step, never into a failed Researcher run.
 */

export interface AuditPlanOptions {
  scorer: PlanAuditScorer;
  thresholds: PlanAuditThresholds;
}

export interface AuditPlanResult {
  report: PlanAuditReport;
  trace: PlanAuditTrace;
}

export async function auditPlan(
  request: PlanAuditRequest,
  options: AuditPlanOptions,
): Promise<AuditPlanResult> {
  const started = Date.now();
  const steps: StepAudit[] = [];
  const traces: PlanAuditStepTrace[] = [];

  for (const step of request.steps) {
    const set = buildStepCandidates(step, request.tools, request.prefilter);
    const rendered = renderPlanAuditState(step, set.candidates, request.budget, options.scorer.variant);
    const fitted = fitPlanAuditBudget(rendered, set.candidates, request.budget);
    const candidates = fitted.candidates;
    const signal = await scoreWithTimeout(
      options.scorer,
      step,
      fitted.state,
      candidates,
      request.budget.timeoutMs,
      request.budget,
    );

    let audit: StepAudit;
    try {
      audit = decidePlanStep(step, signal, { ...set, candidates }, options.thresholds);
    } catch (error) {
      audit = uncertainStep(step, set.currentToolKind, set.currentToolId, signal, candidates, error);
    }
    if (fitted.truncated) audit = { ...audit, flags: unique([...audit.flags, 'state_truncated']) };
    steps.push(audit);
    traces.push({
      stepId: step.id,
      state: fitted.state,
      stateHash: sha256(fitted.state),
      stateChars: fitted.state.length,
      truncated: fitted.truncated,
      candidates: candidates.map((candidate) => candidate.id),
      scores: signal.scores,
      prefilteredOut: set.prefilteredOut,
      ...(signal.masked?.length ? { masked: signal.masked } : {}),
    });
  }

  const summary = summarize(steps);
  const fallback = steps.some((step) => step.fallback);
  const report: PlanAuditReport = {
    requestId: request.requestId,
    runId: request.runId,
    role: 'researcher',
    decisionPoint: 'r1.plan-audit',
    mode: request.mode,
    planPath: request.planPath,
    planHash: request.planHash,
    steps,
    summary,
    modelVersion: options.scorer.modelVersion,
    policyVersion: 'r1-plan-audit-policy-v1',
    rendererVersion: request.context.rendererVersion || `r1.plan-audit.${options.scorer.variant}-v1`,
    fallback,
    ...(fallback ? { fallbackReason: steps.every((step) => step.fallback) ? 'all_steps_uncertain' : 'partial_steps_uncertain' } : {}),
    latencyMs: Date.now() - started,
  };
  return { report, trace: { steps: traces } };
}

async function scoreWithTimeout(
  scorer: PlanAuditScorer,
  step: PlanStep,
  state: string,
  candidates: PlanToolCandidate[],
  timeoutMs: number,
  budget: PlanAuditRequest['budget'],
): Promise<PlanAuditSignal> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return safeScore(scorer, step, state, candidates, budget);
  }
  return new Promise<PlanAuditSignal>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(abstainSignal('scorer_timeout'));
    }, timeoutMs);
    safeScore(scorer, step, state, candidates, budget).then((signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(signal);
    });
  });
}

async function safeScore(
  scorer: PlanAuditScorer,
  step: PlanStep,
  state: string,
  candidates: PlanToolCandidate[],
  budget: PlanAuditRequest['budget'],
): Promise<PlanAuditSignal> {
  try {
    const signal = await scorer.score({ step, state, candidates, budget });
    if (!signal || typeof signal !== 'object' || !signal.scores || typeof signal.scores !== 'object') {
      return abstainSignal('scorer_bad_response');
    }
    const scores: Record<string, number> = {};
    for (const [id, value] of Object.entries(signal.scores)) {
      if (typeof value === 'number' && Number.isFinite(value)) scores[id] = value;
    }
    return {
      scores,
      confidence: Number.isFinite(signal.confidence) ? Math.max(0, Math.min(1, signal.confidence)) : 0,
      abstain: Boolean(signal.abstain),
      reasons: Array.isArray(signal.reasons) ? signal.reasons.map(String) : [],
      latencyMs: Number.isFinite(signal.latencyMs) ? signal.latencyMs : 0,
      ...(Array.isArray(signal.masked) ? { masked: signal.masked.map(String) } : {}),
    };
  } catch (error) {
    return abstainSignal(error instanceof Error ? error.message : 'scorer_exception');
  }
}

function uncertainStep(
  step: PlanStep,
  currentToolKind: StepAudit['currentToolKind'],
  currentToolId: string | undefined,
  signal: PlanAuditSignal,
  candidates: PlanToolCandidate[],
  error: unknown,
): StepAudit {
  return {
    stepId: step.id,
    goal: step.goal,
    ...(currentToolId ? { currentToolId } : {}),
    currentToolKind,
    opportunity: 'uncertain',
    ranked: candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      score: signal.scores[candidate.id] ?? 0,
      description: candidate.description,
      isCurrent: candidate.isCurrent,
      isNoTool: candidate.id === 'NO_TOOL',
    })),
    confidence: 0,
    reasons: ['policy_exception', error instanceof Error ? error.message : String(error)],
    benefit: [],
    flags: ['policy_exception'],
    fallback: true,
  };
}

function abstainSignal(reason: string): PlanAuditSignal {
  return { scores: {}, confidence: 0, abstain: true, reasons: [reason], latencyMs: 0 };
}

function summarize(steps: StepAudit[]): PlanAuditSummary {
  const summary: PlanAuditSummary = {
    total: steps.length,
    better_tool: 0,
    missing_tool: 0,
    keep_current: 0,
    no_tool: 0,
    uncertain: 0,
    fallback: 0,
  };
  for (const step of steps) {
    summary[step.opportunity] += 1;
    if (step.fallback) summary.fallback += 1;
  }
  return summary;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
