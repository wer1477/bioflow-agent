import type { LLMConfig } from './types.js';

export type ContextWindowSource = 'configured';

export interface ContextWindowResolution {
  tokens: number;
  source: ContextWindowSource;
  reason: string;
}

/** Context size is a required, user-maintained llm.json setting. */
export function resolveContextWindow(llm: Pick<LLMConfig, 'contextWindowTokens'>): ContextWindowResolution {
  const tokens = Number(llm.contextWindowTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new Error('当前 LLM 未设置“最大上下文”。请在 LLM 设置的高级参数中填写实际值。');
  }
  return { tokens: Math.floor(tokens), source: 'configured', reason: 'llm.json contextWindowTokens' };
}

export function resolveContextWindowTokens(llm: Pick<LLMConfig, 'contextWindowTokens'>): number {
  return resolveContextWindow(llm).tokens;
}
