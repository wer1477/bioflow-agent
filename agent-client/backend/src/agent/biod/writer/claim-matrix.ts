import {
  CLAIM_SECTIONS,
  CLAIM_TYPES,
  DEFAULT_CLAIM_MATRIX_LIMITS,
  EVIDENCE_TYPES,
  WRITER_CLAIM_STATUSES,
  WRITER_RELATIONS,
  type ClaimEvidenceRow,
  type ClaimMatrixLimits,
  type ParsedClaim,
} from './contracts.js';

export const CLAIM_MATRIX_COLUMNS = [
  'claim_id',
  'section',
  'claim_text',
  'claim_type',
  'evidence_id',
  'evidence_type',
  'evidence_locator',
  'evidence_quote',
  'evidence_scope',
  'writer_relation',
  'writer_status',
  'notes',
] as const;

export type ClaimMatrixFailure =
  | { ok: false; reason: 'empty_claim_matrix' | 'invalid_claim_matrix'; message: string }
  | { ok: true; claims: ParsedClaim[]; rows: ClaimEvidenceRow[] };

interface RawRow {
  claim_id?: string;
  section?: string;
  claim_text?: string;
  claim_type?: string;
  evidence_id?: string;
  evidence_type?: string;
  evidence_locator?: string;
  evidence_quote?: string;
  evidence_scope?: string;
  writer_relation?: string;
  writer_status?: string;
  notes?: string;
}

const CLAIM_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const EVIDENCE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * Parse `manuscript/claim-evidence.csv`.
 *
 * One data row is one claim-evidence edge. A claim with no evidence still has one row
 * (`evidence_id=NONE`), so the auditor can report the gap instead of silently skipping it.
 * This parser is intentionally strict: a malformed matrix is a Writer/workflow error, not
 * something the auditor should guess around.
 */
export function parseClaimMatrix(
  content: string,
  limits: Partial<ClaimMatrixLimits> = {},
): ClaimMatrixFailure {
  const effective: ClaimMatrixLimits = { ...DEFAULT_CLAIM_MATRIX_LIMITS, ...limits };
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) {
    return { ok: false, reason: 'empty_claim_matrix', message: 'claim-evidence.csv is empty' };
  }

  const parsed = parseCsvRows(text);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid_claim_matrix', message: `CSV parse failed: ${parsed.message}` };
  }
  const [headerRow, ...dataRows] = parsed.rows;
  if (!headerRow || !dataRows.length) {
    return { ok: false, reason: 'empty_claim_matrix', message: 'claim-evidence.csv has no data rows' };
  }
  const header = headerRow.map((cell) => cell.trim());
  const missing = CLAIM_MATRIX_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length) {
    return {
      ok: false,
      reason: 'invalid_claim_matrix',
      message: `missing column(s): ${missing.join(', ')}`,
    };
  }
  const records: RawRow[] = [];
  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index];
    if (row[0]?.trim().startsWith('#')) continue;
    if (row.length !== header.length) {
      return {
        ok: false,
        reason: 'invalid_claim_matrix',
        message: `line ${index + 2}: expected ${header.length} columns, got ${row.length}`,
      };
    }
    const record: Record<string, string> = {};
    for (let column = 0; column < header.length; column += 1) {
      record[header[column]] = row[column] ?? '';
    }
    records.push(record as RawRow);
  }
  if (!records.length) {
    return { ok: false, reason: 'empty_claim_matrix', message: 'claim-evidence.csv has no data rows' };
  }

  const rows: ClaimEvidenceRow[] = [];
  const claims = new Map<string, ParsedClaim>();
  const edgeKeys = new Set<string>();
  const evidenceIdentity = new Map<string, string>();

  for (let index = 0; index < records.length; index += 1) {
    const line = index + 2;
    const raw = records[index];
    const claimId = clean(raw.claim_id);
    const section = enumValue(raw.section, CLAIM_SECTIONS);
    const claimText = clean(raw.claim_text);
    const claimType = enumValue(raw.claim_type, CLAIM_TYPES);
    const evidenceId = clean(raw.evidence_id);
    const evidenceType = enumValue(raw.evidence_type, EVIDENCE_TYPES);
    const evidenceLocator = clean(raw.evidence_locator);
    const evidenceQuote = clean(raw.evidence_quote);
    const evidenceScope = clean(raw.evidence_scope);
    const writerRelation = enumValue(raw.writer_relation, WRITER_RELATIONS);
    const writerStatus = enumValue(raw.writer_status, WRITER_CLAIM_STATUSES);
    const notes = clean(raw.notes);

    if (!CLAIM_ID_RE.test(claimId)) {
      return invalid(line, `claim_id "${claimId}" must match ${CLAIM_ID_RE}`);
    }
    if (!section) return invalid(line, `section must be one of ${CLAIM_SECTIONS.join('/')}`);
    if (!claimType) return invalid(line, `claim_type must be one of ${CLAIM_TYPES.join('/')}`);
    if (!evidenceType) return invalid(line, `evidence_type must be one of ${EVIDENCE_TYPES.join('/')}`);
    if (!writerRelation) return invalid(line, `writer_relation must be one of ${WRITER_RELATIONS.join('/')}`);
    if (!writerStatus) return invalid(line, `writer_status must be one of ${WRITER_CLAIM_STATUSES.join('/')}`);
    if (!evidenceId) return invalid(line, 'evidence_id is required');
    if (evidenceId !== 'NONE' && !EVIDENCE_ID_RE.test(evidenceId)) {
      return invalid(line, `evidence_id "${evidenceId}" must match ${EVIDENCE_ID_RE} or be NONE`);
    }
    if (!claimText) return invalid(line, 'claim_text is required');
    if (claimText.length > 300) return invalid(line, `claim_text exceeds 300 characters (${claimText.length})`);
    if (evidenceLocator.length > 300) return invalid(line, `evidence_locator exceeds 300 characters (${evidenceLocator.length})`);
    if (evidenceQuote.length > effective.maxQuoteChars) {
      return invalid(line, `evidence_quote exceeds ${effective.maxQuoteChars} characters (${evidenceQuote.length})`);
    }
    if (evidenceScope.length > 200) return invalid(line, `evidence_scope exceeds 200 characters (${evidenceScope.length})`);
    if (notes.length > 300) return invalid(line, `notes exceeds 300 characters (${notes.length})`);

    if (evidenceType === 'none') {
      if (evidenceId !== 'NONE') return invalid(line, 'evidence_type=none requires evidence_id=NONE');
      if (evidenceLocator || evidenceQuote || evidenceScope) {
        return invalid(line, 'evidence_type=none requires empty locator/quote/scope');
      }
    } else {
      if (evidenceId === 'NONE') return invalid(line, `evidence_type=${evidenceType} requires a real evidence_id`);
      if (!evidenceLocator) return invalid(line, 'evidence_locator is required for non-none evidence');
    }

    const edgeKey = `${claimId}\u0000${evidenceId}`;
    if (edgeKeys.has(edgeKey)) return invalid(line, `duplicate claim/evidence edge ${claimId}/${evidenceId}`);
    edgeKeys.add(edgeKey);

    if (evidenceId !== 'NONE') {
      const identity = [evidenceType, evidenceLocator, evidenceQuote, evidenceScope].join('\u0000');
      const previous = evidenceIdentity.get(evidenceId);
      if (previous !== undefined && previous !== identity) {
        return invalid(line, `evidence_id ${evidenceId} has inconsistent type/locator/quote/scope across rows`);
      }
      evidenceIdentity.set(evidenceId, identity);
    }

    const row: ClaimEvidenceRow = {
      claimId,
      section,
      claimText,
      claimType,
      evidenceId,
      evidenceType,
      evidenceLocator,
      evidenceQuote,
      evidenceScope,
      writerRelation,
      writerStatus,
      notes,
    };
    rows.push(row);

    const existing = claims.get(claimId);
    if (!existing) {
      claims.set(claimId, {
        claimId,
        section,
        claimText,
        claimType,
        writerStatus,
        rows: [row],
        placements: [],
        stale: false,
        sectionMismatch: false,
      });
    } else {
      const existingHasNone = existing.rows.some((item) => item.evidenceType === 'none');
      if (existingHasNone !== (evidenceType === 'none')) {
        return invalid(line, `claim_id ${claimId} cannot mix evidence_type=none with real evidence`);
      }
      if (existing.section !== section || existing.claimText !== claimText || existing.claimType !== claimType) {
        return invalid(line, `claim_id ${claimId} has inconsistent section/claim_text/claim_type`);
      }
      if (existing.writerStatus !== writerStatus) {
        return invalid(line, `claim_id ${claimId} has inconsistent writer_status`);
      }
      existing.rows.push(row);
    }

    if (claims.size > effective.maxClaims) {
      return invalid(line, `claim count exceeds ${effective.maxClaims}`);
    }
    if (rows.length > effective.maxEdges) {
      return invalid(line, `edge count exceeds ${effective.maxEdges}`);
    }
  }

  return { ok: true, claims: [...claims.values()], rows };
}

interface CsvRowsResult {
  ok: boolean;
  rows: string[][];
  message?: string;
}

/** Minimal RFC4180 reader: quoted commas/newlines, doubled quotes, CRLF. */
function parseCsvRows(text: string): CsvRowsResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushRow = (): void => {
    row.push(field);
    field = '';
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field.trim() === '') {
        field = '';
        inQuotes = true;
      } else {
        field += char;
      }
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      pushRow();
    } else if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += char;
    }
  }
  if (inQuotes) return { ok: false, rows: [], message: 'unterminated quoted field' };
  if (field.length > 0 || row.length > 0) pushRow();
  return { ok: true, rows };
}

function invalid(line: number, message: string): ClaimMatrixFailure {
  return { ok: false, reason: 'invalid_claim_matrix', message: `line ${line}: ${message}` };
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  const text = clean(value);
  return (allowed as readonly string[]).includes(text) ? (text as T[number]) : undefined;
}
