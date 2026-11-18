import type { AnchorLocation, IssueSection } from './contracts.js';

export interface DocumentParagraph {
  section: IssueSection;
  paragraphIndex: number;
  text: string;
  normalized: string;
}

export interface DocumentSection {
  section: IssueSection;
  heading: string;
  /** Reference lists are excluded from absence search: citing a work is not reporting it. */
  isReferences: boolean;
  text: string;
  normalized: string;
  paragraphs: DocumentParagraph[];
}

export interface ParsedDocument {
  content: string;
  title: string;
  sections: DocumentSection[];
  /** Issue sections that actually exist in the document. */
  sectionNames: IssueSection[];
  paragraphCount: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const REFERENCE_HEADING_RE = /^(references?|bibliography|works cited|参考文献|引用文献)\b/i;
const ELLIPSIS_RE = /\s*(?:…|\.\.\.)\s*/;
const MAX_ANCHOR_FRAGMENTS = 5;

/**
 * Parse the reviewed Markdown document into sections and paragraphs.
 *
 * Reviewer V1 needs paragraph windows (to hand the scorer the passage around an anchor) and
 * section names (to notice an issue that points at a section the document does not have).
 * This parser is deliberately independent from Writer W1's: the Reviewer audits a document
 * that may not be a manuscript and must not inherit claim/evidence semantics.
 */
export function parseDocument(content: string): ParsedDocument {
  const source = String(content ?? '').replace(/^\uFEFF/, '');
  const withoutCode = stripFencedCode(source);
  const sections: DocumentSection[] = [];
  let current: { section: IssueSection; heading: string; lines: string[] } = {
    section: 'unknown',
    heading: '',
    lines: [],
  };
  let headingCount = 0;
  let firstHeading = true;
  let title = '';

  for (const line of withoutCode.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current.lines.some((item) => item.trim())) {
        sections.push(toSection(current.section, current.heading, current.lines.join('\n')));
      }
      headingCount += 1;
      const headingTitle = heading[2].trim();
      const level = heading[1].length;
      if (level === 1 && firstHeading && !title) title = headingTitle;
      firstHeading = false;
      current = {
        section: sectionForHeading(headingTitle, level === 1 && headingCount === 1),
        heading: headingTitle,
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some((item) => item.trim()) || !sections.length) {
    sections.push(toSection(current.section, current.heading, current.lines.join('\n')));
  }
  if (!title) {
    const firstLine = withoutCode.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    title = firstLine && !HEADING_RE.test(firstLine) ? clip(firstLine, 160) : '';
  }

  const sectionNames = [...new Set(sections.map((section) => section.section))];
  const paragraphCount = sections.reduce((sum, section) => sum + section.paragraphs.length, 0);
  return { content: source, title, sections, sectionNames, paragraphCount };
}

/**
 * Locate a verbatim anchor quote in the document.
 *
 * A quote may use `…` / `...` to join fragments from different places; every fragment must
 * be present, in order, inside one section. No fuzzy matching: an anchor that cannot be
 * found verbatim is reported as missing instead of quietly matching a paraphrase.
 */
export function locateAnchor(
  document: ParsedDocument,
  quote: string,
  maxPassageChars: number,
): AnchorLocation {
  const fragments = String(quote ?? '')
    .split(ELLIPSIS_RE)
    .map((fragment) => normalizeText(fragment))
    .filter(Boolean)
    .slice(0, MAX_ANCHOR_FRAGMENTS);
  if (!fragments.length) {
    return { found: false, ambiguous: false, missingFragments: [] };
  }

  for (const section of document.sections) {
    const positions: number[] = [];
    let cursor = 0;
    const missing: string[] = [];
    for (const fragment of fragments) {
      const index = section.paragraphs.findIndex(
        (paragraph, paragraphIndex) => paragraphIndex >= cursor && paragraph.normalized.includes(fragment),
      );
      if (index < 0) {
        missing.push(fragment);
        continue;
      }
      positions.push(index);
      cursor = index;
    }
    if (missing.length || positions.length !== fragments.length) continue;

    const start = positions[0];
    const end = positions[positions.length - 1];
    const passage = buildPassage(section.paragraphs, start, end, maxPassageChars);
    const anchorText = buildAnchorText(section.paragraphs, start, end, maxPassageChars);
    const ambiguous = countSectionsContaining(document, fragments[0]) > 1;
    return {
      found: true,
      section: section.section,
      paragraphIndex: start,
      passage,
      anchorText,
      ambiguous,
      missingFragments: [],
    };
  }

  // Not found in any single section: report every fragment that no section contains.
  const missingFragments = fragments.filter((fragment) => countSectionsContaining(document, fragment) === 0);
  return {
    found: false,
    ambiguous: false,
    missingFragments: missingFragments.length ? missingFragments : fragments,
  };
}

/** Search absence terms in non-reference paragraphs; first hit wins. */
export function searchAbsenceTerms(
  document: ParsedDocument,
  terms: string[],
): { terms: string[]; hit?: { term: string; section: IssueSection; paragraphIndex: number; excerpt: string }; searchedSections: number } {
  const searched = document.sections.filter((section) => !section.isReferences);
  for (const term of terms) {
    const wanted = normalizeText(term).toLowerCase();
    if (!wanted) continue;
    for (const section of searched) {
      for (const paragraph of section.paragraphs) {
        if (paragraph.normalized.toLowerCase().includes(wanted)) {
          return {
            terms,
            hit: {
              term,
              section: section.section,
              paragraphIndex: paragraph.paragraphIndex,
              excerpt: clip(paragraph.text, 200),
            },
            searchedSections: searched.length,
          };
        }
      }
    }
  }
  return { terms, searchedSections: searched.length };
}

/** Normalize text for matching; Markdown emphasis and citation markers are removed. */
export function normalizeText(text: string): string {
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

function toSection(section: IssueSection, heading: string, text: string): DocumentSection {
  const paragraphs: DocumentParagraph[] = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, paragraphIndex) => ({
      section,
      paragraphIndex,
      text: paragraph,
      normalized: normalizeText(paragraph),
    }));
  return {
    section,
    heading,
    isReferences: REFERENCE_HEADING_RE.test(heading),
    text,
    normalized: normalizeText(text),
    paragraphs,
  };
}

function buildPassage(
  paragraphs: DocumentParagraph[],
  start: number,
  end: number,
  maxPassageChars: number,
): string {
  const from = Math.max(0, start - 1);
  const to = Math.min(paragraphs.length - 1, end + 1);
  const parts: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const paragraph = paragraphs[index];
    if (paragraph) parts.push(paragraph.text);
  }
  const joined = parts.join('\n\n');
  return joined.length <= maxPassageChars ? joined : `${joined.slice(0, Math.max(0, maxPassageChars - 1))}…`;
}

function buildAnchorText(
  paragraphs: DocumentParagraph[],
  start: number,
  end: number,
  maxPassageChars: number,
): string {
  const parts: string[] = [];
  for (let index = start; index <= end; index += 1) {
    const paragraph = paragraphs[index];
    if (paragraph) parts.push(paragraph.text);
  }
  const joined = parts.join('\n\n');
  return joined.length <= maxPassageChars ? joined : `${joined.slice(0, Math.max(0, maxPassageChars - 1))}…`;
}

function countSectionsContaining(document: ParsedDocument, fragment: string): number {
  return document.sections.filter((section) => section.normalized.includes(fragment)).length;
}

function sectionForHeading(title: string, isFirstH1: boolean): IssueSection {
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

function clip(value: string, maxChars: number): string {
  const text = String(value ?? '').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
