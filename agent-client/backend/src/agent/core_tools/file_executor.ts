import fs from 'node:fs';
import { APPLY_PATCH_TOOL_NAME, EDIT_FILE_TOOL_NAME, READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME } from './ids.js';
import type { CoreToolExecutionContext } from '../core_tools_runtime.js';
import { applyTextEdits, type TextEdit } from './edit_diff.js';
import {
  atomicWriteFile,
  invalidateFileObservation,
  recordFileObservation,
  verifyFileObservation,
  withFileMutationQueue,
  type FileSafetyFailure,
} from './file_state.js';
import { MAX_IMAGE_BYTES, readMediaFile, type MediaReadResult } from './read_media.js';
import { resolveToolRoot } from './project_paths.js';
import { clampNumber, resolveTerminalPath } from './shared.js';

const DEFAULT_FILE_READ_LINES = 2_000;
const DEFAULT_FILE_READ_CHARS = 50_000;

interface UnifiedFilePatch { oldPath: string | null; newPath: string | null; hunks: UnifiedHunk[]; }
interface UnifiedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
  /** A `\ No newline at end of file` marker follows a new-side line of this hunk. */
  newSideNoNewline?: boolean;
}

interface PatchPlan {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  hunks: number;
  contentLf?: string;
  lineEnding: '\n' | '\r\n';
}

type ParsedTextEdits = { ok: true; value: TextEdit[] } | { ok: false; failure: Record<string, unknown> };
type PatchPlanResult = { ok: true; plans: PatchPlan[] } | { ok: false; failure: Record<string, unknown> };

export async function executeFileTool(
  toolName: string,
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
): Promise<Record<string, unknown>> {
  try {
    const cwd = resolveTerminalPath(args.workdir, resolveToolRoot(context));
    if (toolName === READ_FILE_TOOL_NAME) return await executeReadFile(args, context, cwd);
    if (toolName === WRITE_FILE_TOOL_NAME) return await executeWriteFile(args, context, cwd);
    if (toolName === EDIT_FILE_TOOL_NAME) return await executeEditFile(args, context, cwd);
    if (toolName === APPLY_PATCH_TOOL_NAME) return await executeApplyPatch(args, context, cwd);
    return failure('FS_TOOL_FAILED', `Unsupported file tool: ${toolName}`);
  } catch (err) {
    return failure('FS_TOOL_FAILED', errorMessage(err));
  }
}


async function executeReadFile(
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
  cwd: string,
): Promise<Record<string, unknown>> {
  const target = resolveTerminalPath(args.file_path, cwd);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(target);
  } catch (err) {
    return failure('FS_READ_FAILED', `Could not read ${target}: ${errorMessage(err)}`);
  }

  const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
  if (encoding === 'base64') {
    const maxChars = clampNumber(args.max_chars, DEFAULT_FILE_READ_CHARS, 1_000, 200_000);
    const base64Length = Math.ceil(stat.size / 3) * 4;
    if (base64Length > maxChars) {
      return failure('FS_READ_FAILED', `Base64 content for ${target} exceeds max_chars (${maxChars}).`);
    }
    const buffer = await fs.promises.readFile(target);
    recordFileObservation(context.conversationId, target);
    return { ok: true, path: target, encoding, size: stat.size, content: buffer.toString('base64'), truncated: false };
  }

  const pages = typeof args.pages === 'string' && args.pages.trim() ? args.pages.trim() : undefined;
  let media: MediaReadResult | null = null;
  try {
    media = await readMediaFile(target, { pages });
  } catch (err) {
    // The media reader rejects files it recognizes but cannot deliver (for
    // example an image above MAX_IMAGE_BYTES); report that instead of falling
    // through to the binary-text refusal.
    return failure('FS_READ_FAILED', `${errorMessage(err)} Call read_file with encoding="base64" to read the raw bytes.`);
  }
  if (media) {
    if (media.kind === 'image' && media.size > MAX_IMAGE_BYTES) {
      return failure(
        'FS_READ_FAILED',
        `Image file ${target} is ${media.size} bytes; read_file returns images up to ${MAX_IMAGE_BYTES} bytes. Call read_file with encoding="base64" to read the raw bytes.`,
      );
    }
    recordFileObservation(context.conversationId, target);
    return formatMediaResult(target, media);
  }

  try {
    if (isLikelyBinaryBuffer(await readFileSample(target))) {
      return failure(
        'FS_READ_FAILED',
        `Refusing to decode binary file ${target}. Call read_file with encoding="base64" if raw content is required.`,
      );
    }
    const offset = clampNumber(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = clampNumber(args.limit, DEFAULT_FILE_READ_LINES, 1, DEFAULT_FILE_READ_LINES);
    const maxChars = clampNumber(args.max_chars, DEFAULT_FILE_READ_CHARS, 1_000, 200_000);
    const result = await readTextFile(target, stat.size, offset, limit, maxChars);
    recordFileObservation(context.conversationId, target);
    return result;
  } catch (err) {
    return failure('FS_READ_FAILED', errorMessage(err));
  }
}


function formatMediaResult(target: string, media: MediaReadResult): Record<string, unknown> {
  if (media.kind === 'image') {
    return { ok: true, path: target, size: media.size, mimeType: media.mimeType, images: [media.image] };
  }
  return {
    ok: true,
    path: target,
    size: media.size,
    mimeType: 'application/pdf',
    page_count: media.pageCount,
    content: media.text,
    ...(media.images.length ? { images: media.images } : {}),
    ...(media.warnings.length ? { warnings: media.warnings } : {}),
  };
}


async function executeWriteFile(
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
  cwd: string,
): Promise<Record<string, unknown>> {
  const target = resolveTerminalPath(args.file_path, cwd);
  const safety = verifyFileObservation(context.conversationId, target);
  if (safety) return safetyFailure(safety);

  const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
  const content = String(args.content ?? '');
  const data = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
  try {
    const size = await withFileMutationQueue([target], async () => {
      await atomicWriteFile(target, data);
      recordFileObservation(context.conversationId, target);
      return (await fs.promises.stat(target)).size;
    });
    return { ok: true, path: target, encoding, size };
  } catch (err) {
    return failure('FS_WRITE_FAILED', `Failed to write ${target}: ${errorMessage(err)}`);
  }
}


async function executeEditFile(
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
  cwd: string,
): Promise<Record<string, unknown>> {
  const target = resolveTerminalPath(args.file_path, cwd);
  const parsedEdits = parseTextEdits(args);
  if (!parsedEdits.ok) return parsedEdits.failure;
  const safety = verifyFileObservation(context.conversationId, target);
  if (safety) return safetyFailure(safety);

  let original: string;
  try {
    original = await fs.promises.readFile(target, 'utf8');
  } catch (err) {
    return failure('FS_READ_FAILED', `Could not read ${target}: ${errorMessage(err)}`);
  }

  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  const normalizedOriginal = original.replace(/\r\n/g, '\n');
  const result = applyTextEdits(normalizedOriginal, parsedEdits.value);
  if (!result.ok) return failure(result.error.code, result.error.message);

  const updated = lineEnding === '\n' ? result.content : result.content.replace(/\n/g, lineEnding);
  try {
    const size = await withFileMutationQueue([target], async () => {
      await atomicWriteFile(target, updated);
      recordFileObservation(context.conversationId, target);
      return Buffer.byteLength(updated);
    });
    return { ok: true, path: target, replacements: result.replacements, diff: result.diff, size };
  } catch (err) {
    return failure('FS_WRITE_FAILED', `Failed to edit ${target}: ${errorMessage(err)}`);
  }
}


function parseTextEdits(args: Record<string, unknown>): ParsedTextEdits {
  const rawEdits = args.edits;
  if (rawEdits !== undefined && rawEdits !== null) {
    if (!Array.isArray(rawEdits)) {
      return { ok: false, failure: failure('FS_EDIT_INVALID', 'edits must be an array of {old_string, new_string} objects.') };
    }
    const value: TextEdit[] = [];
    for (let index = 0; index < rawEdits.length; index += 1) {
      const item = rawEdits[index];
      if (!item || typeof item !== 'object') {
        return { ok: false, failure: failure('FS_EDIT_INVALID', `edits[${index}] must be an object with old_string and new_string.`) };
      }
      const record = item as Record<string, unknown>;
      value.push({
        oldString: String(record.oldString ?? record.old_string ?? ''),
        newString: String(record.newString ?? record.new_string ?? ''),
        replaceAll: record.replaceAll === true || record.replace_all === true,
      });
    }
    if (!value.length) return { ok: false, failure: failure('FS_EDIT_INVALID', 'edit_file requires at least one edit.') };
    return { ok: true, value };
  }

  if (args.old_string === undefined && args.oldString === undefined) {
    return { ok: false, failure: failure('FS_EDIT_INVALID', 'edit_file requires edits or old_string/new_string.') };
  }
  return {
    ok: true,
    value: [{
      oldString: String(args.old_string ?? args.oldString ?? ''),
      newString: String(args.new_string ?? args.newString ?? ''),
      replaceAll: args.replace_all === true || args.replaceAll === true,
    }],
  };
}


async function executeApplyPatch(
  args: Record<string, unknown>,
  context: CoreToolExecutionContext,
  cwd: string,
): Promise<Record<string, unknown>> {
  const patch = String(args.patch ?? '');
  if (!patch.trim()) return failure('FS_PATCH_INVALID', 'apply_patch requires patch.');

  const planned = await planUnifiedPatch(patch, cwd, context.conversationId);
  if (!planned.ok) return planned.failure;

  const completed: Array<Record<string, unknown>> = [];
  let activePath = planned.plans[0]?.path ?? '';
  try {
    await withFileMutationQueue(planned.plans.map((plan) => plan.path), async () => {
      for (const plan of planned.plans) {
        activePath = plan.path;
        if (plan.change === 'deleted') {
          await fs.promises.rm(plan.path, { force: true });
          invalidateFileObservation(context.conversationId, plan.path);
        } else {
          const lfContent = plan.contentLf ?? '';
          const content = plan.lineEnding === '\r\n' ? lfContent.replace(/\n/g, '\r\n') : lfContent;
          await atomicWriteFile(plan.path, content);
          recordFileObservation(context.conversationId, plan.path);
        }
        completed.push({ path: plan.path, change: plan.change, hunks: plan.hunks });
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'FS_PATCH_WRITE_FAILED',
        message: `Failed to write ${activePath}: ${errorMessage(err)}. ${completed.length}/${planned.plans.length} file(s) were written before the failure.`,
      },
      completed,
    };
  }
  return { ok: true, cwd, files: completed, count: completed.length };
}


/**
 * Validates every target and computes its new content without touching disk, so
 * a bad hunk in the second file cannot leave the first one half-patched. Stale
 * or unread existing targets are rejected in this phase too.
 */
async function planUnifiedPatch(
  patch: string,
  cwd: string,
  conversationId: string | undefined,
): Promise<PatchPlanResult> {
  let filePatches: UnifiedFilePatch[];
  try {
    filePatches = parseUnifiedPatch(patch);
  } catch (err) {
    return { ok: false, failure: failure('FS_PATCH_INVALID', errorMessage(err)) };
  }
  if (!filePatches.length) {
    return { ok: false, failure: failure('FS_PATCH_INVALID', 'No unified diff file patches were found.') };
  }

  const plans = new Map<string, PatchPlan>();
  const verified = new Set<string>();
  for (const filePatch of filePatches) {
    const targetPath = resolveTerminalPath(filePatch.newPath || filePatch.oldPath, cwd);
    const exists = fs.existsSync(targetPath);
    if (exists && !verified.has(targetPath)) {
      const safety = verifyFileObservation(conversationId, targetPath);
      if (safety) return { ok: false, failure: safetyFailure(safety) };
      verified.add(targetPath);
    }
    if (!filePatch.hunks.length) {
      return { ok: false, failure: failure('FS_PATCH_INVALID', `No hunks found for ${targetPath}.`) };
    }
    if (filePatch.newPath === null) {
      if (!exists) {
        return { ok: false, failure: failure('FS_PATCH_INVALID', `Cannot delete ${targetPath}: file does not exist.`) };
      }
      plans.set(targetPath, { path: targetPath, change: 'deleted', hunks: filePatch.hunks.length, lineEnding: '\n' });
      continue;
    }

    const diskRaw = exists ? await fs.promises.readFile(targetPath, 'utf8') : '';
    const previousPlan = plans.get(targetPath);
    const baseLf = previousPlan?.contentLf ?? diskRaw.replace(/\r\n/g, '\n');
    let updatedLf: string;
    try {
      updatedLf = applyFilePatchHunks(filePatch, baseLf, targetPath);
    } catch (err) {
      return { ok: false, failure: failure('FS_PATCH_INVALID', errorMessage(err)) };
    }
    plans.set(targetPath, {
      path: targetPath,
      change: filePatch.oldPath === null ? 'created' : 'modified',
      hunks: filePatch.hunks.length,
      contentLf: updatedLf,
      lineEnding: diskRaw.includes('\r\n') ? '\r\n' : '\n',
    });
  }
  return { ok: true, plans: [...plans.values()] };
}


function applyFilePatchHunks(filePatch: UnifiedFilePatch, originalLf: string, targetPath: string): string {
  const originalEndsWithNewline = originalLf.endsWith('\n');
  const updatedLines = originalLf ? originalLf.slice(0, originalEndsWithNewline ? -1 : undefined).split('\n') : [];
  const hunksByOldStart = [...filePatch.hunks].sort((left, right) => left.oldStart - right.oldStart);
  const lastHunk = hunksByOldStart[hunksByOldStart.length - 1];

  for (const hunk of [...hunksByOldStart].sort((left, right) => right.oldStart - left.oldStart)) {
    const oldLines = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1));
    const newLines = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('+'))
      .map((line) => line.slice(1));
    const index = locatePatchHunk(updatedLines, oldLines, hunk, targetPath);
    updatedLines.splice(index, oldLines.length, ...newLines);
  }

  const keepTrailingNewline = originalEndsWithNewline && updatedLines.length > 0 && !lastHunk?.newSideNoNewline;
  return updatedLines.join('\n') + (keepTrailingNewline ? '\n' : '');
}


function locatePatchHunk(lines: string[], oldLines: string[], hunk: UnifiedHunk, targetPath: string): number {
  if (!oldLines.length) {
    // Creation/append hunks have no old-side lines; use the hunk header anchor.
    return Math.min(Math.max(hunk.oldStart, 0), lines.length);
  }

  const expectedIndex = Math.max(0, hunk.oldStart - 1);
  if (lineSequenceMatches(lines, oldLines, expectedIndex, identity)) return expectedIndex;

  const exactMatches = collectPatchMatches(lines, oldLines, identity);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) throw patchAmbiguityError(targetPath, hunk, exactMatches);

  const trimEndMatches = collectPatchMatches(lines, oldLines, trimEnd);
  if (trimEndMatches.length === 1) return trimEndMatches[0];
  if (trimEndMatches.length > 1) throw patchAmbiguityError(targetPath, hunk, trimEndMatches);

  const trimMatches = collectPatchMatches(lines, oldLines, trim);
  if (trimMatches.length === 1) return trimMatches[0];
  if (trimMatches.length > 1) throw patchAmbiguityError(targetPath, hunk, trimMatches);

  throw new Error(
    `Patch context was not found for ${targetPath} near line ${hunk.oldStart}; expected original line(s): ${formatExpectedLines(oldLines)}. Re-read the file and regenerate the patch.`,
  );
}


function collectPatchMatches(lines: string[], expected: string[], normalize: (line: string) => string): number[] {
  const normalizedExpected = expected.map(normalize);
  const matches: number[] = [];
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (normalize(lines[index + offset]) !== normalizedExpected[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(index);
  }
  return matches;
}


function lineSequenceMatches(lines: string[], expected: string[], index: number, normalize: (line: string) => string): boolean {
  if (index < 0 || index + expected.length > lines.length) return false;
  return expected.every((line, offset) => normalize(lines[index + offset]) === normalize(line));
}


function patchAmbiguityError(targetPath: string, hunk: UnifiedHunk, matches: number[]): Error {
  const lineNumbers = matches.map((index) => index + 1).join(', ');
  return new Error(
    `Patch context is ambiguous for ${targetPath} near line ${hunk.oldStart}; ${matches.length} candidate locations at lines ${lineNumbers}. Add more context lines to the patch.`,
  );
}


function formatExpectedLines(oldLines: string[]): string {
  if (!oldLines.length) return '(none)';
  const shown = oldLines.slice(0, 4).map((line) => JSON.stringify(line));
  return shown.join(', ') + (oldLines.length > shown.length ? ', ...' : '');
}


function identity(line: string): string {
  return line;
}


function trimEnd(line: string): string {
  return line.trimEnd();
}


function trim(line: string): string {
  return line.trim();
}


async function readFileSample(target: string): Promise<Buffer> {
  const handle = await fs.promises.open(target, 'r');
  try {
    const sample = Buffer.alloc(8_192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}


async function readTextFile(target: string, size: number, offset: number, limit: number, maxChars: number): Promise<Record<string, unknown>> {
  const stream = fs.createReadStream(target, { encoding: 'utf8' });
  const returned: string[] = [];
  let returnedChars = 0;
  let lineNumber = 1;
  let lineBuffer = '';
  let lineTooLong = false;
  let hasMore = false;
  let fullyRead = true;
  let hasInput = false;
  let endsWithNewline = false;

  const appendLineFragment = (fragment: string) => {
    if (lineNumber < offset || returned.length >= limit || lineTooLong) return;
    const remaining = maxChars + 1 - lineBuffer.length;
    if (fragment.length > remaining) {
      lineBuffer += fragment.slice(0, Math.max(0, remaining));
      lineTooLong = true;
      return;
    }
    lineBuffer += fragment;
  };

  const finishLine = (): boolean => {
    if (lineNumber < offset) {
      lineNumber += 1;
      lineBuffer = '';
      lineTooLong = false;
      return false;
    }
    if (returned.length >= limit) {
      hasMore = true;
      return true;
    }
    const line = lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer;
    const numberedLine = `${lineNumber}\t${line}`;
    const nextLength = returnedChars + (returned.length ? 1 : 0) + numberedLine.length;
    if (lineTooLong || nextLength > maxChars) {
      if (!returned.length) {
        throw new Error(`Line ${lineNumber} exceeds max_chars (${maxChars}). Use a larger max_chars value.`);
      }
      hasMore = true;
      return true;
    }
    returned.push(numberedLine);
    returnedChars = nextLength;
    lineNumber += 1;
    lineBuffer = '';
    lineTooLong = false;
    return false;
  };

  streamLoop: for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      if (newline < 0) {
        if (start < chunk.length) {
          hasInput = true;
          endsWithNewline = false;
        }
        appendLineFragment(chunk.slice(start));
        break;
      }
      hasInput = true;
      endsWithNewline = true;
      appendLineFragment(chunk.slice(start, newline));
      if (finishLine()) {
        fullyRead = false;
        break streamLoop;
      }
      start = newline + 1;
    }
  }

  if (fullyRead && (lineBuffer.length || lineTooLong || !hasInput || endsWithNewline) && finishLine()) fullyRead = false;
  const totalLines = lineNumber - 1;
  if (fullyRead && offset > totalLines) {
    throw new Error(`offset ${offset} is beyond end of file (${totalLines} lines total).`);
  }
  const returnedLines = returned.length;
  return {
    ok: true,
    path: target,
    encoding: 'utf8',
    size,
    ...(fullyRead ? { total_lines: totalLines } : {}),
    offset,
    returned_lines: returnedLines,
    content: returned.join('\n'),
    truncated: hasMore,
    next_offset: hasMore ? offset + returnedLines : null,
  };
}


function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8_192);
  if (sample.includes(0)) return true;
  let nonPrintable = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) nonPrintable += 1;
  }
  return sample.length > 0 && nonPrintable / sample.length > 0.3;
}


function parseUnifiedPatch(patch: string): UnifiedFilePatch[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const filePatches: UnifiedFilePatch[] = [];
  let current: UnifiedFilePatch | null = null;
  let currentHunk: UnifiedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      if (current) filePatches.push(current);
      current = { oldPath: cleanPatchPath(line.slice(4).trim()), newPath: null, hunks: [] };
      currentHunk = null;
      continue;
    }
    if (line.startsWith('+++ ') && current) {
      current.newPath = cleanPatchPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('@@') && current) {
      currentHunk = parseUnifiedHunkHeader(line);
      current.hunks.push(currentHunk);
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) {
      // The marker belongs to the previous content line; it is metadata, not a
      // line to match or write. It only matters for the new side of the patch.
      const previous = currentHunk?.lines[currentHunk.lines.length - 1];
      if (currentHunk && previous && !previous.startsWith('-')) currentHunk.newSideNoNewline = true;
      continue;
    }
    if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      currentHunk.lines.push(line);
    }
  }
  if (current) filePatches.push(current);
  return filePatches.filter((filePatch) => filePatch.oldPath || filePatch.newPath);
}


function parseUnifiedHunkHeader(line: string): UnifiedHunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) throw new Error(`Invalid unified diff hunk header: ${line}`);
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    lines: [],
  };
}


function cleanPatchPath(value: string): string | null {
  const pathPart = value.split(/\t| /)[0];
  if (!pathPart || pathPart === '/dev/null') return null;
  return pathPart.replace(/^[ab]\//, '');
}


function failure(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}


function safetyFailure(failureValue: FileSafetyFailure): Record<string, unknown> {
  return { ok: false, error: { code: failureValue.error.code, message: failureValue.error.message } };
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
