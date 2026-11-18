#!/usr/bin/env node
/**
 * Check whether the configured model provider can handle a tool-call history.
 *
 * Why this exists: an agent run makes one request per tool call, and every request
 * after the first carries the assistant's own `tool_calls` back to the provider. A
 * provider that cannot accept that shape fails the *second* turn of every run while
 * the first turn looks perfectly healthy — which reads as a flaky network error and
 * costs a long time to trace.
 *
 * The check sends two probes and reports which one the provider rejects:
 *   1. a plain user message            (works on any provider)
 *   2. an assistant message carrying tool_calls
 *
 * Read-only with respect to the repository. The API key is read from the environment
 * or from the backend env file and is never printed.
 *
 * Usage:
 *   node scripts/check-llm-tool-support.mjs [--provider <id>] [--timeout <ms>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_ROOT = path.join(REPO_ROOT, 'agent-client', 'backend');

function parseArgs(argv) {
  const options = { provider: '', timeoutMs: 60_000, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--provider') options.provider = argv[++index] ?? '';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++index]) || options.timeoutMs;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/check-llm-tool-support.mjs [--provider <id>] [--timeout <ms>] [--json]\n');
      process.exit(0);
    }
  }
  return options;
}

/** Read `KEY=value` pairs without ever surfacing them. */
function readEnvFile(file) {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

/** Providers write keys as `${VAR}` references; resolve them but keep the value private. */
function resolveApiKey(raw, envFileValues) {
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(raw || '').trim());
  if (!reference) return String(raw || '').trim();
  const name = reference[1];
  return process.env[name] || envFileValues[name] || '';
}

function loadProvider(requestedId) {
  const configPath = path.join(BACKEND_ROOT, 'config', 'llm.json');
  const document = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // v2 is one document with `providers`; the legacy form was a bare array of flat rows.
  const providers = Array.isArray(document) ? document : Array.isArray(document?.providers) ? document.providers : [];
  if (providers.length === 0) throw new Error(`${configPath} has no providers.`);
  const defaultProviderId = Array.isArray(document) ? '' : String(document?.defaultProviderId || '');
  const found = requestedId
    ? providers.find((item) => item.id === requestedId)
    : providers.find((item) => item.id === defaultProviderId) || providers.find((item) => item.isDefault) || providers[0];
  if (!found) throw new Error(`Unknown provider "${requestedId}".`);
  const model = found.model || found.defaultModelId || found.models?.[0]?.id;
  if (!model) throw new Error(`Provider "${found.id}" has no model.`);
  return { ...found, model };
}

const TOOL_CALL = [{
  id: 'call_probe_1',
  type: 'function',
  function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo probe' }) },
}];

const PROBES = [
  { name: 'plain user message', messages: [{ role: 'user', content: 'Reply with the single word: ok' }] },
  {
    name: 'assistant tool_calls in history',
    messages: [
      { role: 'user', content: 'Run echo probe' },
      { role: 'assistant', content: null, tool_calls: TOOL_CALL },
      { role: 'tool', tool_call_id: 'call_probe_1', content: JSON.stringify({ ok: true, stdout: 'probe' }) },
    ],
  },
];

async function probe(provider, apiKey, messages, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: provider.model, messages, stream: false, max_tokens: 32 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { outcome: response.ok ? 'ok' : 'http-error', status: response.status, ms: Date.now() - started, detail: text.slice(0, 300) };
  } catch (error) {
    // A reset connection surfaces here; that is the failure this script is looking for.
    return { outcome: 'connection-error', status: 0, ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const provider = loadProvider(options.provider);
  const apiKey = resolveApiKey(provider.apiKey, readEnvFile(process.env.BIOFLOW_ENV_FILE || path.join(BACKEND_ROOT, '.env')));

  if (!apiKey) {
    process.stderr.write(`No API key resolved for provider "${provider.id}". Set ${provider.apiKey} and retry.\n`);
    process.exit(2);
  }

  const results = [];
  for (const entry of PROBES) {
    results.push({ probe: entry.name, ...(await probe(provider, apiKey, entry.messages, options.timeoutMs)) });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ provider: provider.id, model: provider.model, results }, null, 2)}\n`);
  } else {
    process.stdout.write(`provider ${provider.id} (${provider.model}) at ${provider.baseUrl}\n\n`);
    for (const result of results) {
      process.stdout.write(`  ${result.probe.padEnd(34)} ${result.outcome.padEnd(17)} ${String(result.ms).padStart(6)} ms  ${result.detail}\n`);
    }
  }

  const toolHistory = results[1];
  if (toolHistory.outcome !== 'ok') {
    process.stdout.write(
      '\nThe provider cannot accept an assistant message carrying tool_calls.\n'
      + 'Every agent run makes one request per tool call, so this fails the second turn of\n'
      + 'every run while the first turn looks healthy. Check the model server\'s own logs\n'
      + 'for a crash in its tool-call parser; the harness is sending the standard shape.\n',
    );
    process.exit(1);
  }
}

await main();
