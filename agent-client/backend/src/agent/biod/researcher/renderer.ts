import { clipToTokens, estimateCandidateTokens, estimateTokens } from '../framework/budget.js';
import type { StateBudget } from '../framework/contracts.js';
import { NO_TOOL_ID, type PlanStep, type PlanToolCandidate } from './contracts.js';

/**
 * State and row budgeting for one plan step. `full` is for a future long-window head;
 * `short` deliberately stays near v0's 220-character training distribution.
 */

export type PlanAuditRendererVariant = 'full' | 'short';

export interface RenderedPlanState {
  state: string;
  estimatedTokens: number;
  truncated: boolean;
}

export interface FittedPlanAudit {
  state: string;
  candidates: PlanToolCandidate[];
  estimatedTokens: number;
  truncated: boolean;
}

const SHORT_STATE_CHARS = 220;

export function renderPlanAuditState(
  step: PlanStep,
  _candidates: PlanToolCandidate[],
  budget: StateBudget,
  variant: PlanAuditRendererVariant,
): RenderedPlanState {
  if (variant === 'short') {
    const state = `[角色：researcher] 步骤：${clipChars(step.goal, 80)} 当前：${clipChars(step.currentToolId ?? 'none', 60)} 任务：有无更合适的 toollibrary 工具？没有就 NO_TOOL。`;
    return clipState(state, Math.min(SHORT_STATE_CHARS, budget.maxStateTokens), true);
  }

  const state = [
    '[角色：researcher][DP:r1.plan-audit]',
    `Step: ${step.goal}`,
    `In: ${step.inputs.length ? step.inputs.join('; ') : 'none'}`,
    `Out: ${step.outputs.length ? step.outputs.join('; ') : 'none'}`,
    `Current: ${step.currentToolId ?? 'none'}${step.currentApproach ? ` / ${step.currentApproach}` : ''}`,
    `Constraints: ${step.constraints.length ? step.constraints.join('; ') : 'none'}`,
    'Task: rank the candidate tools for this action. Choose NO_TOOL if none is better than the current approach.',
  ].join('\n');
  return clipState(state, budget.maxStateTokens, false);
}

/**
 * Fits state and candidate rows into the profile. `NO_TOOL` is pinned: it is the policy's
 * "do not recommend" vote, so dropping it would silently turn a no-opinion into a tool pick.
 */
export function fitPlanAuditBudget(
  rendered: RenderedPlanState,
  candidates: PlanToolCandidate[],
  budget: StateBudget,
): FittedPlanAudit {
  if (budget.profile === 'rule' || budget.maxTotalTokens <= 0) {
    return { state: '', candidates: [], estimatedTokens: 0, truncated: false };
  }

  let truncated = rendered.truncated;
  let state = rendered.state;
  if (estimateTokens(state) > budget.maxStateTokens) {
    state = clipToTokens(state, budget.maxStateTokens);
    truncated = true;
  }

  const noTool = candidates.find((candidate) => candidate.id === NO_TOOL_ID) ?? {
    id: NO_TOOL_ID,
    name: NO_TOOL_ID,
    kind: 'pseudo' as const,
    description: 'Do not recommend a tool; keep the current approach or manual work.',
    isCurrent: false,
  };
  const tools = candidates.filter((candidate) => candidate.id !== NO_TOOL_ID);
  const limit = Math.max(0, budget.maxCandidates - 1);
  let kept = tools.slice(0, limit);
  if (kept.length !== tools.length) truncated = true;

  let total = estimateTokens(state) + estimateCandidateTokens([...kept, noTool]);
  while (kept.length > 0 && total > budget.maxTotalTokens) {
    kept = kept.slice(0, -1);
    truncated = true;
    total = estimateTokens(state) + estimateCandidateTokens([...kept, noTool]);
  }

  return {
    state,
    candidates: [...kept, noTool],
    estimatedTokens: total,
    truncated,
  };
}

function clipState(state: string, maxTokens: number, hardCharLimit: boolean): RenderedPlanState {
  const clippedChars = hardCharLimit ? clipChars(state, SHORT_STATE_CHARS) : state;
  const estimated = estimateTokens(clippedChars);
  if (estimated <= maxTokens) {
    return { state: clippedChars, estimatedTokens: estimated, truncated: clippedChars !== state };
  }
  return {
    state: clipToTokens(clippedChars, maxTokens),
    estimatedTokens: maxTokens,
    truncated: true,
  };
}

function clipChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…` : text;
}
