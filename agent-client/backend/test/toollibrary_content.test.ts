import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { CONFIG_ROOT, SKILLS_ROOT, TOOLLIBRARY_ROOT } from '../src/paths.js';
import {
  DOMAIN_INDEX_FILE,
  TOOLLIBRARY_DESCRIPTION_WARN_CHARS,
  TOOLLIBRARY_NAME_WARN_CHARS,
  UNCLASSIFIED_DOMAIN_NAME,
  buildCatalogState,
  parseCatalogBullet,
  type ToolLibraryCatalogEntry,
} from '../src/agent/core_tools/toollibrary_executor.js';

function listDomainNames(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function readDomainEntries(domain: string): ToolLibraryCatalogEntry[] {
  const file = path.join(TOOLLIBRARY_ROOT, domain, DOMAIN_INDEX_FILE);
  assert.ok(fs.existsSync(file), `domain '${domain}' must have an index.md`);
  const entries: ToolLibraryCatalogEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!/^\s*[-*]\s+/.test(line)) continue;
    const entry = parseCatalogBullet(line);
    assert.ok(entry, `unparseable catalog line in '${domain}': ${line}`);
    entries.push(entry);
  }
  return entries;
}

function allEntries(): Array<ToolLibraryCatalogEntry & { domain: string }> {
  return listDomainNames(TOOLLIBRARY_ROOT)
    .flatMap((domain) => readDomainEntries(domain).map((entry) => ({ ...entry, domain })));
}

function skillIdsOnDisk(): Set<string> {
  const ids = new Set<string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(full, 'SKILL.md'))) ids.add(relative);
      else walk(full, relative);
    }
  };
  walk(SKILLS_ROOT, '');
  return ids;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fakeMcpTool(id: string): ChatCompletionTool {
  return { type: 'function', function: { name: id, description: '', parameters: { type: 'object', properties: {} } } };
}

test('the shipped tool library parses with no drift warnings', () => {
  const domains = listDomainNames(TOOLLIBRARY_ROOT);
  assert.ok(domains.length >= 5, 'the catalog should have several domains');
  assert.ok(!domains.includes(UNCLASSIFIED_DOMAIN_NAME), 'Unclassified is synthesized at runtime, never a disk directory');

  const entries = allEntries();
  const skills = entries
    .filter((entry) => entry.kind === 'skill')
    .map((entry) => ({ id: entry.id, name: entry.name, description: entry.description, instructions: '', resources: [], directory: '' }));
  const mcpTools = new Map(entries.filter((entry) => entry.kind === 'mcp').map((entry) => [entry.id, fakeMcpTool(entry.id)]));

  const state = buildCatalogState({ root: TOOLLIBRARY_ROOT, skills, mcpServers: [], mcpTools });

  assert.deepEqual(state.warnings, [], 'root index, domain files and visibility must agree');
  assert.deepEqual(state.domains.map((domain) => domain.name).sort(), domains, 'the root index must cover every domain');
  for (const domain of state.domains) {
    assert.ok(domain.description.trim(), `domain '${domain.name}' needs a description in the root index`);
    assert.ok(domain.entries.length > 0, `domain '${domain.name}' needs at least one tool`);
  }
});

test('every configured skill is listed exactly once and every listed skill exists', () => {
  const configured = new Set<string>(readJson(path.join(CONFIG_ROOT, 'agents.json')).agents.flatMap((agent: any) => agent.skillIds || []));
  const onDisk = skillIdsOnDisk();
  const listed = allEntries().filter((entry) => entry.kind === 'skill');

  const counts = new Map<string, number>();
  for (const entry of listed) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  for (const [id, count] of counts) {
    assert.equal(count, 1, `skill '${id}' must appear exactly once, found ${count}`);
    assert.ok(onDisk.has(id), `listed skill '${id}' does not exist under skills/`);
  }

  for (const id of configured) {
    assert.ok(onDisk.has(id), `configured skill '${id}' is missing from skills/`);
    assert.equal(counts.get(id), 1, `configured skill '${id}' must be listed in exactly one domain`);
  }
});

test('every browsable MCP server exposes catalog entries with public-name ids', () => {
  const servers = readJson(path.join(CONFIG_ROOT, 'mcp.json')).servers as Array<{ id: string; enabled?: boolean; internal?: boolean }>;
  const enabled = servers.filter((server) => server.enabled !== false);
  const browsable = enabled.filter((server) => server.internal !== true);
  const internal = enabled.filter((server) => server.internal === true).map((server) => server.id);
  const mcpEntries = allEntries().filter((entry) => entry.kind === 'mcp');

  assert.ok(mcpEntries.length > 0, 'the MCP domain must list MCP tools');
  for (const entry of mcpEntries) {
    assert.ok(browsable.some((server) => entry.id.startsWith(`${server.id}_`)), `MCP entry '${entry.id}' belongs to a server that is not browsable by the agent`);
    assert.ok(entry.description.trim(), `MCP entry '${entry.id}' needs a description`);
  }
  for (const server of browsable) {
    assert.ok(mcpEntries.some((entry) => entry.id.startsWith(`${server.id}_`)), `MCP server '${server.id}' has no catalog entry`);
  }
  for (const id of internal) {
    assert.ok(!mcpEntries.some((entry) => entry.id.startsWith(`${id}_`)), `internal MCP server '${id}' must stay out of the tool library`);
  }
});

test('catalog entries stay unique and within display budgets', () => {
  const entries = allEntries();
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length, 'tool ids must be unique across domains');
  for (const entry of entries) {
    assert.ok(entry.name.trim(), `entry '${entry.id}' needs a name`);
    assert.ok(entry.description.trim(), `entry '${entry.id}' needs a description`);
    assert.ok(entry.name.length <= TOOLLIBRARY_NAME_WARN_CHARS, `entry '${entry.id}' name exceeds the display budget`);
    assert.ok(entry.description.length <= TOOLLIBRARY_DESCRIPTION_WARN_CHARS, `entry '${entry.id}' description exceeds the display budget`);
    assert.ok(entry.kind === 'skill' || entry.kind === 'mcp', `entry '${entry.id}' has an unknown kind`);
  }
});

test('every skill entry is bound to the lead role', () => {
  const main = readJson(path.join(CONFIG_ROOT, 'agents.json')).agents.find((agent: any) => agent.id === 'pi');
  assert.ok(main, 'the lead role must exist');
  const bound = new Set<string>(main.skillIds || []);
  for (const entry of allEntries().filter((item) => item.kind === 'skill')) {
    assert.ok(bound.has(entry.id), `listed skill '${entry.id}' is not bound to the lead role`);
  }
});
