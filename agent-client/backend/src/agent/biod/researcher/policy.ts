import type { StepCandidateSet } from './candidates.js';
import {
  NO_TOOL_ID,
  type PlanAuditSignal,
  type PlanAuditThresholds,
  type PlanStep,
  type PlanToolCandidate,
  type RankedTool,
  type StepAudit,
} from './contracts.js';

/**
 * Turns one step's scores into an opportunity label. This is the only place that decides
 * "better", "missing", "keep" or "uncertain"; it never edits the plan and never gates.
 */

export function decidePlanStep(
  step: PlanStep,
  signal: PlanAuditSignal,
  set: StepCandidateSet,
  thresholds: PlanAuditThresholds,
): StepAudit {
  const scores = normalizeScores(signal.scores);
  const candidates = set.candidates;
  const rankedAll = candidates
    .map((candidate) => toRanked(candidate, scores[candidate.id] ?? 0))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const current = candidates.find((candidate) => candidate.id === step.currentToolId);
  const currentScore = current ? (scores[current.id] ?? 0) : 0;
  const alternatives = rankedAll.filter((entry) => !entry.isNoTool && !entry.isCurrent);
  const best = alternatives[0];
  const bestScore = best?.score ?? 0;
  const noToolScore = scores[NO_TOOL_ID] ?? 0;
  const flags: string[] = [];
  if (set.prefilteredOut.length) flags.push('candidate_prefiltered');
  if (step.currentToolId && set.currentToolKind === 'unknown') flags.push('current_tool_unavailable');
  if (!step.inputs.length && !step.outputs.length) flags.push('underspecified_step');

  const base = {
    stepId: step.id,
    goal: step.goal,
    ...(step.currentToolId ? { currentToolId: step.currentToolId } : {}),
    currentToolKind: set.currentToolKind,
    ranked: toReportRanking(rankedAll, thresholds.topK),
    confidence: signal.confidence,
    reasons: [...signal.reasons],
    benefit: [] as string[],
    flags,
    fallback: signal.abstain,
  };

  if (signal.abstain || signal.confidence < thresholds.minConfidence) {
    return {
      ...base,
      opportunity: 'uncertain',
      reasons: [...base.reasons, 'low_confidence'],
    };
  }
  if (!step.inputs.length && !step.outputs.length) {
    return {
      ...base,
      opportunity: 'uncertain',
      reasons: [...base.reasons, 'underspecified_step'],
    };
  }

  if (set.currentToolKind === 'library') {
    if (!current) {
      return { ...base, opportunity: 'uncertain', reasons: [...base.reasons, 'current_tool_missing_from_candidates'] };
    }
    if (best && bestScore - currentScore >= thresholds.margin && signal.confidence >= thresholds.tauBetter) {
      return recommend(base, best, 'better_tool');
    }
    return {
      ...base,
      opportunity: 'keep_current',
      reasons: [...base.reasons, noToolScore >= currentScore ? 'no_tool_beats_current' : 'current_is_best'],
    };
  }

  if (best && bestScore >= thresholds.tauMissing && bestScore - noToolScore >= thresholds.margin) {
    return recommend(base, best, 'missing_tool');
  }

  return {
    ...base,
    opportunity: set.currentToolKind === 'core' ? 'keep_current' : 'no_tool',
    reasons: [...base.reasons, best ? 'no_candidate_above_threshold' : 'no_library_tool'],
  };
}

function recommend(
  base: Omit<StepAudit, 'opportunity' | 'recommendedToolId' | 'evidence' | 'benefit'>,
  tool: RankedTool,
  opportunity: 'better_tool' | 'missing_tool',
): StepAudit {
  const evidence = excerpt(tool.description, 200);
  if (evidence.length < 20) {
    return {
      ...base,
      opportunity: 'uncertain',
      reasons: [...base.reasons, 'no_tool_evidence'],
      benefit: [],
      flags: [...base.flags, 'no_tool_evidence'],
    };
  }
  return {
    ...base,
    opportunity,
    recommendedToolId: tool.id,
    evidence,
    benefit: inferBenefits(tool.description),
    reasons: [...base.reasons, opportunity === 'better_tool' ? 'better_alternative' : 'tool_covers_step'],
  };
}

function toRanked(candidate: PlanToolCandidate, score: number): RankedTool {
  return {
    id: candidate.id,
    name: candidate.name,
    score,
    description: candidate.description,
    isCurrent: candidate.isCurrent,
    isNoTool: candidate.id === NO_TOOL_ID,
  };
}

/** topK scored tools plus NO_TOOL, in descending score order. */
function toReportRanking(ranked: RankedTool[], topK: number): RankedTool[] {
  const sorted = [...ranked].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const limit = Math.max(1, Math.floor(topK));
  const top = sorted.slice(0, limit);
  if (!top.some((entry) => entry.isNoTool)) {
    const noTool = sorted.find((entry) => entry.isNoTool);
    if (noTool) top.push(noTool);
  }
  return top;
}

function normalizeScores(scores: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [id, value] of Object.entries(scores)) {
    normalized[id] = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }
  return normalized;
}

function inferBenefits(description: string): string[] {
  const text = description.toLowerCase();
  const benefits: string[] = [];
  if (/pipeline|workflow|standard/.test(text)) benefits.push('standard_pipeline');
  if (/reproduc|versioned|version control/.test(text)) benefits.push('reproducibility');
  if (/batch|automat|fast|parallel/.test(text)) benefits.push('speed');
  if (/analysis|toolkit|pipeline|workflow|annotat|quantif/.test(text)) benefits.push('less_custom_code');
  return benefits;
}

function excerpt(text: string, maxChars: number): string {
  const trimmed = String(text ?? '').trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}
