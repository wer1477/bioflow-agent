/**
 * Researcher R1 plan-audit contracts.
 *
 * R1 is a post-plan review: it compares the tool a plan already names (or the manual
 * approach it describes) against the tools this role may load. It never edits the plan,
 * never loads a tool, and never gates execution. Every type here is model-free; a future
 * trained head only implements `PlanAuditScorer`.
 */

import type { StateBudget } from '../framework/contracts.js';

export type PlanAuditMode = 'shadow' | 'assist';

export type OpportunityType =
  | 'better_tool'
  | 'missing_tool'
  | 'keep_current'
  | 'no_tool'
  | 'uncertain';

export type CurrentToolKind = 'library' | 'core' | 'unknown' | 'none';

export type PlanAuditFailureReason =
  | 'disabled'
  | 'not_authorized'
  | 'missing_plan_steps'
  | 'invalid_plan_steps'
  | 'no_candidates'
  | 'no_steps'
  | 'timeout'
  | 'bad_response';

export const NO_TOOL_ID = 'NO_TOOL';

export interface PlanStep {
  id: string;
  goal: string;
  inputs: string[];
  outputs: string[];
  currentToolId?: string;
  currentApproach?: string;
  constraints: string[];
}

export interface PlanToolCandidate {
  id: string;
  name: string;
  kind: 'skill' | 'mcp' | 'pseudo';
  domain?: string;
  description: string;
  isCurrent: boolean;
}

export interface RankedTool {
  id: string;
  name: string;
  score: number;
  description: string;
  isCurrent: boolean;
  isNoTool: boolean;
}

export interface StepAudit {
  stepId: string;
  goal: string;
  currentToolId?: string;
  currentToolKind: CurrentToolKind;
  opportunity: OpportunityType;
  recommendedToolId?: string;
  /** topK + NO_TOOL; NO_TOOL is always present. */
  ranked: RankedTool[];
  confidence: number;
  reasons: string[];
  /** Verbatim tool-description excerpt; a recommendation without evidence is downgraded. */
  evidence?: string;
  benefit: string[];
  flags: string[];
  fallback: boolean;
}

export type PlanAuditSummary = Record<OpportunityType, number> & {
  total: number;
  fallback: number;
};

export interface PlanAuditReport {
  requestId: string;
  runId: string;
  role: 'researcher';
  decisionPoint: 'r1.plan-audit';
  mode: PlanAuditMode;
  planPath: string;
  planHash: string;
  steps: StepAudit[];
  summary: PlanAuditSummary;
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

export interface PlanAuditThresholds {
  tauBetter: number;
  tauMissing: number;
  margin: number;
  minConfidence: number;
  topK: number;
}

export interface PlanAuditPrefilter {
  mode: 'lexical' | 'none';
  maxCandidates: number;
}

export interface PlanAuditRequest {
  requestId: string;
  runId: string;
  role: 'researcher';
  planPath: string;
  planHash: string;
  steps: PlanStep[];
  /** Role-visible tools; each step is prefiltered down to a scorable row set. */
  tools: PlanToolCandidate[];
  mode: PlanAuditMode;
  budget: StateBudget;
  thresholds: PlanAuditThresholds;
  prefilter: PlanAuditPrefilter;
  context: {
    sessionId: string;
    rolePromptVersion: string;
    rendererVersion: string;
  };
}

export interface PlanAuditSignal {
  scores: Record<string, number>;
  confidence: number;
  abstain: boolean;
  reasons: string[];
  latencyMs: number;
  /** Candidate ids removed by the v0 checkpoint vocabulary mask. */
  masked?: string[];
}

export interface PlanAuditScorer {
  modelVersion: string;
  /** `full` for heuristic/future heads; `short` for the v0-compatible adapter. */
  variant: 'full' | 'short';
  score(input: {
    step: PlanStep;
    state: string;
    candidates: PlanToolCandidate[];
    budget: StateBudget;
  }): Promise<PlanAuditSignal>;
}

/** The tool-facing input; BiodService supplies config, ledger and scorer. */
export interface PlanAuditServiceInput {
  requestId: string;
  runId: string;
  sessionId: string;
  rolePromptVersion: string;
  planPath: string;
  planHash: string;
  steps: PlanStep[];
  tools: PlanToolCandidate[];
}

/** One step's replay/training trace; not rendered into the user-facing report. */
export interface PlanAuditStepTrace {
  stepId: string;
  state: string;
  stateHash: string;
  stateChars: number;
  truncated: boolean;
  candidates: string[];
  scores: Record<string, number>;
  prefilteredOut: string[];
  masked?: string[];
}

export interface PlanAuditTrace {
  steps: PlanAuditStepTrace[];
}

export type PlanAuditResult =
  | { ok: true; report: PlanAuditReport; markdown: string; trace: PlanAuditTrace }
  | { ok: false; reason: PlanAuditFailureReason; message?: string };

export interface PlanAuditRunner {
  runPlanAudit(input: PlanAuditServiceInput): Promise<PlanAuditResult>;
}

export interface PlanAuditRecord {
  ts: string;
  requestId: string;
  runId: string;
  role: 'researcher';
  decisionPoint: 'r1.plan-audit';
  mode: PlanAuditMode;
  planPath: string;
  planHash: string;
  stepCount: number;
  modelVersion: string;
  policyVersion: string;
  rendererVersion: string;
  steps: PlanAuditStepTrace[];
  summary: PlanAuditSummary;
  fallback: boolean;
  fallbackReason?: string;
  latencyMs: number;
}

export const DEFAULT_PLAN_AUDIT_THRESHOLDS: PlanAuditThresholds = {
  tauBetter: 0.55,
  tauMissing: 0.55,
  margin: 0.08,
  minConfidence: 0.5,
  topK: 3,
};

export const DEFAULT_PLAN_AUDIT_PREFILTER: PlanAuditPrefilter = {
  mode: 'lexical',
  maxCandidates: 16,
};
