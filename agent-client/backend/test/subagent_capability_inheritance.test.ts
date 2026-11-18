import assert from 'node:assert/strict';
import test from 'node:test';
import { TEAM_MESSAGE_CORE_TOOL_ID, TEAM_MESSAGE_TOOL_NAME } from '../src/agent/core_tools/ids.js';
import { buildResidentTools } from '../src/agent/resident_tools.js';
import * as agentConfigStore from '../src/agent/config/agent_config_store.js';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';

// The resolver interpolates the provider's `${BIOFLOW_LLM_API_KEY_*}` reference; tests do not
// load `backend/.env`, so give the configured providers something to resolve.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

/**
 * A delegated child runs with the creating role's profile — that is the point of delegation:
 * the child has to do the role's work with the role's prompt, tools and knowledge. The one
 * thing it must not inherit is team-lead authority, because `dispatch` writes to a queue that
 * only the lead's team run drains.
 */
function toolNames(context: ReturnType<typeof agentContextResolver.resolve>): string[] {
  // Mirrors the runtime: the request's tool schemas are built from `mainAgent.coreToolIds`.
  return buildResidentTools(context.agent.coreToolIds).map((tool) => tool.function.name);
}

test('a delegated child keeps the role profile and loses only team messaging', () => {
  for (const roleId of agentConfigStore.getTeamConfig().roles) {
    const parent = agentContextResolver.resolve({ agentId: roleId, delegationDepth: 0 });
    const child = agentContextResolver.resolve({ agentId: roleId, delegationDepth: 1 });

    assert.equal(child.agent.id, roleId, `${roleId}: the child keeps the creating role`);
    assert.equal(child.agent.role, parent.agent.role);
    assert.deepEqual(child.agent.skillIds, parent.agent.skillIds, `${roleId}: skills are inherited`);
    assert.deepEqual(child.agent.knowledgeEntryIds, parent.agent.knowledgeEntryIds, `${roleId}: knowledge entries are inherited`);
    assert.deepEqual(
      child.mcpServers.map((server) => server.id),
      parent.mcpServers.map((server) => server.id),
      `${roleId}: MCP servers are inherited`,
    );
    assert.deepEqual(child.skills.map((skill) => skill.id), parent.skills.map((skill) => skill.id));
    assert.equal(child.llmProvider.id, parent.llmProvider.id, `${roleId}: the model is inherited`);
    assert.equal(child.agent.systemPrompt, parent.agent.systemPrompt, `${roleId}: the prompt is inherited`);

    // …and dispatch is the only removal.
    const expected = parent.coreTools.map((tool) => tool.id).filter((id) => id !== TEAM_MESSAGE_CORE_TOOL_ID);
    assert.deepEqual(child.coreTools.map((tool) => tool.id), expected, `${roleId}: team messaging is the only CoreTool dropped`);
    assert.ok(!toolNames(child).includes(TEAM_MESSAGE_TOOL_NAME), `${roleId}: the child tool list must not offer team_message`);
  }
});

test('dispatch is inherited by the lead itself but never by its children', () => {
  const lead = agentContextResolver.resolve({ agentId: 'pi', delegationDepth: 0 });
  assert.ok(lead.coreTools.some((tool) => tool.id === TEAM_MESSAGE_CORE_TOOL_ID), 'the lead keeps team messaging');
  assert.ok(toolNames(lead).includes(TEAM_MESSAGE_TOOL_NAME), 'the lead tool list offers team_message');
  assert.match(lead.systemPrompt, /Team messaging is enabled/, 'the lead prompt catalog lists team messaging');

  const child = agentContextResolver.resolve({ agentId: 'pi', delegationDepth: 1 });
  assert.ok(!child.coreTools.some((tool) => tool.id === TEAM_MESSAGE_CORE_TOOL_ID));
  assert.doesNotMatch(child.systemPrompt, /Team messaging is enabled/, 'the child prompt catalog must not list team messaging');
  assert.match(child.systemPrompt, /你是这个研究团队的 PI/, 'everything else about the profile is still inherited');
});
