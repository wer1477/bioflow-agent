import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CONFIG_ROOT, KNOWLEDGEBASE_ROOT, SKILLS_ROOT } from '../src/paths.js';

/**
 * The five roles bind different subsets of the same capability pools, so a typo or a
 * deleted capability stays invisible until a role happens to need it at runtime.
 * These tests read the shipped configuration and check every binding still resolves.
 */

interface AgentBinding {
  id: string;
  coreToolIds?: string[];
  skillIds?: string[];
  mcpServerIds?: string[];
  knowledgeEntryIds?: string[];
}

interface McpServerRow {
  id: string;
  enabled?: boolean;
  internal?: boolean;
}

const agents: AgentBinding[] = JSON.parse(fs.readFileSync(path.join(CONFIG_ROOT, 'agents.json'), 'utf8')).agents;
const mcpServers: McpServerRow[] = JSON.parse(fs.readFileSync(path.join(CONFIG_ROOT, 'mcp.json'), 'utf8')).servers;

test('every agent capability binding resolves to a shipped capability', () => {
  const serverIds = new Set(mcpServers.map((server) => server.id));
  for (const agent of agents) {
    for (const skillId of agent.skillIds || []) {
      const file = path.join(SKILLS_ROOT, skillId, 'SKILL.md');
      assert.equal(fs.existsSync(file), true, `${agent.id} binds skill '${skillId}' which has no ${file}`);
    }
    for (const serverId of agent.mcpServerIds || []) {
      assert.equal(serverIds.has(serverId), true, `${agent.id} binds MCP server '${serverId}' which is missing from mcp.json`);
    }
    for (const entryId of agent.knowledgeEntryIds || []) {
      const file = path.join(KNOWLEDGEBASE_ROOT, entryId, 'skill.md');
      assert.equal(fs.existsSync(file), true, `${agent.id} binds knowledge entry '${entryId}' which has no skill.md`);
    }
  }
});

test('every agent that can call web_search binds an enabled internal search provider', () => {
  // web_search is executed by the dispatcher against the MCP servers the agent binds;
  // `internal` servers (Tavily/Exa) are the providers, and they are hidden from the tool library.
  const searchProviders = new Set(
    mcpServers.filter((server) => server.internal === true && server.enabled !== false).map((server) => server.id),
  );
  assert.ok(searchProviders.size > 0, 'mcp.json must keep at least one enabled internal search provider');

  for (const agent of agents) {
    if (!(agent.coreToolIds || []).includes('web_search')) continue;
    const bound = (agent.mcpServerIds || []).filter((serverId) => searchProviders.has(serverId));
    assert.ok(bound.length > 0, `${agent.id} exposes web_search but binds no search provider (${[...searchProviders].join(', ')})`);
  }
});

test('the lead keeps the full capability pool', () => {
  const lead = agents.find((agent) => agent.id === 'pi');
  assert.ok(lead, 'the team must keep a lead role');
  const allSkills = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith('.')) return [];
      const nested = path.join(SKILLS_ROOT, entry.name);
      if (fs.existsSync(path.join(nested, 'SKILL.md'))) return [entry.name];
      return fs.readdirSync(nested, { withFileTypes: true })
        .filter((child) => child.isDirectory() && fs.existsSync(path.join(nested, child.name, 'SKILL.md')))
        .map((child) => `${entry.name}/${child.name}`);
    })
    .sort();
  assert.deepEqual([...(lead.skillIds || [])].sort(), allSkills, 'the lead role binds every shipped skill');
  assert.deepEqual([...(lead.mcpServerIds || [])].sort(), mcpServers.map((server) => server.id).sort(), 'the lead role binds every MCP server');
});
