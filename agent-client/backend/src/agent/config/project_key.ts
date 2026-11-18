import { RESERVED_WORKSPACE_ENTRIES } from '../../paths.js';

/**
 * Project keys become one path segment under `WORKSPACE_ROOT/.sessions/`, so
 * they must satisfy the same `^[A-Za-z0-9_-]+$` rule as a session id
 * (`path_segments.assertPathSegment`). dsh escapes unsafe code units as
 * `~XXXX`, but `~` is not in that character set, so the escape marker here is
 * `_` and `_` itself is therefore *not* a safe character.
 *
 * Injectivity: the output only contains `_` as part of an escape, so the
 * output parses back to exactly one input. A safe-only input can never produce
 * an escaped sequence by accident.
 */
const SAFE_SEGMENT_CHARACTER = /^[A-Za-z0-9-]$/;

/** Character budget for a project directory name, before escaping. */
export const MAX_PROJECT_NAME_CHARACTERS = 64;

/** Byte budget for the escaped single path segment (Linux NAME_MAX is 255). */
export const MAX_ENCODED_SEGMENT_BYTES = 255;

/** Escapes one path segment into `[A-Za-z0-9_-]+`. */
export function encodeSegment(input: string): string {
  let encoded = '';
  for (const character of input) {
    encoded += SAFE_SEGMENT_CHARACTER.test(character)
      ? character
      : `_${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}_`;
  }
  return encoded || '_';
}

/** Inverse of {@link encodeSegment}; used by tests and debugging only. */
export function decodeSegment(encoded: string): string {
  let decoded = '';
  let index = 0;
  while (index < encoded.length) {
    const character = encoded[index];
    if (character !== '_') {
      decoded += character;
      index += 1;
      continue;
    }
    const end = encoded.indexOf('_', index + 1);
    if (end < 0) throw new Error(`Malformed segment escape at offset ${index}.`);
    const hex = encoded.slice(index + 1, end);
    if (!/^[0-9A-F]{4,6}$/.test(hex)) throw new Error(`Malformed segment escape "${encoded.slice(index, end + 1)}".`);
    decoded += String.fromCodePoint(Number.parseInt(hex, 16));
    index = end + 1;
  }
  return decoded;
}

/**
 * Project key for a directory name. Keys are workspace-relative, so moving the
 * whole workspace root does not orphan every session (dsh keys on the absolute
 * path and does).
 */
export function projectKey(directoryName: string): string {
  return encodeSegment(directoryName);
}

export type ProjectNameValidation = { ok: true; value: string } | { ok: false; reason: string };

/** Pure name validation; existence checks live in the project service. */
export function validateProjectName(input: unknown): ProjectNameValidation {
  const value = String(input ?? '').trim();
  if (!value) return { ok: false, reason: '项目名不能为空。' };
  if (value.length > MAX_PROJECT_NAME_CHARACTERS) {
    return { ok: false, reason: `项目名最多 ${MAX_PROJECT_NAME_CHARACTERS} 个字符。` };
  }
  if (/[/\\\0]/.test(value)) return { ok: false, reason: '项目名不能包含路径分隔符。' };
  if (value.startsWith('.')) return { ok: false, reason: '项目名不能以点开头。' };
  if ((RESERVED_WORKSPACE_ENTRIES as readonly string[]).includes(value)) {
    return { ok: false, reason: `"${value}" 是保留名称。` };
  }
  if (encodeSegment(value).length > MAX_ENCODED_SEGMENT_BYTES) {
    return { ok: false, reason: '项目名过长（转义后超过 255 字节）。' };
  }
  return { ok: true, value };
}
