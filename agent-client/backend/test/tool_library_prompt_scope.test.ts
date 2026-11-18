import assert from 'node:assert/strict';
import test from 'node:test';
import { readToolLibraryDomains } from '../src/agent/core_tools/toollibrary_executor.js';
import * as agentConfigStore from '../src/agent/config/agent_config_store.js';
import * as mcpConfigStore from '../src/agent/config/mcp_config_store.js';
import * as skillConfigStore from '../src/agent/config/skill_config_store.js';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';
import { TOOLLIBRARY_ROOT } from '../src/paths.js';

// The resolver interpolates the provider's `${BIOFLOW_LLM_API_KEY_*}` reference; tests do not
// load `backend/.env`, so give the configured providers something to resolve.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

/**
 * The tool-library L1 block is prompt context, so it is billed on every request of every
 * role. A domain the agent can only get an empty catalog from must not be rendered: that is
 * a wasted line and an invitation to spend a turn on a dead end. These tests pin the block to
 * the agent's own resolved bindings (enabled ∩ bound), not to the curated index.
 */
function resolvedVisibility(agentId: string): { skillIds: string[]; mcpServerIds: string[] } {
  const agent = agentConfigStore.getAgent(agentId);
  assert.ok(agent, `role '${agentId}' must exist`);
  const enabledSkills = new Set(skillConfigStore.getEnabledSkills().map((skill) => skill.id));
  const enabledServers = new Set(mcpConfigStore.getAllMCPServers().filter((server) => server.enabled).map((server) => server.id));
  return {
    skillIds: (agent.skillIds || []).filter((id) => enabledSkills.has(id)),
    mcpServerIds: (agent.mcpServerIds || []).filter((id) => enabledServers.has(id)),
  };
}

function domainsWithVisibleEntry(visibility: { skillIds: string[]; mcpServerIds: string[] }): string[] {
  const { domains } = readToolLibraryDomains(TOOLLIBRARY_ROOT);
  return domains
    .filter((domain) => domain.entries.some((entry) => (
      entry.kind === 'skill'
        ? visibility.skillIds.includes(entry.id)
        : visibility.mcpServerIds.some((serverId) => entry.id.startsWith(`${serverId}_`))
    )))
    .map((domain) => domain.name);
}

function renderedDomains(agentId: string): { listed: string[]; block: string } {
  const context = agentContextResolver.resolve({ agentId });
  const section = context.systemPromptSections.find((item) => item.kind === 'tool-library');
  if (!section) return { listed: [], block: '' };
  const block = context.systemPrompt.slice(section.start, section.end);
  const listed = block.split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split('：')[0].trim());
  return { listed, block };
}

test('every role only gets the tool-library domains it can load something from', () => {
  const team = agentConfigStore.getTeamConfig();
  assert.ok(team.roles.length >= 2, 'the team must keep several roles for this test to mean anything');

  for (const roleId of team.roles) {
    const visibility = resolvedVisibility(roleId);
    const expected = domainsWithVisibleEntry(visibility);
    const { listed, block } = renderedDomains(roleId);
    assert.deepEqual(listed, expected, `role '${roleId}' must get exactly the domains it can use`);
    assert.doesNotMatch(block, /Unclassified/, 'the runtime fallback domain is not static prompt content');
    assert.doesNotMatch(block, /\b\d+ tools?\b/, 'the prompt must not invent tool counts');
  }
});

test('a role with a narrow binding does not pay for the domains it cannot use', () => {
  const lead = renderedDomains('pi').listed;
  const { domains } = readToolLibraryDomains(TOOLLIBRARY_ROOT);
  assert.deepEqual(lead, domains.map((domain) => domain.name), 'the lead binds every capability, so it keeps the whole index');

  // A specialist must be a strict subset, otherwise the scoping silently stopped working.
  for (const roleId of ['searcher', 'writer', 'reviewer']) {
    const listed = renderedDomains(roleId).listed;
    assert.ok(listed.length > 0, `role '${roleId}' must still see its own domains`);
    assert.ok(listed.length < lead.length, `role '${roleId}' must not get the full curated index`);
    for (const domain of listed) assert.ok(lead.includes(domain), `role '${roleId}' listed an unknown domain '${domain}'`);
  }
});
