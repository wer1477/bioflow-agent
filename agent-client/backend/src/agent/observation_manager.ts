import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findSessionProjectKey } from './config/conversation_file_store.js';
import { observationsDirectory } from './config/session_paths.js';

const SMALL_RESULT_CHARS = 6000;
const MODEL_PREVIEW_CHARS = 6000;
const EVENT_PREVIEW_CHARS = 12000;

/**
 * Per-tool inline budgets.
 *
 * The default 6,000-char budget is right for command output and file reads, but
 * the two library tools deliberately answer with a whole domain catalog, a
 * skill body, or a knowledge entry. Truncating those would silently drop the
 * tail of what the model just asked for, so they get a larger inline budget and
 * the model receives their result in full. Larger results still fall back to the
 * normal observation file flow.
 */
export const KNOWLEDGEBASE_INLINE_RESULT_CHARS = 30000;
export const TOOLLIBRARY_INLINE_RESULT_CHARS = 30000;
/** One skill body can be much longer than a catalog page; it is loaded on purpose. */
export const TOOLLOAD_INLINE_RESULT_CHARS = 70000;
const INLINE_RESULT_CHARS_BY_TOOL: Readonly<Record<string, number>> = {
  knowledgebase: KNOWLEDGEBASE_INLINE_RESULT_CHARS,
  toollibrary: TOOLLIBRARY_INLINE_RESULT_CHARS,
  toolload: TOOLLOAD_INLINE_RESULT_CHARS,
};

export function inlineResultBudget(toolName: string): number {
  return INLINE_RESULT_CHARS_BY_TOOL[toolName] ?? SMALL_RESULT_CHARS;
}

export interface Observation {
  id: string;
  toolName: string;
  sizeChars: number;
  mode: 'inline' | 'preview' | 'file';
  modelContent: string;
  eventPreview: string;
  artifact?: {
    id: string;
    path: string;
    title: string;
    type: string;
  };
}

export function createObservation({
  conversationId,
  toolName,
  result,
}: {
  conversationId?: string;
  toolName: string;
  result: string;
}): Observation {
  const id = `obs_${crypto.createHash('sha1').update(`${toolName}\n${result}`).digest('hex').slice(0, 12)}`;
  const sizeChars = result.length;

  if (sizeChars <= inlineResultBudget(toolName)) {
    return {
      id,
      toolName,
      sizeChars,
      mode: 'inline',
      modelContent: result,
      eventPreview: sizeChars <= EVENT_PREVIEW_CHARS ? result : previewText(result, EVENT_PREVIEW_CHARS),
    };
  }

  const summary = buildTextObservationSummary(result);
  if (!conversationId) {
    const modelContent = [
      JSON.stringify({ ok: true, observationId: id, toolName, sizeChars, mode: 'preview' }),
      '',
      summary,
      '',
      result.slice(0, MODEL_PREVIEW_CHARS),
      '',
      '[observation truncated]',
    ].join('\n');
    return {
      id,
      toolName,
      sizeChars,
      mode: 'preview',
      modelContent,
      eventPreview: previewText(result, EVENT_PREVIEW_CHARS),
    };
  }

  // Observations are engine bookkeeping: they live in the session's own state
  // directory and are deliberately not registered as project artifacts.
  const projectKeyValue = findSessionProjectKey(conversationId);
  if (!projectKeyValue) {
    return {
      id,
      toolName,
      sizeChars,
      mode: 'preview',
      modelContent: [
        JSON.stringify({ ok: true, observationId: id, toolName, sizeChars, mode: 'preview' }),
        '',
        summary,
        '',
        result.slice(0, MODEL_PREVIEW_CHARS),
        '',
        '[observation truncated]',
      ].join('\n'),
      eventPreview: previewText(result, EVENT_PREVIEW_CHARS),
    };
  }

  const fileName = `${safeFileName(toolName)}_${id}.txt`;
  const observationPath = path.join(observationsDirectory(projectKeyValue, conversationId), fileName);
  fs.mkdirSync(path.dirname(observationPath), { recursive: true });
  fs.writeFileSync(observationPath, result, 'utf8');
  // The path is deliberately withheld from the model: observations live in the session
  // directory, outside the project root, so a read by path is refused by the project
  // boundary and becomes an approval prompt for a file the model cannot actually open.
  const modelContent = [
    JSON.stringify({
      ok: true,
      observationId: id,
      toolName,
      sizeChars,
      mode: 'file',
    }),
    '',
    summary,
    '',
    result.slice(0, MODEL_PREVIEW_CHARS),
    '',
    '[result truncated above; only this preview is part of the conversation context]',
  ].join('\n');

  return {
    id,
    toolName,
    sizeChars,
    mode: 'file',
    modelContent,
    eventPreview: previewText(result, EVENT_PREVIEW_CHARS),
  };
}

export function buildObservationPayload(observation: Observation): Record<string, unknown> {
  return {
    observationId: observation.id,
    mode: observation.mode,
    sizeChars: observation.sizeChars,
    artifact: observation.artifact || null,
  };
}

function buildTextObservationSummary(result: string): string {
  const lines = result.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLines = lines.slice(0, 12).join('\n');
  const tailLines = lines.length > 18 ? lines.slice(-6).join('\n') : '';
  return [
    'Observation summary:',
    `- characters: ${result.length}`,
    `- non-empty lines: ${lines.length}`,
    firstLines ? `- leading content:\n${firstLines}` : '- leading content: empty',
    tailLines ? `- trailing content:\n${tailLines}` : '',
  ].filter(Boolean).join('\n');
}

function previewText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[truncated]` : value;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}
