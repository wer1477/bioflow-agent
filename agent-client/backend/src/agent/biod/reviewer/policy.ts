import {
  PREMISE_VERDICTS,
  REVIEWER_ROLES,
  type IssueAudit,
  type IssueFinding,
  type IssueQueueEntry,
  type IssueTriageThresholds,
  type OwnerRoute,
  type OwnerSignal,
  type ParsedIssue,
  type PremiseAuditResult,
  type PremiseSignal,
  type PremiseStatus,
  type IssuePriority,
  type ReviewerRole,
} from './contracts.js';
import type { PremiseCheck } from './precheck.js';

export interface PremisePolicyInput {
  check: PremiseCheck;
  /** Absent for absence premises (deterministic) and for anchors that could not be located. */
  signal?: PremiseSignal;
  /** Passage actually scored (conflict premises use the anchor paragraphs, not the window). */
  passage?: string;
  passage2?: string;
  thresholds: IssueTriageThresholds;
}

/**
 * Turn a precheck result plus a scorer signal into one premise verdict.
 *
 * The rule is conservative: `contradicted` needs `tauContradicted`, `holds` needs `tauHolds`,
 * and everything else becomes `unresolved`. "Unknown" is always an allowed answer.
 */
export function decidePremise(input: PremisePolicyInput): PremiseAuditResult {
  const { check, signal, thresholds } = input;
  const premise = check.premise;
  const base = {
    premiseId: premise.premiseId,
    kind: premise.premiseKind,
    premiseText: premise.premiseText,
    anchorLocator: premise.anchorLocator,
  };

  if (premise.premiseKind === 'none') {
    return {
      ...base,
      verdict: 'unresolved',
      scores: { holds: 0, contradicted: 0, unresolved: 1 },
      confidence: 1,
      reasons: ['the issue states no checkable premise'],
      flags: ['no_checkable_premise'],
      truncated: false,
      fallback: false,
    };
  }

  if (premise.premiseKind === 'absence') {
    const absence = check.absence;
    if (check.flags.includes('invalid_premise') || !absence?.terms.length) {
      return {
        ...base,
        verdict: 'unresolved',
        scores: { holds: 0, contradicted: 0, unresolved: 1 },
        confidence: 1,
        reasons: ['absence premise has no usable search terms'],
        flags: ['invalid_premise'],
        truncated: false,
        fallback: false,
      };
    }
    if (absence.hit) {
      return {
        ...base,
        verdict: 'contradicted',
        scores: { holds: 0, contradicted: 0.75, unresolved: 0.25 },
        confidence: 0.75,
        reasons: [
          `search term "${absence.hit.term}" appears in ${absence.hit.section} ¶${absence.hit.paragraphIndex + 1}`,
          `excerpt: ${absence.hit.excerpt}`,
        ],
        passage: absence.hit.excerpt,
        passageSection: absence.hit.section,
        flags: ['absence_term_found'],
        truncated: false,
        fallback: false,
      };
    }
    return {
      ...base,
      verdict: 'holds',
      scores: { holds: 0.6, contradicted: 0, unresolved: 0.4 },
      confidence: 0.6,
      reasons: [
        `none of the search terms appears in this document (${absence.searchedSections} section(s) searched)`,
        'absence is only checked inside this document; it is not proof that the content does not exist',
      ],
      flags: ['absence_check_limited'],
      truncated: false,
      fallback: false,
    };
  }

  const anchorMissing = check.flags.includes('anchor_missing');
  const passage = input.passage ?? check.anchor?.passage;
  if (anchorMissing || !passage) {
    return {
      ...base,
      verdict: 'unresolved',
      scores: { holds: 0, contradicted: 0, unresolved: 1 },
      confidence: 1,
      reasons: [
        check.anchor?.missingFragments.length
          ? `anchor quote not found in the document (${check.anchor.missingFragments.length} fragment(s) missing)`
          : 'anchor quote could not be located in the document',
      ],
      flags: ['anchor_missing'],
      truncated: false,
      fallback: false,
    };
  }

  if (premise.premiseKind === 'conflict' && check.anchor2 && !check.anchor2.found) {
    return {
      ...base,
      verdict: 'unresolved',
      scores: { holds: 0, contradicted: 0, unresolved: 1 },
      confidence: 1,
      reasons: ['the second anchor quote could not be located in the document'],
      passage,
      passageSection: check.anchor?.section,
      flags: ['anchor_missing_2'],
      truncated: false,
      fallback: false,
    };
  }

  if (!signal) {
    return {
      ...base,
      verdict: 'unresolved',
      scores: { holds: 0, contradicted: 0, unresolved: 1 },
      confidence: 0,
      reasons: ['no premise signal was produced'],
      passage,
      passageSection: check.anchor?.section,
      flags: ['scorer_skipped'],
      truncated: false,
      fallback: true,
    };
  }

  const top = topVerdict(signal.scores);
  let verdict: PremiseAuditResult['verdict'] = top;
  const flags: string[] = check.flags.filter((flag) => flag === 'anchor_ambiguous');
  const reasons = [...signal.reasons];
  if (signal.abstain || signal.confidence < thresholds.minConfidence) {
    verdict = 'unresolved';
    reasons.push(signal.abstain ? 'scorer abstained' : `confidence ${signal.confidence.toFixed(2)} is below minConfidence`);
  } else if (top === 'contradicted' && signal.confidence < thresholds.tauContradicted) {
    verdict = 'unresolved';
    reasons.push(`contradiction confidence ${signal.confidence.toFixed(2)} is below tauContradicted`);
  } else if (top === 'holds' && signal.confidence < thresholds.tauHolds) {
    verdict = 'unresolved';
    reasons.push(`support confidence ${signal.confidence.toFixed(2)} is below tauHolds`);
  }
  if (verdict === 'contradicted') flags.push('premise_contradicted');
  if (check.anchor?.ambiguous) reasons.push('the anchor quote appears in more than one section');

  return {
    ...base,
    verdict,
    scores: signal.scores,
    confidence: Number(signal.confidence.toFixed(3)),
    reasons,
    passage,
    passageSection: check.anchor?.section,
    ...(check.anchor2?.passage ? { passage2: check.anchor2.passage } : {}),
    flags: [...new Set(flags)],
    truncated: false,
    fallback: false,
  };
}

export interface OwnerPolicyInput {
  issue: ParsedIssue;
  premiseStatus: PremiseStatus;
  signal: OwnerSignal;
  thresholds: IssueTriageThresholds;
}

/**
 * Turn an owner distribution into a route. A low margin is reported as undecided and
 * escalated to PI on paper; the tool never dispatches anything.
 */
export function decideOwner(input: OwnerPolicyInput): OwnerRoute {
  const { issue, signal, thresholds } = input;
  const ranked = REVIEWER_ROLES
    .map((role) => ({ role, score: signal.scores[role] ?? 0 }))
    .sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const second = ranked[1] ?? { role: top.role, score: 0 };
  const margin = top.score - second.score;
  // Owner confidence is a 5-way distribution top score, not a calibrated premise probability:
  // `minConfidence` does not apply here. Only an explicit abstain makes the route undecided.
  const undecided = signal.abstain || margin < thresholds.ownerMargin;
  const owner: ReviewerRole = undecided ? 'pi' : top.role;
  const disagreesWithSuggestion = !undecided
    && issue.ownerSuggested !== undefined
    && issue.ownerSuggested !== owner;
  const flags: string[] = [];
  if (undecided) flags.push('owner_undecided');
  if (disagreesWithSuggestion) flags.push('owner_disagrees_reviewer');

  return {
    owner,
    confidence: Number((undecided ? Math.min(top.score, 0.5) : top.score).toFixed(3)),
    scores: signal.scores,
    alternatives: ranked
      .filter((entry) => undecided || entry.role !== owner)
      .slice(0, 3)
      .map((entry) => ({ role: entry.role, score: Number(entry.score.toFixed(3)) })),
    undecided,
    disagreesWithSuggestion,
    reasons: [
      ...signal.reasons,
      `top=${top.role} ${top.score.toFixed(2)}; margin=${margin.toFixed(2)}`,
      ...(undecided ? ['margin is below ownerMargin; suggest PI dispatch'] : []),
      ...(disagreesWithSuggestion ? [`reviewer suggested ${issue.ownerSuggested}`] : []),
    ],
    fallback: signal.abstain,
  };
}

export interface IssuePolicyInput {
  issue: ParsedIssue;
  premises: PremiseAuditResult[];
  owner: OwnerRoute;
  precheckFlags: string[];
  duplicates: string[];
  thresholds: IssueTriageThresholds;
  /** True when the pairwise cap prevented this issue from being compared. */
  pairwiseDeferred?: boolean;
}

export function decideIssue(input: IssuePolicyInput): IssueAudit {
  const { issue, premises, owner, thresholds } = input;
  const premiseStatus = aggregatePremiseStatus(premises);
  const finding = findingFor(premiseStatus);
  const flags = new Set<string>();
  for (const premise of premises) for (const flag of premise.flags) flags.add(flag);
  for (const flag of input.precheckFlags) flags.add(flag);
  if (input.duplicates.length) flags.add('duplicate_issue');
  if (owner.undecided) flags.add('owner_undecided');
  if (owner.disagreesWithSuggestion) flags.add('owner_disagrees_reviewer');
  if (input.pairwiseDeferred) flags.add('pairwise_deferred');

  const priority = priorityFor(issue, finding, flags, owner, input.duplicates);
  const reasons = reasonsFor(issue, premiseStatus, premises, owner, input.duplicates, thresholds);
  const actions = actionsFor(finding, flags);

  return {
    issueId: issue.issueId,
    section: issue.section,
    issueText: issue.issueText,
    issueType: issue.issueType,
    severityClaim: issue.severityClaim,
    ...(issue.ownerSuggested ? { ownerSuggested: issue.ownerSuggested } : {}),
    premiseStatus,
    finding,
    priority,
    premises,
    owner,
    flags: [...flags],
    reasons,
    actions,
    duplicates: input.duplicates,
    fallback: premises.some((premise) => premise.fallback) || owner.fallback,
    deferred: false,
  };
}

/** Ordered triage queue: check priority first, then pairwise rank, then input order. */
export function buildQueue(issues: IssueAudit[]): IssueQueueEntry[] {
  const priorityOrder: Record<IssuePriority, number> = { P0: 0, P1: 1, P2: 2, none: 3 };
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => {
      const byPriority = priorityOrder[left.issue.priority] - priorityOrder[right.issue.priority];
      if (byPriority !== 0) return byPriority;
      const leftRank = left.issue.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.issue.rank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    })
    .map(({ issue }) => ({
      issueId: issue.issueId,
      priority: issue.priority,
      ...(issue.rank !== undefined ? { rank: issue.rank } : {}),
      owner: issue.owner.owner,
      premiseStatus: issue.premiseStatus,
      why: issue.reasons[0] ?? '',
    }));
}

function aggregatePremiseStatus(premises: PremiseAuditResult[]): PremiseStatus {
  if (!premises.length) return 'no_premise';
  if (premises.every((premise) => premise.kind === 'none')) return 'no_premise';
  if (premises.some((premise) => premise.verdict === 'contradicted')) return 'premise_contradicted';
  if (premises.some((premise) => premise.verdict === 'unresolved')) return 'premise_unresolved';
  return 'premises_hold';
}

function findingFor(status: PremiseStatus): IssueFinding {
  if (status === 'no_premise') return 'no_checkable_premise';
  return status;
}

function priorityFor(
  issue: ParsedIssue,
  finding: IssueFinding,
  flags: Set<string>,
  owner: OwnerRoute,
  duplicates: string[],
): IssuePriority {
  const blocking = issue.severityClaim === 'blocking';
  const important = issue.severityClaim === 'important';
  const contradicted = finding === 'premise_contradicted';
  const unresolved = finding === 'premise_unresolved' || finding === 'no_checkable_premise';
  const anchorMissing = flags.has('anchor_missing') || flags.has('anchor_missing_2');

  if (contradicted && blocking) return 'P0';
  if (contradicted && important) return 'P1';
  if ((unresolved || owner.undecided || anchorMissing) && blocking) return 'P1';
  if (contradicted && !blocking && !important) return 'P2';

  const informative = duplicates.length > 0
    || flags.has('section_missing')
    || flags.has('owner_disagrees_reviewer')
    || flags.has('absence_check_limited')
    || flags.has('anchor_ambiguous')
    || flags.has('invalid_premise')
    || flags.has('pairwise_deferred');
  if (informative && !(issue.severityClaim === 'suggestion')) return 'P2';
  if (unresolved && important) return 'P2';
  if (owner.undecided && important) return 'P2';
  return 'none';
}

function reasonsFor(
  issue: ParsedIssue,
  status: PremiseStatus,
  premises: PremiseAuditResult[],
  owner: OwnerRoute,
  duplicates: string[],
  thresholds: IssueTriageThresholds,
): string[] {
  const reasons: string[] = [];
  const contradicted = premises.filter((premise) => premise.verdict === 'contradicted');
  const unresolved = premises.filter((premise) => premise.verdict === 'unresolved' && premise.kind !== 'none');
  if (status === 'premise_contradicted') {
    reasons.push(`the document contradicts ${contradicted.length} premise(s): ${contradicted.map((premise) => premise.premiseId).join(', ')}`);
  } else if (status === 'premise_unresolved') {
    reasons.push(`no premise could be confirmed (${unresolved.length} unresolved)`);
  } else if (status === 'premises_hold') {
    reasons.push('all checkable premises are supported by the current rules');
  } else {
    reasons.push('the issue states no checkable premise');
  }
  if (owner.undecided) reasons.push('owner route is undecided');
  if (duplicates.length) reasons.push(`possible duplicate of ${duplicates.join(', ')}`);
  if (issue.severityClaim === 'blocking' && status === 'premise_unresolved') {
    reasons.push(`claimed blocking but no premise reached tauHolds=${thresholds.tauHolds}`);
  }
  return reasons;
}

function actionsFor(finding: IssueFinding, flags: Set<string>): string[] {
  const actions: string[] = [];
  if (finding === 'premise_contradicted') actions.push('re_read_passage', 'rephrase_or_drop_premise');
  if (finding === 'premise_unresolved') actions.push('re_read_passage');
  if (finding === 'no_checkable_premise') actions.push('supply_premise');
  if (flags.has('anchor_missing') || flags.has('anchor_missing_2') || flags.has('locator_missing')) actions.push('fix_locator');
  if (flags.has('absence_check_limited')) actions.push('verify_absence_manually');
  if (flags.has('owner_undecided')) actions.push('ask_pi_assign');
  if (flags.has('owner_disagrees_reviewer')) actions.push('reassign_owner');
  if (flags.has('duplicate_issue')) actions.push('merge_duplicates');
  return actions.length ? [...new Set(actions)] : ['no_action'];
}

function topVerdict(scores: PremiseSignal['scores']): PremiseAuditResult['verdict'] {
  let best: PremiseAuditResult['verdict'] = 'unresolved';
  for (const verdict of PREMISE_VERDICTS) {
    if ((scores[verdict] ?? 0) > (scores[best] ?? 0)) best = verdict;
  }
  return best;
}
