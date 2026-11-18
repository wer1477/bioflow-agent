import assert from 'node:assert/strict';
import test from 'node:test';
import { getTeamConfig } from '../src/agent/config/agent_config_store.js';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';

// The resolver interpolates the provider's `${BIOFLOW_LLM_API_KEY_*}` reference; tests do not
// load `backend/.env`, so give the configured providers something to resolve.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

test('the lead reads the roster before it reads its tools', () => {
  const roleIds = getTeamConfig().roles;
  const lead = agentContextResolver.resolve({ agentId: 'pi', delegationDepth: 0 });
  const prompt = lead.systemPrompt;

  assert.match(prompt, /<team>/, 'the block is present');
  assert.match(prompt, /<\/team>/);

  for (const roleId of roleIds) {
    if (roleId === 'pi') continue;
    assert.match(prompt, new RegExp(`- ${roleId}（`), `${roleId} is listed`);
  }
  assert.doesNotMatch(prompt, /^- pi（/m, 'the reader is not listed as a peer');

  const team = lead.systemPromptSections.find((section) => section.kind === 'team');
  const core = lead.systemPromptSections.find((section) => section.kind === 'core-tools');
  assert.ok(team, 'the roster is a recorded prompt section');
  assert.ok(core);
  assert.ok(team.start < core.start, 'the roster comes before the tool catalog');

  // The three routes the lead actually has — described as routes, not as an approval flow.
  // Scoped to the roster: the tool catalog below it also names every action.
  const block = prompt.slice(team.start, team.end);
  assert.match(block, /action="delegate"/);
  assert.match(block, /action="append"/);
  assert.match(block, /action="relay"/);
  assert.doesNotMatch(block, /action="deliver"/, 'the lead does not deliver to itself');
  assert.doesNotMatch(block, /经 PI 批准|由 PI 转达/, 'the prompt must not invent an approval hop');
});

test('a role reads the same roster and only the routes it can use', () => {
  const roleIds = getTeamConfig().roles;
  for (const roleId of roleIds) {
    if (roleId === 'pi') continue;
    const context = agentContextResolver.resolve({ agentId: roleId, delegationDepth: 0 });
    const prompt = context.systemPrompt;

    const team = context.systemPromptSections.find((section) => section.kind === 'team');
    assert.ok(team, `${roleId} has a roster section`);
    const block = prompt.slice(team.start, team.end);

    assert.match(block, /action="deliver"/, `${roleId} delivers to the lead`);
    assert.match(block, /action="relay"/, `${roleId} can relay to a peer`);
    assert.doesNotMatch(block, /action="delegate"/, `${roleId} must not see a lead-only route`);
    assert.doesNotMatch(block, /action="append"/, `${roleId} must not see a lead-only route`);

    // The roster lists the lead and the other roles, never the reader itself.
    assert.match(block, /- pi（/, `${roleId} sees the lead`);
    assert.doesNotMatch(block, new RegExp(`^- ${roleId}（`, 'm'), `${roleId} is not listed as a peer`);
  }
});

test('a delegated child loses the roster together with the tool', () => {
  for (const roleId of getTeamConfig().roles) {
    const child = agentContextResolver.resolve({ agentId: roleId, delegationDepth: 1 });
    assert.doesNotMatch(child.systemPrompt, /<team>/, `${roleId}: the child has no team authority`);
  }
});
