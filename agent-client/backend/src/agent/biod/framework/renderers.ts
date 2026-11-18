import { clipToTokens, estimateTokens } from './budget.js';
import type { DecisionRequest, Renderer, StateBudget } from './contracts.js';

export class S2PremiseRenderer implements Renderer {
  readonly version = 's2.premise.short-v1';

  render(input: unknown, budget: StateBudget): { state: string; estimatedTokens: number; truncated: boolean } {
    const request = input as DecisionRequest;
    const card = request.artifacts.hypotheses.find((item) => item.id === request.focus?.hypId);
    const premise = card?.premises?.find((item) => item.pid === request.focus?.pid);
    const evidence = request.artifacts.evidence.find((item) => item.id === request.focus?.evidenceId);
    if (!card || !premise) {
      return { state: '', estimatedTokens: 0, truncated: false };
    }
    const context = evidence?.context
      ? [evidence.context.species, evidence.context.system, evidence.context.direction].filter(Boolean).join('/')
      : '';
    const raw = [
      '[S|P]',
      `C:${clip(card.claim, 10)}`,
      `P:${premise.text}`,
      `E:${evidence?.snippet ?? ''}`,
      `X:${context}`,
    ].join(' ');
    return clipState(raw, budget.maxStateTokens);
  }
}

export class S2RerankRenderer implements Renderer {
  readonly version = 's2.rerank.long-v1';

  render(input: unknown, budget: StateBudget): { state: string; estimatedTokens: number; truncated: boolean } {
    const request = input as DecisionRequest;
    const artifacts = request.artifacts;
    const gaps = (artifacts.gaps ?? []).join('\n');
    const raw = [
      `[R] ${artifacts.rq ?? ''}`,
      `[Review] ${artifacts.reviewSummary ?? ''}`,
      `[Gaps] ${gaps}`,
      '[Rubric] 只评“是否值得深审”：gap 关联、可检验、可执行、证据一致、非冗余；不评 novelty/impact。',
    ].join('\n');
    return clipState(raw, budget.maxStateTokens);
  }
}

export class RuleRenderer implements Renderer {
  readonly version = 'rule-v1';

  render(_input: unknown, _budget: StateBudget): { state: string; estimatedTokens: number; truncated: boolean } {
    return { state: '', estimatedTokens: 0, truncated: false };
  }
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function clipState(state: string, maxTokens: number): { state: string; estimatedTokens: number; truncated: boolean } {
  const estimated = estimateTokens(state);
  if (estimated <= maxTokens) return { state, estimatedTokens: estimated, truncated: false };
  const clipped = clipToTokens(state, maxTokens);
  return { state: clipped, estimatedTokens: estimateTokens(clipped), truncated: true };
}
