import {
  citationKeyFromLocator,
  citationLocatorKind,
  isValidDoi,
  isValidPmid,
  normalizeDoi,
  type BibParseResult,
} from './bib.js';
import type { ClaimEvidenceRow, ParsedClaim, PrecheckIssue, PrecheckResult } from './contracts.js';
import type { ParsedManuscript } from './manuscript.js';

export interface PrecheckInput {
  claim: ParsedClaim;
  evidence: ClaimEvidenceRow;
  manuscript: ParsedManuscript;
  bib: BibParseResult;
  figures: string[];
  tables: string[];
  maxQuoteChars: number;
  referencesAvailable: boolean;
}

/**
 * Deterministic checks only. This function does not decide whether the evidence supports
 * the claim; it decides whether the evidence can be located and parsed at all.
 */
export function runPrecheck(input: PrecheckInput): PrecheckResult {
  const issues: PrecheckIssue[] = [];
  const evidence = input.evidence;
  const locator = evidence.evidenceLocator.trim();
  const quote = evidence.evidenceQuote.trim();

  const locatorStatus: PrecheckResult['locator'] = evidence.evidenceType === 'none'
    ? 'missing'
    : locator
      ? 'ok'
      : 'missing';
  if (evidence.evidenceType !== 'none' && !locator) {
    issues.push(issue('missing_locator', 'P0', 'evidence_locator is empty', evidence.evidenceId));
  }

  const quoteStatus: PrecheckResult['quote'] = evidence.evidenceType === 'none'
    ? 'not_applicable'
    : !quote
      ? 'missing'
      : quote.length > input.maxQuoteChars
        ? 'too_long'
        : 'ok';
  if (evidence.evidenceType !== 'none' && quoteStatus === 'missing') {
    issues.push(issue('missing_quote', 'P1', 'evidence_quote is empty', evidence.evidenceId));
  }
  if (quoteStatus === 'too_long') {
    issues.push(issue('quote_too_long', 'P2', `evidence_quote exceeds ${input.maxQuoteChars} characters`, evidence.evidenceId));
  }

  let citationKey: PrecheckResult['citationKey'] = 'not_applicable';
  let citationMetadata: PrecheckResult['citationMetadata'] = 'not_applicable';
  let inline: PrecheckResult['inline'] = 'not_applicable';

  if (evidence.evidenceType === 'citation') {
    const kind = citationLocatorKind(locator);
    if (!input.referencesAvailable) {
      citationKey = 'not_checked';
      citationMetadata = 'not_checked';
      issues.push(issue('references_missing', 'P1', 'references.bib is missing; citation key cannot be checked', evidence.evidenceId));
    } else if (kind === 'doi') {
      const doi = normalizeDoi(locator);
      citationMetadata = isValidDoi(doi) ? 'ok' : 'invalid';
      if (citationMetadata === 'invalid') {
        issues.push(issue('doi_invalid', 'P1', `invalid DOI: ${doi}`, evidence.evidenceId));
      }
      const entry = [...input.bib.entries.values()].find((item) => item.doi && normalizeDoi(item.doi) === doi);
      citationKey = entry ? 'ok' : 'missing';
      if (!entry) issues.push(issue('citation_key_missing', 'P0', `DOI not found in references.bib: ${doi}`, evidence.evidenceId));
      inline = 'not_checked';
    } else if (kind === 'pmid') {
      const pmid = locator.replace(/^pmid:\s*/i, '').trim();
      citationMetadata = isValidPmid(pmid) ? 'ok' : 'invalid';
      if (citationMetadata === 'invalid') {
        issues.push(issue('pmid_invalid', 'P1', `invalid PMID: ${pmid}`, evidence.evidenceId));
      }
      const entry = [...input.bib.entries.values()].find((item) => item.pmid === pmid);
      citationKey = entry ? 'ok' : 'missing';
      if (!entry) issues.push(issue('citation_key_missing', 'P0', `PMID not found in references.bib: ${pmid}`, evidence.evidenceId));
      inline = 'not_checked';
    } else if (kind === 'bibkey') {
      const key = citationKeyFromLocator(locator) ?? locator;
      const entry = input.bib.entries.get(key);
      citationKey = entry ? 'ok' : 'missing';
      citationMetadata = entry ? 'ok' : 'not_checked';
      if (!entry) {
        issues.push(issue('citation_not_in_bib', 'P0', `citation key not found in references.bib: ${key}`, evidence.evidenceId));
      }
      if (input.manuscript.citationStyle === 'numeric') {
        inline = 'style_unsupported';
        issues.push(issue('citation_style_unsupported', 'P2', 'numeric citations cannot be mapped to BibTeX keys', evidence.evidenceId));
      } else if (input.manuscript.citations.includes(key)) {
        inline = 'ok';
      } else {
        inline = 'not_found';
        issues.push(issue('inline_citation_missing', 'P1', `citation key is not cited in the manuscript: ${key}`, evidence.evidenceId));
      }
    } else if (kind === 'url') {
      citationKey = 'not_checked';
      citationMetadata = 'not_checked';
      inline = 'not_checked';
    } else {
      citationKey = 'missing';
      issues.push(issue('citation_locator_unknown', 'P1', `cannot resolve citation locator: ${locator}`, evidence.evidenceId));
    }
  }

  if (evidence.evidenceType === 'figure') {
    const number = figureNumber(locator);
    if (!number) {
      issues.push(issue('figure_locator_invalid', 'P1', `cannot parse figure locator: ${locator}`, evidence.evidenceId));
    } else if (!input.manuscript.figureRefs.includes(number)) {
      issues.push(issue('figure_ref_missing', 'P1', `figure ${number} is not referenced in the manuscript`, evidence.evidenceId));
    } else if (input.figures.length && !input.figures.some((name) => name.includes(number))) {
      issues.push(issue('figure_file_missing', 'P2', `no figure file matching ${number} in manuscript/figures`, evidence.evidenceId));
    }
  }

  if (evidence.evidenceType === 'table') {
    const number = tableNumber(locator);
    if (!number) {
      issues.push(issue('table_locator_invalid', 'P1', `cannot parse table locator: ${locator}`, evidence.evidenceId));
    } else if (!input.manuscript.tableRefs.includes(number)) {
      issues.push(issue('table_ref_missing', 'P1', `table ${number} is not referenced in the manuscript`, evidence.evidenceId));
    } else if (input.tables.length && !input.tables.some((name) => name.includes(number))) {
      issues.push(issue('table_file_missing', 'P2', `no table file matching ${number} in manuscript/tables`, evidence.evidenceId));
    }
  }

  if (evidence.evidenceType === 'none') {
    issues.push(issue('missing_evidence', 'P0', 'no evidence is attached to this claim', evidence.evidenceId));
  }

  return {
    citationKey,
    citationMetadata,
    retraction: 'not_checked',
    locator: locatorStatus,
    quote: quoteStatus,
    inline,
    issues: dedupeIssues(issues),
    blocking: issues.some((item) => item.severity === 'P0' || item.code === 'missing_locator' || item.code === 'missing_quote'),
  };
}

/** Bib entries that are never cited; report-level, not per evidence edge. */
export function orphanCitationKeys(manuscript: ParsedManuscript, bib: BibParseResult): string[] {
  const cited = new Set(manuscript.citations);
  return [...bib.entries.keys()].filter((key) => !cited.has(key)).sort();
}

function issue(
  code: string,
  severity: 'P0' | 'P1' | 'P2',
  message: string,
  evidenceId?: string,
): PrecheckIssue {
  return { code, severity, message, ...(evidenceId ? { evidenceId } : {}) };
}

function dedupeIssues(issues: PrecheckIssue[]): PrecheckIssue[] {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = `${item.code}\u0000${item.evidenceId ?? ''}\u0000${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function figureNumber(locator: string): string | undefined {
  const match = /\b(?:Fig(?:ure)?\.?)\s*([0-9]+[A-Za-z]?)/i.exec(locator);
  return match?.[1];
}

function tableNumber(locator: string): string | undefined {
  const match = /\bTable\s*([0-9]+[A-Za-z]?)/i.exec(locator);
  return match?.[1];
}
