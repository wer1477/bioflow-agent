import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Optional asset provenance for a published Skill/CLI/MCP entry.
 *
 * The runtime does not invent provenance. If the curator writes
 * `<skill dir>/provenance.json`, its version (or a hash of the file) travels with the
 * candidate card, so a decision can be tied back to the source run/trace and the
 * verification record that justified publishing the asset. Missing file means "no
 * declared provenance", not "verified".
 *
 * Schema (all fields optional except schemaVersion when the file exists):
 * {
 *   "schemaVersion": 1,
 *   "assetVersion": "string",
 *   "sourceRun": "run id or path",
 *   "sourceTrace": "trace path or sha256",
 *   "inputs": [{"path": "...", "sha256": "..."}],
 *   "verification": {"command": "...", "result": "pass", "at": "ISO-8601"},
 *   "createdAt": "ISO-8601"
 * }
 */

export interface AssetProvenance {
  schemaVersion?: number;
  assetVersion?: string;
  sourceRun?: string;
  sourceTrace?: string;
  inputs?: Array<{ path?: string; sha256?: string }>;
  verification?: { command?: string; result?: string; at?: string };
  createdAt?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  provenance: AssetProvenance | null;
  version: string | undefined;
}

const CACHE = new Map<string, CacheEntry>();
const PROVENANCE_FILE = 'provenance.json';
const MAX_BYTES = 64 * 1024;

function cacheKey(file: string): string {
  return path.resolve(file);
}

/** Read `<directory>/provenance.json` if present and well-formed; never throws. */
export function readAssetProvenance(directory?: string): AssetProvenance | null {
  return load(directory)?.provenance ?? null;
}

/**
 * Version string for a candidate: the declared `assetVersion`, else a hash of the
 * provenance file. Returns undefined when the directory has no provenance file.
 */
export function assetVersion(directory?: string): string | undefined {
  return load(directory)?.version;
}

function load(directory?: string): CacheEntry | null {
  const dir = String(directory ?? '').trim();
  if (!dir) return null;
  const file = path.join(dir, PROVENANCE_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  const key = cacheKey(file);
  const cached = CACHE.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  let provenance: AssetProvenance | null = null;
  let version: string | undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      provenance = parsed as AssetProvenance;
      const declared = provenance.assetVersion;
      version = typeof declared === 'string' && declared.trim()
        ? declared.trim()
        : `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    }
  } catch {
    provenance = null;
    version = undefined;
  }
  const entry: CacheEntry = { mtimeMs: stat.mtimeMs, size: stat.size, provenance, version };
  CACHE.set(key, entry);
  return entry;
}

/** Test hook: clear the mtime cache. */
export function clearAssetProvenanceCache(): void {
  CACHE.clear();
}
