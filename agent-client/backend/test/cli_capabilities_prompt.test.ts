import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';
import {
  CLI_CAPABILITIES_CHAR_BUDGET,
  readCliCapabilities,
  renderCliCapabilitiesPrompt,
} from '../src/agent/core_tools/toollibrary_executor.js';
import * as agentConfigStore from '../src/agent/config/agent_config_store.js';
import * as skillConfigStore from '../src/agent/config/skill_config_store.js';
import { TOOLLIBRARY_ROOT } from '../src/paths.js';

// The resolver interpolates the provider's `${BIOFLOW_LLM_API_KEY_*}` reference; tests do not
// load `backend/.env`, so give the configured providers something to resolve.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const CLI_ROOT = path.join(CLIENT_ROOT, 'toollibrary', 'cli.md');

function commandFromPackage(packageFile: string): string | null {
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { bin?: Record<string, string> };
  const names = Object.keys(pkg.bin || {});
  return names.length === 1 ? names[0] : null;
}

function clitoolPackages(): Array<{ command: string; packageDir: string }> {
  const root = path.join(REPO_ROOT, 'clitool');
  const found: Array<{ command: string; packageDir: string }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageFile = path.join(root, entry.name, 'package.json');
    if (!fs.existsSync(packageFile)) continue;
    const command = commandFromPackage(packageFile);
    if (command) found.push({ command, packageDir: path.join(root, entry.name) });
  }
  return found;
}

function visibleCliEntries(roleId: string) {
  const agent = agentConfigStore.getAgent(roleId);
  assert.ok(agent, `role '${roleId}' must exist`);
  const enabled = new Set(skillConfigStore.getEnabledSkills().map((skill) => skill.id));
  const bound = new Set((agent.skillIds || []).filter((id) => enabled.has(id)));
  return readCliCapabilities(TOOLLIBRARY_ROOT).filter((entry) => bound.has(entry.skillId));
}

function renderedCommands(roleId: string): { commands: string[]; block: string; kindPresent: boolean } {
  const context = agentContextResolver.resolve({ agentId: roleId });
  const section = context.systemPromptSections.find((item) => item.kind === 'cli-tools');
  if (!section) return { commands: [], block: '', kindPresent: false };
  const block = context.systemPrompt.slice(section.start, section.end);
  const commands = block.split('\n')
    .filter((line) => line.startsWith('- `'))
    .map((line) => line.slice(3).split('`')[0]);
  return { commands, block, kindPresent: true };
}

/**
 * The curated list of commands that ship with the repository. A new CLI appends its
 * command here and to `toollibrary/cli.md` in the same commit; the reverse check below
 * still proves that every advertised command has a package, while an in-progress package
 * outside this list cannot fail an unrelated commit.
 */
const EXPECTED_CLI_COMMANDS = [
  'bio-doctor', 'bio-enrich', 'bio-epiedit', 'bio-fetch', 'bio-grn', 'bio-multiome',
  'bio-peak', 'bio-regulatory', 'bio-seq', 'bio-variant', 'bio-workflow', 'science-search',
  'bio-sc', 'bio-bulk', 'bio-report', 'bio-qc', 'bio-align', 'bio-metagenomics',
];

test('every advertised CLI has a package and the bundled list is advertised', () => {
  const packages = new Map(clitoolPackages().map((entry) => [entry.command, entry]));
  const entries = readCliCapabilities(TOOLLIBRARY_ROOT);
  for (const entry of entries) {
    assert.ok(packages.has(entry.command), `advertised '${entry.command}' must have a clitool package`);
  }
  for (const command of EXPECTED_CLI_COMMANDS) {
    assert.ok(entries.some((entry) => entry.command === command), `bundled '${command}' must be advertised in toollibrary/cli.md`);
  }
  assert.equal(entries.length, new Set(entries.map((entry) => entry.command)).size, 'cli.md must not repeat a command');
});

test('every advertised CLI has a skill and is bound to the lead role', () => {
  const lead = agentConfigStore.getAgent('pi');
  assert.ok(lead);
  const bindings = new Set(lead.skillIds || []);
  for (const entry of readCliCapabilities(TOOLLIBRARY_ROOT)) {
    assert.equal(fs.existsSync(path.join(CLIENT_ROOT, 'skills', entry.skillId, 'SKILL.md')), true, `${entry.skillId} must exist`);
    assert.equal(bindings.has(entry.skillId), true, `${entry.skillId} must be bound to the lead role`);
  }
});

test('the block advertises exactly the commands a role can load', () => {
  const team = agentConfigStore.getTeamConfig();
  assert.ok(team.roles.length >= 2);
  for (const roleId of team.roles) {
    const expected = visibleCliEntries(roleId).map((entry) => entry.command);
    const { commands, block, kindPresent } = renderedCommands(roleId);
    assert.deepEqual(commands, expected, `role '${roleId}' must see exactly its bound CLIs`);
    assert.equal(kindPresent, expected.length > 0, `role '${roleId}' must only get the block when it has a command`);
    if (kindPresent) {
      assert.match(block, /^<cli_capabilities>\n/);
      assert.match(block, /\n<\/cli_capabilities>$/);
      assert.ok(block.length <= CLI_CAPABILITIES_CHAR_BUDGET, `role '${roleId}' block is ${block.length} chars`);
      assert.doesNotMatch(block, /\n# /, 'the block must not inline SKILL.md bodies');
    }
  }
  assert.ok(visibleCliEntries('pi').length > visibleCliEntries('writer').length, 'the lead must see more CLIs than the writer');
});

test('the block is attributed as its own system-prompt section', () => {
  const context = agentContextResolver.resolve({ agentId: 'pi' });
  const section = context.systemPromptSections.find((item) => item.kind === 'cli-tools');
  assert.ok(section, 'the cli-tools section must be attributed');
  assert.equal(section.source, 'toollibrary/cli.md');
  assert.match(context.systemPrompt.slice(section.start, section.end), /^<cli_capabilities>/);
  const domainSection = context.systemPromptSections.find((item) => item.kind === 'tool-library');
  assert.ok(domainSection);
  assert.doesNotMatch(context.systemPrompt.slice(domainSection.start, domainSection.end), /cli_capabilities/);
});

test('the parser reports malformed and duplicate lines without throwing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-capabilities-'));
  try {
    fs.writeFileSync(path.join(directory, 'cli.md'), [
      '# Installed CLI capabilities',
      '',
      '- bio-one（skill：bio-one）：first',
      '- bio-one（skill：bio-one）：duplicate',
      '- broken line',
    ].join('\n'));
    const warnings: string[] = [];
    const entries = readCliCapabilities(directory, warnings);
    assert.deepEqual(entries.map((entry) => entry.command), ['bio-one']);
    assert.ok(warnings.some((warning) => warning.startsWith('duplicate_cli_command:')));
    assert.ok(warnings.some((warning) => warning.startsWith('malformed_cli_entry:')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('visibility filters entries and the block stays within its budget', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-capabilities-'));
  try {
    const lines = ['# Installed CLI capabilities', ''];
    for (let index = 0; index < 120; index += 1) {
      lines.push(`- bio-${index}（skill：bio-${index}）：command number ${index} used for a budget test`);
    }
    fs.writeFileSync(path.join(directory, 'cli.md'), lines.join('\n'));
    assert.equal(renderCliCapabilitiesPrompt(directory, { skillIds: ['not-a-command'], mcpServerIds: [] }), null);
    const rendered = renderCliCapabilitiesPrompt(directory, {
      skillIds: Array.from({ length: 120 }, (_, index) => `bio-${index}`),
      mcpServerIds: [],
    });
    assert.ok(rendered);
    assert.ok(rendered.length <= CLI_CAPABILITIES_CHAR_BUDGET, `rendered ${rendered.length} chars`);
    assert.ok(rendered.includes('- `bio-0` (skill: `bio-0`)'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
