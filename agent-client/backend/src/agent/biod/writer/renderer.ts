import { clipToTokens, estimateTokens } from '../framework/budget.js';
import type { StateBudget } from '../framework/contracts.js';
import type { ClaimEvidenceRow, ParsedClaim } from './contracts.js';

export interface RenderedManuscriptState {
  state: string;
  estimatedTokens: number;
  truncated: boolean;
}

/** Render one claim-evidence edge. The whole manuscript is never placed in a state. */
export function renderManuscriptAuditState(
  claim: ParsedClaim,
  evidence: ClaimEvidenceRow,
  variant: 'full' | 'short',
): RenderedManuscriptState {
  const short = variant === 'short';
  const claimText = clip(claim.claimText, short ? 100 : 300);
  const quote = clip(evidence.evidenceQuote, short ? 100 : 800);
  const scope = clip(evidence.evidenceScope, short ? 20 : 200);
  const locator = clip(evidence.evidenceLocator, short ? 40 : 300);
  let state = short
    ? [
        '[角色：writer][DP:w1.claim-evidence-audit][short]',
        `Claim: ${claimText}`,
        `Quote: ${quote}`,
        `Scope: ${scope}`,
        `Locator: ${locator}`,
        'Task: judge whether the quote supports the claim. Answer supports/partially_supports/contradicts/unrelated/unverifiable.',
      ].join('\n')
    : [
        '[角色：writer][DP:w1.claim-evidence-audit]',
        `Claim: ${claimText}`,
        `Section: ${claim.section}`,
        `Claim type: ${claim.claimType}`,
        `Writer status: ${claim.writerStatus}`,
        `Evidence type: ${evidence.evidenceType}`,
        `Locator: ${locator}`,
        `Quote: ${quote}`,
        `Scope: ${scope}`,
        'Task: judge whether the evidence supports the claim as stated. Report relation and overclaim flags. Do not rewrite.',
      ].join('\n');
  if (short && state.length > 220) state = state.slice(0, 220);
  const truncated = claimText !== claim.claimText
    || quote !== evidence.evidenceQuote
    || scope !== evidence.evidenceScope
    || locator !== evidence.evidenceLocator;
  return { state, estimatedTokens: estimateTokens(state), truncated };
}

/** Apply the configured state budget; there are no candidate rows in this audit. */
export function fitManuscriptAuditBudget(state: string, budget: StateBudget): RenderedManuscriptState {
  const estimated = estimateTokens(state);
  if (budget.maxStateTokens <= 0 || estimated <= budget.maxStateTokens) {
    return { state, estimatedTokens: estimated, truncated: false };
  }
  const clipped = clipToTokens(state, budget.maxStateTokens);
  return { state: clipped, estimatedTokens: estimateTokens(clipped), truncated: true };
}

function clip(value: string, maxChars: number): string {
  const text = String(value ?? '').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
