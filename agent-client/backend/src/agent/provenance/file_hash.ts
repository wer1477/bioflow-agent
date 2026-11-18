import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Content hashing for the run manifest.
 *
 * Artifacts are hashed by streaming so a multi-GB h5ad does not have to fit in memory,
 * and every failure mode is reported as a `skipped` reason instead of an exception:
 * a manifest that records "this file was too large to hash" is still useful, while a
 * manifest that aborts the run is not.
 */

export type FileSkipReason = 'not_a_file' | 'too_large' | 'unreadable';

export interface FileDigest {
  bytes: number;
  sha256: string | null;
  skipped?: FileSkipReason;
}

export const DEFAULT_MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024;

export async function hashFile(filePath: string, maxBytes = DEFAULT_MAX_HASH_BYTES): Promise<FileDigest> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { bytes: 0, sha256: null, skipped: 'unreadable' };
  }
  if (!stat.isFile()) return { bytes: 0, sha256: null, skipped: 'not_a_file' };
  if (stat.size > maxBytes) return { bytes: stat.size, sha256: null, skipped: 'too_large' };

  return new Promise((resolve) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    let bytes = 0;
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      digest.update(chunk);
    });
    stream.on('error', () => resolve({ bytes, sha256: null, skipped: 'unreadable' }));
    stream.on('end', () => resolve({ bytes, sha256: digest.digest('hex') }));
  });
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Deterministic JSON for hashing tool arguments.
 *
 * `JSON.stringify` preserves insertion order, so two identical calls can hash
 * differently when the model emits the keys in another order. Sorting keys keeps the
 * hash stable across those spellings.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
