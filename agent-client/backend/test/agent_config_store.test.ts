import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TEAM_ROLE_IDS,
  ensureDefaultAgents,
  ensureTeamRoles,
  getAgent,
  getAllAgents,
  getLeadAgent,
  getTeamConfig,
  updateAgent,
  updateTeamConfig,
} from '../src/agent/config/agent_config_store.js';
import { getRegisteredCoreTools } from '../src/agent/core_tools_runtime.js';
import { listKnowledgeBaseEntryIds } from '../src/agent/core_tools/knowledgebase_executor.js';

async function withConfigDir<T>(agents: unknown, callback: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-agent-store-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  await writeFile(path.join(dir, 'agents.json'), JSON.stringify(agents), 'utf8');
  try {
    return await callback(dir);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const LEGACY_AGENT = {
  id: 'main',
  name: 'Main Agent',
  kind: 'main',
  description: '',
  promptFile: 'prompts/main.md',
  llmProviderId: 'provider-1',
  securityMode: 'approval',
  enabled: false,
  mcpServerIds: ['context7'],
  skillIds: ['bio-seq'],
};

test('a legacy record without coreToolIds migrates to every registered CoreTool', async () => {
  await withConfigDir({ agents: [LEGACY_AGENT] }, () => {
    ensureTeamRoles();
    const agent = getLeadAgent();
    assert.ok(agent, 'a disabled legacy record is still the lead role');
    assert.equal(agent!.id, 'pi');
    assert.deepEqual([...agent!.coreToolIds].sort(), getRegisteredCoreTools().map((tool) => tool.id).sort());
    assert.deepEqual([...agent!.knowledgeEntryIds].sort(), listKnowledgeBaseEntryIds().sort());
    assert.equal('enabled' in agent!, false);
  });
});

test('an explicit empty list is preserved instead of falling back', async () => {
  await withConfigDir({ agents: [{ ...LEGACY_AGENT, coreToolIds: [], knowledgeEntryIds: [] }] }, async (dir) => {
    ensureTeamRoles();
    const agent = getAgent('pi');
    assert.deepEqual(agent?.coreToolIds, []);
    assert.deepEqual(agent?.knowledgeEntryIds, []);

    const updated = updateAgent('pi', {
      coreToolIds: ['shell', 'file', 'shell'],
      knowledgeEntryIds: ['Bioinformatics/anndata', 'Bioinformatics/anndata'],
    });
    assert.deepEqual(updated?.coreToolIds, ['shell', 'file']);
    assert.deepEqual(updated?.knowledgeEntryIds, ['Bioinformatics/anndata']);

    const persisted = JSON.parse(await readFile(path.join(dir, 'agents.json'), 'utf8'));
    const pi = persisted.agents.find((item: { id: string }) => item.id === 'pi');
    assert.deepEqual(pi.coreToolIds, ['shell', 'file']);
    assert.deepEqual(pi.knowledgeEntryIds, ['Bioinformatics/anndata']);
    assert.equal('knowledgeDomainIds' in pi, false);
    assert.equal('enabled' in pi, false);
    assert.equal('kind' in pi, false);
  });
});

test('a legacy domain binding expands to the entries under those domains', async () => {
  await withConfigDir({ agents: [{ ...LEGACY_AGENT, knowledgeDomainIds: ['General Science'] }] }, () => {
    ensureTeamRoles();
    const entries = getAgent('pi')?.knowledgeEntryIds || [];
    assert.ok(entries.length > 0, 'the domain is expanded to its concrete entries');
    assert.ok(entries.every((id) => id.startsWith('General Science/')), entries.join(','));
    assert.ok(entries.every((id) => id.includes('/') && id.split('/').length === 2));
  });
});

test('a brand-new deployment starts with the five roles and nothing configured', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-agent-empty-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  try {
    ensureDefaultAgents();
    const agents = getAllAgents();
    assert.deepEqual(agents.map((agent) => agent.id), [...TEAM_ROLE_IDS]);
    for (const agent of agents) {
      assert.deepEqual(agent.coreToolIds, []);
      assert.deepEqual(agent.knowledgeEntryIds, []);
      assert.equal(agent.promptFile, `prompts/${agent.id}.md`);
    }
    const persisted = JSON.parse(await readFile(path.join(dir, 'agents.json'), 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.deepEqual(persisted.team.roles, [...TEAM_ROLE_IDS]);
    assert.equal(persisted.team.leadRoleId, 'pi');
    assert.equal(persisted.agents.length, 5);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the legacy single agent becomes the lead role and the other roles inherit it', async () => {
  await withConfigDir({ agents: [LEGACY_AGENT] }, async (dir) => {
    ensureTeamRoles();
    const agents = getAllAgents();
    assert.deepEqual(agents.map((agent) => agent.id), [...TEAM_ROLE_IDS]);
    const pi = getAgent('pi');
    assert.equal(pi?.llmProviderId, 'provider-1');
    assert.equal(pi?.promptFile, 'prompts/pi.md');
    for (const role of TEAM_ROLE_IDS.filter((id) => id !== 'pi')) {
      assert.deepEqual(getAgent(role)?.mcpServerIds, ['context7'], `${role} inherits the lead bindings`);
      assert.deepEqual(getAgent(role)?.skillIds, ['bio-seq']);
    }

    const persisted = JSON.parse(await readFile(path.join(dir, 'agents.json'), 'utf8'));
    assert.equal(persisted.agents.some((item: { id: string }) => item.id === 'main'), false);
    assert.equal(persisted.agents.some((item: { id: string }) => 'kind' in item), false);
  });
});

test('runtime data of a real deployment is migrated without touching other roles', async () => {
  await withConfigDir({
    schemaVersion: 2,
    team: { leadRoleId: 'pi', roles: [...TEAM_ROLE_IDS], router: { engine: 'always-pi', fallbackRoleId: 'pi' }, limits: { maxConcurrentDispatches: 3 } },
    agents: [
      { id: 'pi', name: 'PI', promptFile: 'prompts/pi.md', coreToolIds: ['shell'], knowledgeEntryIds: [], mcpServerIds: [], skillIds: [] },
      { id: 'writer', name: 'Writer', promptFile: 'prompts/writer.md', coreToolIds: [], knowledgeEntryIds: [], mcpServerIds: [], skillIds: [] },
    ],
  }, async (dir) => {
    ensureTeamRoles();
    assert.equal(getAllAgents().length, 5, 'the missing roles are filled in');
    updateAgent('writer', { name: 'Renamed Writer' });
    const persisted = JSON.parse(await readFile(path.join(dir, 'agents.json'), 'utf8'));
    assert.equal(persisted.agents.filter((item: { id: string }) => item.id === 'pi').length, 1);
    assert.equal(persisted.agents.filter((item: { id: string }) => item.id === 'writer').length, 1);
    assert.equal(persisted.agents.find((item: { id: string }) => item.id === 'writer').name, 'Renamed Writer');
    assert.equal(persisted.agents.find((item: { id: string }) => item.id === 'searcher').name, '文献与假设专家');
  });
});

test('the team block is readable, writable and normalized', async () => {
  await withConfigDir({ agents: [LEGACY_AGENT] }, async () => {
    ensureTeamRoles();
    assert.deepEqual(getTeamConfig().router, { engine: 'always-pi', fallbackRoleId: 'pi' });
    assert.equal(getTeamConfig().limits.maxConcurrentDispatches, 3);

    const updated = updateTeamConfig({ router: { engine: 'biod' }, limits: { maxConcurrentDispatches: 2 } });
    assert.equal(updated.router.engine, 'biod');
    assert.equal(updated.router.fallbackRoleId, 'pi');
    assert.equal(updated.limits.maxConcurrentDispatches, 2);

    const rejected = updateTeamConfig({ router: { engine: 'nope' } });
    assert.equal(rejected.router.engine, 'biod', 'an unknown engine is ignored rather than persisted');
    assert.deepEqual(getLeadAgent()?.id, 'pi');
  });
});
