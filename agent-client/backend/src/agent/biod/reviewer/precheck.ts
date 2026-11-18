import type {
  AbsenceSearchResult,
  AnchorLocation,
  IssuePremiseRow,
  ParsedIssue,
} from './contracts.js';
import {
  locateAnchor,
  searchAbsenceTerms,
  type ParsedDocument,
} from './document.js';

export interface PremiseCheck {
  premise: IssuePremiseRow;
  /** Set for passage anchors (and the first anchor of a conflict). */
  anchor?: AnchorLocation;
  /** Set for the second anchor of a conflict premise. */
  anchor2?: AnchorLocation;
  /** Set for absence premises; the verdict is deterministic, not model output. */
  absence?: AbsenceSearchResult;
  flags: string[];
}

export interface IssuePrecheck {
  issue: ParsedIssue;
  premises: PremiseCheck[];
  sectionMissing: boolean;
  duplicates: string[];
  flags: string[];
}

export interface IssuePrecheckInput {
  issues: ParsedIssue[];
  document: ParsedDocument;
  duplicateThreshold: number;
  maxPassageChars: number;
}

export interface IssuePrecheckSummary {
  anchorsMissing: number;
  locatorMissing: number;
  sectionsMissing: number;
  duplicateIssues: number;
  absenceChecks: number;
  absenceHits: number;
  invalidPremises: number;
}

/**
 * Deterministic checks that run before any semantic scoring: can the anchor be located in
 * the document, does the issue's section exist, is the issue a near-duplicate of another,
 * and does an absence term actually appear?
 *
 * These checks answer "is it there", never "does the premise hold".
 */
export function runIssuePrecheck(input: IssuePrecheckInput): IssuePrecheck[] {
  const duplicates = detectDuplicates(input.issues, input.duplicateThreshold);
  return input.issues.map((issue) => {
    const sectionMissing = issue.section !== 'unknown' && !input.document.sectionNames.includes(issue.section);
    const premises = issue.premises.map((premise) => checkPremise(premise, input.document, input.maxPassageChars));
    const flags = [...new Set(premises.flatMap((premise) => premise.flags))];
    if (sectionMissing) flags.push('section_missing');
    const issueDuplicates = duplicates.get(issue.issueId) ?? [];
    if (issueDuplicates.length) flags.push('duplicate_issue');
    return {
      issue,
      premises,
      sectionMissing,
      duplicates: issueDuplicates,
      flags: [...new Set(flags)],
    };
  });
}

export function summarizePrecheck(checks: IssuePrecheck[]): IssuePrecheckSummary {
  const premises = checks.flatMap((check) => check.premises);
  const duplicates = checks.flatMap((check) => check.duplicates);
  return {
    anchorsMissing: premises.filter((premise) => premise.flags.includes('anchor_missing')).length,
    locatorMissing: premises.filter((premise) => premise.flags.includes('locator_missing')).length,
    sectionsMissing: checks.filter((check) => check.sectionMissing).length,
    duplicateIssues: new Set(duplicates).size,
    absenceChecks: premises.filter((premise) => premise.premise.premiseKind === 'absence').length,
    absenceHits: premises.filter((premise) => premise.absence?.hit).length,
    invalidPremises: premises.filter((premise) => premise.flags.includes('invalid_premise')).length,
  };
}

function checkPremise(
  premise: IssuePremiseRow,
  document: ParsedDocument,
  maxPassageChars: number,
): PremiseCheck {
  const flags: string[] = [];
  if (premise.premiseKind === 'none') {
    return { premise, flags: ['no_checkable_premise'] };
  }
  if (premise.premiseKind === 'absence') {
    if (!premise.searchTerms.length) flags.push('invalid_premise');
    const absence = searchAbsenceTerms(document, premise.searchTerms);
    return { premise, absence, flags };
  }

  if (!premise.anchorLocator) flags.push('locator_missing');
  const anchor = locateAnchor(document, premise.anchorQuote, maxPassageChars);
  if (!anchor.found) flags.push('anchor_missing');
  if (anchor.ambiguous) flags.push('anchor_ambiguous');

  if (premise.premiseKind === 'conflict') {
    const anchor2 = locateAnchor(document, premise.anchorQuote2, maxPassageChars);
    if (!anchor2.found) flags.push('anchor_missing_2');
    return { premise, anchor, anchor2, flags };
  }
  return { premise, anchor, flags };
}

/** Deterministic near-duplicate detection on issue text; no model involved. */
function detectDuplicates(issues: ParsedIssue[], threshold: number): Map<string, string[]> {
  const tokens = new Map(issues.map((issue) => [issue.issueId, new Set(contentTokens(issue.issueText))]));
  const duplicates = new Map<string, string[]>();
  for (let index = 0; index < issues.length; index += 1) {
    for (let other = index + 1; other < issues.length; other += 1) {
      const a = issues[index];
      const b = issues[other];
      const left = tokens.get(a.issueId) ?? new Set<string>();
      const right = tokens.get(b.issueId) ?? new Set<string>();
      if (jaccard(left, right) < threshold) continue;
      push(duplicates, a.issueId, b.issueId);
      push(duplicates, b.issueId, a.issueId);
    }
  }
  return duplicates;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those', 'we', 'our', 'as', 'by',
  'from', 'at', 'it', 'its', 'than', 'then', 'also', 'can', 'may', 'might', 'not', 'no',
]);

function contentTokens(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  const tokens = lower.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  return tokens.filter((token) => !STOPWORDS.has(token));
}
