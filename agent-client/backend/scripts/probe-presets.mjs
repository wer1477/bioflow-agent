#!/usr/bin/env node
/**
 * Keyless reachability probe for every shipped provider preset.
 *
 * The create dialog can only offer a provider that the *deployment* can actually reach, and the
 * deployment network is not the developer's laptop: several international endpoints resolve but
 * never connect from the lab. This script answers "will this preset work from here" without any
 * credential, by asking each OpenAI-compatible endpoint for its model list with no
 * `Authorization` header:
 *
 *   - 401/403  the path exists and wants a key  -> `needs-key`
 *   - 2xx      the endpoint publishes its list  -> `open`
 *   - 404      wrong path for this transport    -> `path-missing`
 *   - failure  DNS/TCP/TLS never completed      -> `unreachable`
 *
 * Usage (run from `agent-client/backend/`):
 *
 *   node scripts/probe-presets.mjs
 *   node scripts/probe-presets.mjs --only coding --timeout 5000
 *   node scripts/probe-presets.mjs --json > /tmp/presets.json
 *   node scripts/probe-presets.mjs --strict    # exit 1 when a preset cannot be reached
 *
 * This is an operator tool, not a test: it needs network and must never run inside `npm run test`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Maps one unauthenticated HTTP answer onto the four states the dialog cares about.
 * Exported so the mapping is covered by a unit test instead of only by eyeballing a table.
 */
export function classifyProbeStatus(status) {
  if (!Number.isFinite(status)) return 'unreachable';
  if (status >= 200 && status < 300) return 'open';
  if (status === 401 || status === 403) return 'needs-key';
  if (status === 404) return 'path-missing';
  return `http-${status}`;
}

/** The endpoint the create dialog would call: the overlay's override wins over the catalog. */
export function resolvePresetEndpoint(preset, catalog) {
  const api = preset.api || catalog[preset.id]?.api;
  return typeof api === 'string' && api.trim() ? api.trim().replace(/\/+$/, '') : '';
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function parseArgs(argv) {
  const options = { only: '', strict: false, json: false, timeout: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--only') options.only = String(argv[++index] || '');
    else if (arg === '--timeout') options.timeout = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.only = arg;
  }
  return options;
}

async function probe(baseUrl, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    }).catch((error) => ({ status: Number.NaN, error }));
    const elapsed = Date.now() - started;
    const status = Number.isFinite(response.status) ? response.status : Number.NaN;
    if (!Number.isFinite(status)) return { status: 'unreachable', http: '', elapsed, error: String(response.error || '') };
    return { status: classifyProbeStatus(status), http: String(status), elapsed, error: '' };
  } catch (error) {
    return { status: 'unreachable', http: '', elapsed: Date.now() - started, error: String(error?.message || error) };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/probe-presets.mjs [--only <substring>] [--timeout <ms>] [--json] [--strict]');
    return 0;
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configDir = process.env.BIOFLOW_CONFIG_DIR || path.join(root, 'config');
  const presets = (readJson(path.join(configDir, 'llm_presets.json')).providers || []);
  const catalog = readJson(path.join(configDir, 'llm_catalog.json')).providers || {};
  const needle = options.only.trim().toLowerCase();
  const rows = presets
    .map((preset) => ({
      id: String(preset.id),
      name: String(preset.name || preset.id),
      env: (catalog[preset.id]?.env || []).join(','),
      endpoint: resolvePresetEndpoint(preset, catalog),
    }))
    .filter((row) => !needle || `${row.id} ${row.name} ${row.endpoint}`.toLowerCase().includes(needle));

  const results = [];
  for (const row of rows) {
    if (!row.endpoint) {
      results.push({ ...row, status: 'no-endpoint', http: '', elapsed: 0, error: '' });
      continue;
    }
    results.push({ ...row, ...(await probe(row.endpoint, options.timeout)) });
  }

  if (options.json) {
    console.log(JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  } else {
    const width = Math.max(12, ...results.map((row) => row.id.length));
    console.log(`${'preset'.padEnd(width)}  ${'status'.padEnd(12)} ${'http'.padEnd(4)} ${'ms'.padEnd(5)} endpoint`);
    for (const row of results) {
      console.log(`${row.id.padEnd(width)}  ${row.status.padEnd(12)} ${String(row.http).padEnd(4)} ${String(row.elapsed).padEnd(5)} ${row.endpoint}`);
    }
  }

  const counts = results.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] || 0) + 1 }), {});
  const summary = Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(' | ');
  console.error(`\n${results.length} presets: ${summary}`);
  const blocked = results.filter((row) => row.status === 'unreachable' || row.status === 'path-missing');
  if (blocked.length) {
    console.error(`not reachable from this host: ${blocked.map((row) => row.id).join(', ')}`);
  }
  return options.strict && blocked.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
