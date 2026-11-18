import type { ClaimSection, ParsedClaim } from './contracts.js';

export interface ParsedManuscript {
  content: string;
  normalized: string;
  sections: Array<{ section: ClaimSection; text: string; normalized: string }>;
  citations: string[];
  citationStyle: 'pandoc' | 'latex' | 'numeric' | 'mixed' | 'none';
  figureRefs: string[];
  tableRefs: string[];
  headingCount: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const PANDOC_CITATION_RE = /\[[^\]]*@[^\]]*\]/g;
const PANDOC_KEY_RE = /@([A-Za-z0-9_:.#$%&+?<>~/-]+)/g;
const LATEX_CITATION_RE = /\\cite[pt]?\{([^}]+)\}/g;
const NUMERIC_CITATION_RE = /\[(\d+(?:\s*[-,]\s*\d+)*)\]/g;
const FIGURE_REF_RE = /\b(?:Fig(?:ure)?\.?)\s*([0-9]+[A-Za-z]?)/gi;
const TABLE_REF_RE = /\bTable\s*([0-9]+[A-Za-z]?)/gi;

/**
 * Parse the Markdown draft into section buckets and machine-readable reference markers.
 * The manuscript is the authority for claim text; the CSV is only an index into it.
 */
export function parseManuscript(content: string): ParsedManuscript {
  const source = String(content ?? '').replace(/^\uFEFF/, '');
  const withoutCode = stripFencedCode(source);
  const sections: ParsedManuscript['sections'] = [];
  let current: { section: ClaimSection; lines: string[] } = { section: 'unknown', lines: [] };
  let headingCount = 0;
  let firstHeading = true;

  for (const line of withoutCode.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current.lines.some((item) => item.trim())) {
        sections.push(toSection(current.section, current.lines.join('\n')));
      }
      headingCount += 1;
      const level = heading[1].length;
      const title = heading[2].trim();
      const section = sectionForHeading(title, level === 1 && firstHeading);
      current = { section, lines: [] };
      firstHeading = false;
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some((item) => item.trim()) || !sections.length) {
    sections.push(toSection(current.section, current.lines.join('\n')));
  }

  const citations = extractCitations(withoutCode);
  const citationStyle = detectCitationStyle(withoutCode);
  const figureRefs = uniqueMatches(withoutCode, FIGURE_REF_RE);
  const tableRefs = uniqueMatches(withoutCode, TABLE_REF_RE);

  return {
    content: source,
    normalized: normalizeClaimText(withoutCode),
    sections,
    citations,
    citationStyle,
    figureRefs,
    tableRefs,
    headingCount,
  };
}

/** Annotate CSV claims with their actual manuscript placements. */
export function annotateClaims(claims: ParsedClaim[], manuscript: ParsedManuscript): ParsedClaim[] {
  return claims.map((claim) => {
    const wanted = normalizeClaimText(claim.claimText);
    const placements = manuscript.sections
      .filter((section) => section.normalized.includes(wanted))
      .map((section) => section.section);
    const unique = [...new Set(placements)];
    return {
      ...claim,
      placements: unique,
      stale: unique.length === 0,
      sectionMismatch: unique.length > 0 && !unique.includes(claim.section),
    };
  });
}

/** Normalize a claim for substring matching; citation markers and Markdown emphasis are removed. */
export function normalizeClaimText(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[[^\]]*@[^\]]*\]/g, ' ')
    .replace(/\\cite[pt]?\{[^}]+\}/g, ' ')
    .replace(/[*_~]+/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSection(section: ClaimSection, text: string): ParsedManuscript['sections'][number] {
  return { section, text, normalized: normalizeClaimText(text) };
}

function sectionForHeading(title: string, isFirstH1: boolean): ClaimSection {
  const lower = title.toLowerCase();
  if (lower.includes('abstract') || lower.includes('摘要')) return 'abstract';
  if (lower.includes('introduction') || lower.includes('background') || lower.includes('引言') || lower.includes('背景')) return 'introduction';
  if (lower.includes('method') || lower.includes('materials') || lower.includes('方法')) return 'methods';
  if (lower.includes('result') || lower.includes('结果')) return 'results';
  if (lower.includes('discussion') || lower.includes('讨论')) return 'discussion';
  if (lower.includes('conclusion') || lower.includes('结论')) return 'conclusion';
  if (lower.includes('supplement') || lower.includes('补充')) return 'supplementary';
  if (isFirstH1) return 'title';
  return 'unknown';
}

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

function extractCitations(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(PANDOC_CITATION_RE)) {
    for (const key of match[0].matchAll(PANDOC_KEY_RE)) keys.add(key[1]);
  }
  for (const match of text.matchAll(LATEX_CITATION_RE)) {
    for (const key of match[1].split(',')) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return [...keys];
}

function detectCitationStyle(text: string): ParsedManuscript['citationStyle'] {
  const hasPandoc = PANDOC_CITATION_RE.test(text);
  PANDOC_CITATION_RE.lastIndex = 0;
  const hasLatex = LATEX_CITATION_RE.test(text);
  LATEX_CITATION_RE.lastIndex = 0;
  const hasNumeric = NUMERIC_CITATION_RE.test(text);
  NUMERIC_CITATION_RE.lastIndex = 0;
  if (hasPandoc && hasLatex) return 'mixed';
  if (hasPandoc) return 'pandoc';
  if (hasLatex) return 'latex';
  if (hasNumeric) return 'numeric';
  return 'none';
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found];
}
