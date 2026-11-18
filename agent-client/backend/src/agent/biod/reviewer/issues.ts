import { parse } from 'csv-parse/sync';
import {
  DEFAULT_ISSUE_MATRIX_LIMITS,
  ISSUE_SECTIONS,
  ISSUE_TYPES,
  PREMISE_KINDS,
  REVIEWER_ROLES,
  SEVERITY_CLAIMS,
  type IssueMatrixLimits,
  type IssuePremiseRow,
  type IssueSection,
  type IssueType,
  type ParsedIssue,
  type PremiseKind,
  type ReviewerRole,
  type SeverityClaim,
} from './contracts.js';

export const ISSUE_COLUMNS = [
  'issue_id',
  'section',
  'issue_text',
  'issue_type',
  'severity_claim',
  'premise_id',
  'premise_kind',
  'premise_text',
  'anchor_locator',
  'anchor_quote',
  'anchor_quote_2',
  'search_terms',
  'owner_suggested',
  'notes',
] as const;

export type IssueMatrixFailure =
  | { ok: false; reason: 'empty_issues' | 'invalid_issues'; message: string }
  | { ok: true; issues: ParsedIssue[]; rows: IssuePremiseRow[] };

interface RawRow {
  issue_id?: string;
  section?: string;
  issue_text?: string;
  issue_type?: string;
  severity_claim?: string;
  premise_id?: string;
  premise_kind?: string;
  premise_text?: string;
  anchor_locator?: string;
  anchor_quote?: string;
  anchor_quote_2?: string;
  search_terms?: string;
  owner_suggested?: string;
  notes?: string;
}

const ISSUE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PREMISE_ID_RE = /^P[1-9]$/;
const NONE = 'NONE';

/**
 * Parse `review/issues.csv`.
 *
 * One data row is one issue-premise edge. An issue that states no checkable premise keeps a
 * `PREMISE_ID=NONE` row so the auditor can report `no_checkable_premise` instead of dropping
 * it silently. The parser is strict on purpose: a malformed issue matrix is a Reviewer
 * workflow error, not something the auditor should guess around.
 */
export function parseIssueMatrix(
  content: string,
  limits: Partial<IssueMatrixLimits> = {},
): IssueMatrixFailure {
  const effective: IssueMatrixLimits = { ...DEFAULT_ISSUE_MATRIX_LIMITS, ...limits };
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) {
    return { ok: false, reason: 'empty_issues', message: 'issues.csv is empty' };
  }

  let records: RawRow[];
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: false,
      comment: '#',
    }) as RawRow[];
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_issues',
      message: `CSV parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!records.length) {
    return { ok: false, reason: 'empty_issues', message: 'issues.csv has no data rows' };
  }

  const first = records[0] as Record<string, unknown>;
  const missing = ISSUE_COLUMNS.filter((column) => !(column in first));
  if (missing.length) {
    return {
      ok: false,
      reason: 'invalid_issues',
      message: `missing column(s): ${missing.join(', ')}`,
    };
  }

  const rows: IssuePremiseRow[] = [];
  const issues = new Map<string, ParsedIssue>();
  const premiseKeys = new Set<string>();

  for (let index = 0; index < records.length; index += 1) {
    const line = index + 2;
    const raw = records[index];
    const issueId = clean(raw.issue_id);
    const section = enumValue(raw.section, ISSUE_SECTIONS);
    const issueText = clean(raw.issue_text);
    const issueType = enumValue(raw.issue_type, ISSUE_TYPES);
    const severityClaim = enumValue(raw.severity_claim, SEVERITY_CLAIMS);
    const premiseId = clean(raw.premise_id).toUpperCase();
    const premiseKind = enumValue(raw.premise_kind, PREMISE_KINDS);
    const premiseText = clean(raw.premise_text);
    const anchorLocator = clean(raw.anchor_locator);
    const anchorQuote = clean(raw.anchor_quote);
    const anchorQuote2 = clean(raw.anchor_quote_2);
    const searchTerms = splitTerms(raw.search_terms);
    const ownerSuggested = optionalEnumValue(raw.owner_suggested, REVIEWER_ROLES);
    const notes = clean(raw.notes);

    if (!ISSUE_ID_RE.test(issueId)) {
      return invalid(line, `issue_id "${issueId}" must match ${ISSUE_ID_RE}`);
    }
    if (!section) return invalid(line, `section must be one of ${ISSUE_SECTIONS.join('/')}`);
    if (!issueType) return invalid(line, `issue_type must be one of ${ISSUE_TYPES.join('/')}`);
    if (!severityClaim) return invalid(line, `severity_claim must be one of ${SEVERITY_CLAIMS.join('/')}`);
    if (!premiseKind) return invalid(line, `premise_kind must be one of ${PREMISE_KINDS.join('/')}`);
    if (raw.owner_suggested !== undefined && clean(raw.owner_suggested) && !ownerSuggested) {
      return invalid(line, `owner_suggested must be one of ${REVIEWER_ROLES.join('/')} or empty`);
    }
    if (!issueText) return invalid(line, 'issue_text is required');
    if (issueText.length > effective.maxIssueChars) {
      return invalid(line, `issue_text exceeds ${effective.maxIssueChars} characters (${issueText.length})`);
    }
    if (premiseText.length > effective.maxPremiseChars) {
      return invalid(line, `premise_text exceeds ${effective.maxPremiseChars} characters (${premiseText.length})`);
    }
    if (anchorLocator.length > 200) return invalid(line, `anchor_locator exceeds 200 characters (${anchorLocator.length})`);
    if (anchorQuote.length > effective.maxQuoteChars) {
      return invalid(line, `anchor_quote exceeds ${effective.maxQuoteChars} characters (${anchorQuote.length})`);
    }
    if (anchorQuote2.length > effective.maxQuoteChars) {
      return invalid(line, `anchor_quote_2 exceeds ${effective.maxQuoteChars} characters (${anchorQuote2.length})`);
    }
    if (notes.length > 300) return invalid(line, `notes exceeds 300 characters (${notes.length})`);
    if (searchTerms.length > effective.maxSearchTerms) {
      return invalid(line, `search_terms exceeds ${effective.maxSearchTerms} items (${searchTerms.length})`);
    }
    for (const term of searchTerms) {
      if (term.length > 60) return invalid(line, `search term "${term}" exceeds 60 characters`);
    }

    const premiseIdValid = premiseKind === 'none' ? premiseId === NONE : PREMISE_ID_RE.test(premiseId);
    if (!premiseIdValid) {
      return invalid(
        line,
        premiseKind === 'none'
          ? `premise_kind=none requires premise_id=${NONE}`
          : `premise_id "${premiseId}" must match ${PREMISE_ID_RE}`,
      );
    }

    if (premiseKind === 'none') {
      if (premiseText || anchorLocator || anchorQuote || anchorQuote2 || searchTerms.length) {
        return invalid(line, 'premise_kind=none requires empty premise_text/anchor/search_terms');
      }
    } else if (premiseKind === 'passage') {
      if (!premiseText) return invalid(line, 'premise_text is required for premise_kind=passage');
      if (!anchorQuote) return invalid(line, 'anchor_quote is required for premise_kind=passage');
      if (!anchorLocator) return invalid(line, 'anchor_locator is required for premise_kind=passage');
      if (anchorQuote2) return invalid(line, 'anchor_quote_2 is only used by premise_kind=conflict');
      if (searchTerms.length) return invalid(line, 'search_terms is only used by premise_kind=absence');
    } else if (premiseKind === 'conflict') {
      if (!premiseText) return invalid(line, 'premise_text is required for premise_kind=conflict');
      if (!anchorQuote) return invalid(line, 'anchor_quote is required for premise_kind=conflict');
      if (!anchorQuote2) return invalid(line, 'anchor_quote_2 is required for premise_kind=conflict');
      if (!anchorLocator) return invalid(line, 'anchor_locator is required for premise_kind=conflict');
      if (searchTerms.length) return invalid(line, 'search_terms is only used by premise_kind=absence');
    } else {
      if (!premiseText) return invalid(line, 'premise_text is required for premise_kind=absence');
      if (!searchTerms.length) return invalid(line, 'search_terms is required for premise_kind=absence');
      if (anchorQuote || anchorQuote2) {
        return invalid(line, 'premise_kind=absence must not carry anchor quotes; use premise_kind=passage');
      }
    }

    const premiseKey = `${issueId}\u0000${premiseId}`;
    if (premiseKeys.has(premiseKey)) return invalid(line, `duplicate premise ${premiseId} in issue ${issueId}`);
    premiseKeys.add(premiseKey);

    const row: IssuePremiseRow = {
      issueId,
      section,
      issueText,
      issueType,
      severityClaim,
      premiseId,
      premiseKind,
      premiseText,
      anchorLocator,
      anchorQuote,
      anchorQuote2,
      searchTerms,
      ...(ownerSuggested ? { ownerSuggested } : {}),
      notes,
    };
    rows.push(row);

    const existing = issues.get(issueId);
    if (!existing) {
      issues.set(issueId, {
        issueId,
        section,
        issueText,
        issueType,
        severityClaim,
        ...(ownerSuggested ? { ownerSuggested } : {}),
        premises: [row],
        duplicates: [],
      });
      if (issues.size > effective.maxIssues) {
        return invalid(line, `issue count exceeds ${effective.maxIssues}`);
      }
    } else {
      if (
        existing.section !== section
        || existing.issueText !== issueText
        || existing.issueType !== issueType
        || existing.severityClaim !== severityClaim
        || existing.ownerSuggested !== ownerSuggested
      ) {
        return invalid(line, `issue_id ${issueId} has inconsistent section/issue_text/issue_type/severity_claim/owner_suggested`);
      }
      existing.premises.push(row);
    }

    if (rows.length > effective.maxPremises) {
      return invalid(line, `premise count exceeds ${effective.maxPremises}`);
    }
  }

  return { ok: true, issues: [...issues.values()], rows };
}

function invalid(line: number, message: string): IssueMatrixFailure {
  return { ok: false, reason: 'invalid_issues', message: `line ${line}: ${message}` };
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function splitTerms(value: unknown): string[] {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const seen = new Set<string>();
  for (const part of text.split('|')) {
    const term = part.replace(/\s+/g, ' ').trim();
    if (term) seen.add(term);
  }
  return [...seen];
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  const text = clean(value);
  return (allowed as readonly string[]).includes(text) ? (text as T[number]) : undefined;
}

function optionalEnumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  const text = clean(value);
  if (!text) return undefined;
  return (allowed as readonly string[]).includes(text) ? (text as T[number]) : undefined;
}

export type { IssueSection, IssueType, PremiseKind, ReviewerRole, SeverityClaim };
