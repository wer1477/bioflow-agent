/**
 * Text replacement engine for `edit_file`.
 *
 * Models are bad at reproducing file text byte-for-byte: they drop trailing
 * whitespace, straighten smart quotes and use ASCII hyphens where the source has
 * en dashes. Exact matching therefore fails often, so this module also tries a
 * tolerant per-line match and reports actionable line numbers when a match is
 * ambiguous. All matching always runs against the *original* content; ranges are
 * then checked for overlap and composed in original coordinates.
 */
export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export type EditErrorCode = 'FS_EDIT_INVALID' | 'FS_EDIT_NOT_FOUND' | 'FS_EDIT_AMBIGUOUS' | 'FS_EDIT_NO_CHANGE' | 'FS_EDIT_OVERLAP';

export type TextEditResult =
  | { ok: true; content: string; replacements: number; diff: string }
  | { ok: false; error: { code: EditErrorCode; message: string } };

const MAX_EDITS = 20;
const MAX_DIFF_LINES = 120;
const DIFF_CONTEXT_LINES = 2;

interface LineIndex {
  lines: string[];
  /** Character offset of each line's first character in the LF view. */
  starts: number[];
}

interface ResolvedEditRange {
  editIndex: number;
  start: number;
  end: number;
  replacement: string;
}

interface FuzzyLineMatch {
  start: number;
  /** End of the last matched line's content (the following newline is not consumed). */
  end: number;
  lineNumber: number;
}

/**
 * Applies `edits` to `original` on an LF view and returns the updated content
 * (also LF). Callers that need to preserve CRLF convert the result back.
 */
export function applyTextEdits(original: string, edits: TextEdit[]): TextEditResult {
  if (!Array.isArray(edits) || !edits.length) return failure('FS_EDIT_INVALID', 'edit_file requires at least one edit.');
  if (edits.length > MAX_EDITS) {
    return failure('FS_EDIT_INVALID', `Too many edits (${edits.length}); edit_file accepts at most ${MAX_EDITS}. Split the change into several calls.`);
  }

  const lfOriginal = toLf(original);
  const index = buildLineIndex(lfOriginal);
  const ranges: ResolvedEditRange[] = [];

  for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {
    const edit = edits[editIndex];
    const label = edits.length > 1 ? `Edit ${editIndex + 1}/${edits.length}` : 'Edit';
    if (!edit || typeof edit !== 'object') {
      return failure('FS_EDIT_INVALID', `${label}: expected an object with old_string and new_string.`);
    }
    const oldString = toLf(String(edit.oldString ?? ''));
    const newString = toLf(String(edit.newString ?? ''));
    if (!oldString) return failure('FS_EDIT_INVALID', `${label}: old_string must not be empty.`);
    if (oldString === newString) return failure('FS_EDIT_NO_CHANGE', `${label}: old_string and new_string produce no change.`);

    const occurrences = findOccurrences(lfOriginal, oldString);
    if (occurrences.length) {
      if (!edit.replaceAll && occurrences.length > 1) {
        const lines = occurrences.map((start) => lineNumberAt(index, start));
        return failure(
          'FS_EDIT_AMBIGUOUS',
          `${label}: old_string matched ${occurrences.length} times (lines ${lines.join(', ')}); add more surrounding context or set replace_all=true.`,
        );
      }
      const selected = edit.replaceAll ? occurrences : [occurrences[0]];
      for (const start of selected) {
        ranges.push({ editIndex, start, end: start + oldString.length, replacement: newString });
      }
      continue;
    }

    const fuzzyMatches = findFuzzyLineMatches(index, oldString);
    if (!fuzzyMatches.length) {
      return failure('FS_EDIT_NOT_FOUND', `${label}: old_string was not found (exact or fuzzy).`);
    }
    if (fuzzyMatches.length > 1) {
      const lines = fuzzyMatches.map((match) => match.lineNumber);
      return failure(
        'FS_EDIT_AMBIGUOUS',
        `${label}: old_string matched ${fuzzyMatches.length} locations after fuzzy line normalization (lines ${lines.join(', ')}); add more surrounding context.`,
      );
    }
    const match = fuzzyMatches[0];
    ranges.push({ editIndex, start: match.start, end: match.end, replacement: fuzzyReplacement(newString) });
  }

  const ordered = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let cursor = 1; cursor < ordered.length; cursor += 1) {
    const previous = ordered[cursor - 1];
    const current = ordered[cursor];
    if (current.start < previous.end) {
      return failure(
        'FS_EDIT_OVERLAP',
        `Edits ${previous.editIndex + 1} and ${current.editIndex + 1} overlap at line ${lineNumberAt(index, current.start)}; make each old_string target a disjoint region.`,
      );
    }
  }

  // Overlaps were rejected above, so composing the original text from ascending
  // ranges is equivalent to applying them in reverse order - but it keeps every
  // range in original coordinates even when a zero-length fuzzy match sits on
  // another range's boundary.
  const orderedAscending = [...ordered].sort((left, right) => left.start - right.start || left.end - right.end);
  const parts: string[] = [];
  let cursor = 0;
  for (const range of orderedAscending) {
    parts.push(lfOriginal.slice(cursor, range.start), range.replacement);
    cursor = range.end;
  }
  parts.push(lfOriginal.slice(cursor));
  const content = parts.join('');

  return { ok: true, content, replacements: ordered.length, diff: buildUnifiedDiff(lfOriginal, content) };
}

function toLf(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function failure(code: EditErrorCode, message: string): TextEditResult {
  return { ok: false, error: { code, message } };
}

function findOccurrences(content: string, needle: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const found = content.indexOf(needle, offset);
    if (found < 0) break;
    starts.push(found);
    offset = found + needle.length;
  }
  return starts;
}

function buildLineIndex(content: string): LineIndex {
  const lines = content.split('\n');
  const starts: number[] = new Array(lines.length);
  let offset = 0;
  for (let line = 0; line < lines.length; line += 1) {
    starts[line] = offset;
    offset += lines[line].length + 1;
  }
  return { lines, starts };
}

function lineNumberAt(index: LineIndex, offset: number): number {
  let low = 0;
  let high = index.starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (index.starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Fuzzy matcher: compares normalized whole lines, tolerating trailing whitespace,
 * NFKC-compatible characters, smart quotes, dash variants and non-breaking
 * spaces. Only exact line runs are accepted - partial-line fuzzy matching would
 * make ambiguous edits far more likely.
 */
function findFuzzyLineMatches(index: LineIndex, oldString: string): FuzzyLineMatch[] {
  const needleLines = trimTrailingEmptyLines(toLf(oldString).split('\n'));
  if (!needleLines.length) return [];
  const normalizedNeedle = needleLines.map(normalizeFuzzyLine);

  const matches: FuzzyLineMatch[] = [];
  const lastStart = index.lines.length - needleLines.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let line = 0; line < needleLines.length; line += 1) {
      if (normalizeFuzzyLine(index.lines[start + line]) !== normalizedNeedle[line]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const lastLine = start + needleLines.length - 1;
    matches.push({
      start: index.starts[start],
      end: index.starts[lastLine] + index.lines[lastLine].length,
      lineNumber: start + 1,
    });
  }
  return matches;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

function fuzzyReplacement(newString: string): string {
  return trimTrailingEmptyLines(toLf(newString).split('\n')).join('\n');
}

const FUZZY_PUNCTUATION: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"'],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-'],
  [/[\u00A0\u2007\u2009\u200A\u202F\u205F]/g, ' '],
];

function normalizeFuzzyLine(line: string): string {
  let normalized = line.normalize('NFKC');
  for (const [pattern, replacement] of FUZZY_PUNCTUATION) normalized = normalized.replace(pattern, replacement);
  return normalized.trimEnd();
}

/**
 * Minimal unified diff for tool results/UI: one hunk with a few context lines,
 * bounded in size. The file path is added by the caller because this module only
 * knows the text.
 */
function buildUnifiedDiff(original: string, updated: string): string {
  if (original === updated) return '';
  const before = original.split('\n');
  const after = updated.split('\n');

  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextStart = Math.max(0, prefix - DIFF_CONTEXT_LINES);
  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);
  const contextAfter = before.slice(before.length - suffix, before.length - suffix + DIFF_CONTEXT_LINES);

  const body: string[] = [];
  for (let line = contextStart; line < prefix; line += 1) body.push(` ${before[line]}`);
  for (const line of beforeMiddle) body.push(`-${line}`);
  for (const line of afterMiddle) body.push(`+${line}`);
  for (const line of contextAfter) body.push(` ${line}`);

  const contextBeforeCount = prefix - contextStart;
  const oldCount = contextBeforeCount + beforeMiddle.length + contextAfter.length;
  const newCount = contextBeforeCount + afterMiddle.length + contextAfter.length;
  const header = `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`;

  const truncated = body.length > MAX_DIFF_LINES;
  const shown = truncated ? body.slice(0, MAX_DIFF_LINES) : body;
  return [header, ...shown, ...(truncated ? ['... (diff truncated)'] : [])].join('\n');
}
