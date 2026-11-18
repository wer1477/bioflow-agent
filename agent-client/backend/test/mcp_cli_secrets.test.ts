import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PROJECT_ROOT, 'bin', 'bioflow.mjs');

function runMcp(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, 'mcp', ...args], { encoding: 'utf8', env: { ...process.env, ...environment } });
}

test('mcp add accepts literal credentials but persists only references in mcp.json', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bioflow-mcp-cli-'));
  const environmentFile = path.join(directory, '.env');
  try {
    const result = runMcp([
      'add', 'search', '--url', 'https://example.test/mcp', '--config-dir', directory,
      '--env', 'TAVILY_API_KEY=plaintext', '--header', 'Authorization=Bearer plaintext',
    ], { BIOFLOW_ENV_FILE: environmentFile });
    assert.equal(result.status, 0, result.stderr);
    const configText = readFileSync(path.join(directory, 'mcp.json'), 'utf8');
    const config = JSON.parse(configText);
    assert.equal(config.servers[0].env.TAVILY_API_KEY, '${BIOFLOW_MCP_SEARCH_TAVILY_API_KEY}');
    assert.equal(config.servers[0].headers.Authorization, '${BIOFLOW_MCP_SEARCH_AUTHORIZATION}');
    assert.doesNotMatch(configText, /plaintext/);
    assert.match(readFileSync(environmentFile, 'utf8'), /BIOFLOW_MCP_SEARCH_TAVILY_API_KEY="plaintext"/);
    assert.match(readFileSync(environmentFile, 'utf8'), /BIOFLOW_MCP_SEARCH_AUTHORIZATION="Bearer plaintext"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mcp add persists an environment reference rather than a secret value', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bioflow-mcp-cli-'));
  try {
    const result = runMcp(['add', 'tavily', '--command', 'echo', '--env', 'TAVILY_API_KEY=${BIOFLOW_TAVILY_API_KEY}', '--config-dir', directory]);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(path.join(directory, 'mcp.json'), 'utf8'));
    assert.equal(config.servers[0].env.TAVILY_API_KEY, '${BIOFLOW_TAVILY_API_KEY}');
    assert.equal(existsSync(path.join(directory, '.env')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
