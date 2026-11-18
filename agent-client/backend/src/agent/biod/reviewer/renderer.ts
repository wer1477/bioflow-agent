import { clipToTokens, estimateTokens } from '../framework/budget.js';
import type { StateBudget } from '../framework/contracts.js';
import type {
  IssuePremiseRow,
  ParsedIssue,
  PremiseStatus,
} from './contracts.js';

export interface RenderedIssueState {
  state: string;
  estimatedTokens: number;
  truncated: boolean;
}

/** Render one premise check. The reviewed document is never placed in a state. */
export function renderPremiseState(input: {
  issue: ParsedIssue;
  premise: IssuePremiseRow;
  passage: string;
  passage2?: string;
  variant: 'full' | 'short';
}): RenderedIssueState {
  const short = input.variant === 'short';
  const issueText = clip(input.issue.issueText, short ? 60 : 240);
  const premiseText = clip(input.premise.premiseText, short ? 100 : 300);
  const locator = clip(input.premise.anchorLocator, short ? 40 : 200);
  const passage = clip(input.passage, short ? 100 : 4000);
  const passage2 = input.passage2 === undefined ? undefined : clip(input.passage2, short ? 100 : 4000);

  let state = input.premise.premiseKind === 'conflict'
    ? [
        '[角色：reviewer][DP:v1.issue-triage][check:premise][conflict]',
        `Premise: ${premiseText}`,
        `Locator: ${locator}`,
        `Passage A: ${passage}`,
        `Passage B: ${passage2 ?? ''}`,
        'Task: Do the two passages conflict as the premise states? Answer holds / contradicted / unresolved. Do not grade the issue.',
      ].join('\n')
    : short
      ? [
          '[角色：reviewer][DP:v1.issue-triage][short]',
          `Issue: ${issueText}`,
          `Premise: ${premiseText}`,
          `Passage: ${passage}`,
          'Task: does the passage support the premise? Answer holds/contradicted/unresolved.',
        ].join('\n')
      : [
          '[角色：reviewer][DP:v1.issue-triage][check:premise]',
          `Issue type: ${input.issue.issueType} | claimed severity: ${input.issue.severityClaim}`,
          `Issue: ${issueText}`,
          `Premise: ${premiseText}`,
          `Section: ${input.issue.section} | Locator: ${locator}`,
          `Passage: ${passage}`,
          'Task: Does the passage support this premise as stated? Answer holds / contradicted / unresolved. Do not grade the issue.',
        ].join('\n');

  if (short && state.length > 220) state = state.slice(0, 220);
  const truncated = issueText !== input.issue.issueText
    || premiseText !== input.premise.premiseText
    || passage !== input.passage
    || (passage2 !== undefined && passage2 !== input.passage2)
    || locator !== input.premise.anchorLocator;
  return { state, estimatedTokens: estimateTokens(state), truncated };
}

/** Render the owner routing check. */
export function renderOwnerState(input: {
  issue: ParsedIssue;
  premiseStatus: PremiseStatus;
}): RenderedIssueState {
  const issueText = clip(input.issue.issueText, 240);
  const state = [
    '[角色：reviewer][DP:v1.issue-triage][check:owner]',
    `Issue type: ${input.issue.issueType} | claimed severity: ${input.issue.severityClaim}`,
    `Issue: ${issueText}`,
    `Section: ${input.issue.section}`,
    `Premise status: ${input.premiseStatus}`,
    'Task: Which role should fix this? searcher=literature/prior work; researcher=analysis/experiment/data; writer=manuscript text/citations/reporting; reviewer=re-review/decision support; pi=dispatch/acceptance/ethics decision.',
  ].join('\n');
  return {
    state,
    estimatedTokens: estimateTokens(state),
    truncated: issueText !== input.issue.issueText,
  };
}

/** Render one pairwise comparison. */
export function renderPairState(input: {
  a: ParsedIssue;
  b: ParsedIssue;
  title: string;
}): RenderedIssueState {
  const title = clip(input.title, 160);
  const aText = clip(input.a.issueText, 240);
  const bText = clip(input.b.issueText, 240);
  const state = [
    '[角色：reviewer][DP:v1.issue-triage][check:pair]',
    `Paper: ${title}`,
    `Issue A (${input.a.issueType}, ${input.a.section}): ${aText}`,
    `Issue B (${input.b.issueType}, ${input.b.section}): ${bText}`,
    'Task: Which issue is more likely to block the core conclusion? Answer a / b / tie. Do not assign severity levels.',
  ].join('\n');
  return {
    state,
    estimatedTokens: estimateTokens(state),
    truncated: aText !== input.a.issueText || bText !== input.b.issueText || title !== input.title,
  };
}

/** Apply the configured state budget. */
export function fitIssueAuditBudget(state: string, budget: StateBudget): RenderedIssueState {
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
