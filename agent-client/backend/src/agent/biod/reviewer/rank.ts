import type { PairVerdict, ParsedIssue } from './contracts.js';

export interface PairComparison {
  a: string;
  b: string;
  verdict: PairVerdict;
  confidence: number;
  reasons: string[];
  fallback: boolean;
}

export interface RankedIssue {
  issueId: string;
  wins: number;
  comparisons: number;
  rank?: number;
}

export interface PairwiseOutcome {
  ranked: RankedIssue[];
  comparisons: PairComparison[];
  truncated: boolean;
  /** Issues that were not compared because the candidate cap was reached. */
  deferred: string[];
}

/**
 * Bounded pairwise ordering.
 *
 * Only the blocking candidates selected by policy are compared, at most `maxCandidates`.
 * Wins (a tie counts half) produce a relative order; ties keep the input order so the
 * result is stable and reproducible. This is a triage order, never a severity grade.
 */
export async function rankByPairwise(input: {
  issues: ParsedIssue[];
  compare: (a: ParsedIssue, b: ParsedIssue) => Promise<PairComparison>;
  maxCandidates: number;
}): Promise<PairwiseOutcome> {
  const cap = Math.max(0, Math.floor(input.maxCandidates));
  const candidates = input.issues.slice(0, cap);
  const deferred = input.issues.slice(cap).map((issue) => issue.issueId);
  const wins = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const issue of candidates) {
    wins.set(issue.issueId, 0);
    counts.set(issue.issueId, 0);
  }

  const comparisons: PairComparison[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    for (let other = index + 1; other < candidates.length; other += 1) {
      const a = candidates[index];
      const b = candidates[other];
      const comparison = await input.compare(a, b);
      comparisons.push(comparison);
      counts.set(a.issueId, (counts.get(a.issueId) ?? 0) + 1);
      counts.set(b.issueId, (counts.get(b.issueId) ?? 0) + 1);
      if (comparison.verdict === 'a') wins.set(a.issueId, (wins.get(a.issueId) ?? 0) + 1);
      else if (comparison.verdict === 'b') wins.set(b.issueId, (wins.get(b.issueId) ?? 0) + 1);
      else {
        wins.set(a.issueId, (wins.get(a.issueId) ?? 0) + 0.5);
        wins.set(b.issueId, (wins.get(b.issueId) ?? 0) + 0.5);
      }
    }
  }

  const order = new Map(candidates.map((issue, index) => [issue.issueId, index]));
  const ranked = candidates
    .map((issue) => ({
      issueId: issue.issueId,
      wins: wins.get(issue.issueId) ?? 0,
      comparisons: counts.get(issue.issueId) ?? 0,
    }))
    .sort((left, right) => {
      if (right.wins !== left.wins) return right.wins - left.wins;
      return (order.get(left.issueId) ?? 0) - (order.get(right.issueId) ?? 0);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  return {
    ranked,
    comparisons,
    truncated: deferred.length > 0,
    deferred,
  };
}
