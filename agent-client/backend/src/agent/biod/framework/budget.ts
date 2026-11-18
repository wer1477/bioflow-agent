import type { BudgetProfile, Candidate, StateBudget } from './contracts.js';

/** Budgets are policy, not model limits. max=32768 is a future-training placeholder. */
export const BUDGET_PROFILES: Record<BudgetProfile, StateBudget> = {
  rule: { profile: 'rule', maxTotalTokens: 0, maxStateTokens: 0, maxCandidates: 0, timeoutMs: 2_000 },
  short: { profile: 'short', maxTotalTokens: 1_024, maxStateTokens: 512, maxCandidates: 8, timeoutMs: 2_000 },
  medium: { profile: 'medium', maxTotalTokens: 6_144, maxStateTokens: 2_048, maxCandidates: 64, timeoutMs: 2_000 },
  long: { profile: 'long', maxTotalTokens: 12_288, maxStateTokens: 8_192, maxCandidates: 32, timeoutMs: 5_000 },
  max: { profile: 'max', maxTotalTokens: 32_768, maxStateTokens: 16_384, maxCandidates: 128, timeoutMs: 10_000 },
  audit: { profile: 'audit', maxTotalTokens: 4_096, maxStateTokens: 512, maxCandidates: 24, timeoutMs: 2_000 },
  'audit-max': { profile: 'audit-max', maxTotalTokens: 32_768, maxStateTokens: 8_192, maxCandidates: 128, timeoutMs: 10_000 },
  'claim-audit': { profile: 'claim-audit', maxTotalTokens: 4_096, maxStateTokens: 2_048, maxCandidates: 0, timeoutMs: 2_000 },
  'claim-audit-max': { profile: 'claim-audit-max', maxTotalTokens: 32_768, maxStateTokens: 16_384, maxCandidates: 0, timeoutMs: 10_000 },
  'issue-audit': { profile: 'issue-audit', maxTotalTokens: 4_096, maxStateTokens: 2_048, maxCandidates: 0, timeoutMs: 2_000 },
  'issue-audit-max': { profile: 'issue-audit-max', maxTotalTokens: 32_768, maxStateTokens: 16_384, maxCandidates: 0, timeoutMs: 10_000 },
};

export function budgetFor(profile: BudgetProfile): StateBudget {
  return { ...BUDGET_PROFILES[profile] };
}

/**
 * Cheap token estimate for budgeting only. It intentionally over-estimates CJK text so a
 * renderer cannot silently exceed the configured ceiling.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += char.codePointAt(0)! > 0x2e80 ? 1.2 : 0.28;
  }
  return Math.ceil(tokens);
}

export function estimateCandidateTokens(candidates: Candidate[]): number {
  return candidates.reduce((total, candidate) => {
    const text = [candidate.name, candidate.description ?? ''].join(' ');
    return total + estimateTokens(text) + 4;
  }, 0);
}

export interface BudgetFit {
  ok: boolean;
  state: string;
  candidates: Candidate[];
  estimatedTokens: number;
  truncated: boolean;
}

/** Clip the state first, then candidate count. Callers decide whether a short list is usable. */
export function fitBudget(state: string, candidates: Candidate[], budget: StateBudget): BudgetFit {
  if (budget.profile === 'rule' || budget.maxTotalTokens <= 0) {
    return { ok: true, state: '', candidates: [], estimatedTokens: 0, truncated: false };
  }
  let truncated = false;
  let clipped = state;
  if (estimateTokens(clipped) > budget.maxStateTokens) {
    clipped = clipToTokens(clipped, budget.maxStateTokens);
    truncated = true;
  }
  const limited = candidates.slice(0, budget.maxCandidates);
  if (limited.length !== candidates.length) truncated = true;
  let total = estimateTokens(clipped) + estimateCandidateTokens(limited);
  while (limited.length > 0 && total > budget.maxTotalTokens) {
    limited.pop();
    truncated = true;
    total = estimateTokens(clipped) + estimateCandidateTokens(limited);
  }
  return { ok: total <= budget.maxTotalTokens, state: clipped, candidates: limited, estimatedTokens: total, truncated };
}

export function clipToTokens(text: string, maxTokens: number): string {
  let tokens = 0;
  let end = 0;
  for (const char of text) {
    tokens += char.codePointAt(0)! > 0x2e80 ? 1.2 : 0.28;
    if (tokens > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}
