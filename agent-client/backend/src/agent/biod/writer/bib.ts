export interface BibEntry {
  key: string;
  entryType: string;
  doi?: string;
  pmid?: string;
}

export interface BibParseResult {
  entries: Map<string, BibEntry>;
  warnings: string[];
}

const ENTRY_RE = /@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,/g;
const FIELD_RE = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:\\{([^}]*)\\}|"([^"]*)"|([^,\\n]+))`, 'i');

/** Lightweight BibTeX key/DOI/PMID reader; intentionally not a full BibTeX parser. */
export function parseBibTeX(content: string): BibParseResult {
  const entries = new Map<string, BibEntry>();
  const warnings: string[] = [];
  const text = String(content ?? '');
  const matches = [...text.matchAll(ENTRY_RE)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const key = match[2].trim();
    if (!key) continue;
    if (entries.has(key)) warnings.push(`duplicate BibTeX key: ${key}`);
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const body = text.slice(start, end);
    const doi = fieldValue(body, 'doi');
    const pmid = fieldValue(body, 'pmid');
    entries.set(key, {
      key,
      entryType: match[1].toLowerCase(),
      ...(doi ? { doi: normalizeDoi(doi) } : {}),
      ...(pmid ? { pmid: pmid.replace(/^pmid:\s*/i, '').trim() } : {}),
    });
  }
  return { entries, warnings };
}

export function normalizeDoi(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[>\s]+$/, '');
}

export function isValidDoi(value: string): boolean {
  return /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i.test(normalizeDoi(value));
}

export function isValidPmid(value: string): boolean {
  return /^\d{1,9}$/.test(String(value ?? '').trim());
}

/** A locator may be a DOI, a PMID, a URL, or a BibTeX key. */
export function citationLocatorKind(locator: string): 'doi' | 'pmid' | 'url' | 'bibkey' | 'unknown' {
  const value = String(locator ?? '').trim();
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(value) || /^doi:/i.test(value) || /^10\.\d{4,9}\//.test(value)) return 'doi';
  if (/^pmid:/i.test(value)) return 'pmid';
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^[A-Za-z][A-Za-z0-9_:.#$%&+?<>~/-]*$/.test(value)) return 'bibkey';
  return 'unknown';
}

export function citationKeyFromLocator(locator: string): string | undefined {
  const value = String(locator ?? '').trim();
  const kind = citationLocatorKind(value);
  if (kind === 'doi') return normalizeDoi(value);
  if (kind === 'pmid') return value.replace(/^pmid:\s*/i, '').trim();
  if (kind === 'bibkey') return value;
  return undefined;
}

function fieldValue(body: string, name: string): string | undefined {
  const match = FIELD_RE(name).exec(body);
  if (!match) return undefined;
  const value = match[1] ?? match[2] ?? match[3] ?? '';
  return value.trim() || undefined;
}
