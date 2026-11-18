import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/agent/config/conversation_service.js';
import { listContextMessages } from '../src/agent/config/context_message_store.js';
import { TEAM_ROLE_IDS } from '../src/agent/config/agent_config_store.js';
import { executeTeamMessage } from '../src/agent/core_tools/team_message_executor.js';
import { drainTeamMessages } from '../src/agent/team/message_bus.js';
import { ensureRoleSession, readTeamState } from '../src/agent/team/team_service.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * A config dir with no `biod.json`: the gate is disabled, which is the deterministic way to
 * exercise the escalate path without standing up a sidecar.
 */
async function withTeamConfig<T>(callback: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-team-message-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(dir, 'llm.json'), JSON.stringify([{
    id: 'test', name: 'Test', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model', apiKey: 'unused', isDefault: true, contextWindowTokens: 100_000,
  }]), 'utf8');
  await writeFile(path.join(dir, 'agents.json'), JSON.stringify({
    schemaVersion: 2,
    team: {
      leadRoleId: 'pi',
      roles: [...TEAM_ROLE_IDS],
      router: { engine: 'always-pi', fallbackRoleId: 'pi' },
      limits: { maxConcurrentDispatches: 3 },
    },
    agents: TEAM_ROLE_IDS.map((role) => ({
      id: role,
      name: role,
      label: role,
      description: '',
      orchestratorDescription: '',
      promptFile: `prompts/${role}.md`,
      llmProviderId: 'test',
      securityMode: 'unrestricted',
      coreToolIds: ['team_message'],
      knowledgeEntryIds: [],
      mcpServerIds: [],
      skillIds: [],
      createdAt: now,
      updatedAt: now,
    })),
  }), 'utf8');
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function teamRoot(t: { after: (fn: () => void) => void }) {
  const project = createTempProject('team-message-roles');
  t.after(() => project.cleanup());
  return createConversation({ title: 'team', projectPath: project.projectPath });
}

function as(role: string) {
  return { id: role, role } as never;
}

test('a role cannot delegate, and a delegated child cannot message at all', async (t) => {
  await withTeamConfig(async () => {
    const root = teamRoot(t);

    const delegate = await executeTeamMessage(
      { action: 'delegate', to: 'writer', task: 'x' },
      { conversationId: root.id, agent: as('searcher') },
    );
    assert.match(delegate, /action_not_allowed/);

    const child = await executeTeamMessage(
      { action: 'deliver', content: 'x' },
      { conversationId: root.id, agent: as('pi'), delegationDepth: 1 },
    );
    assert.match(child, /messages_not_allowed/);
  });
});

test('a role delivers to the lead and the message is typed as a delivery', async (t) => {
  await withTeamConfig(async () => {
    const root = teamRoot(t);

    const result = await executeTeamMessage(
      { action: 'deliver', content: '三篇文献已找到，但缺少对照组' },
      { conversationId: root.id, agent: as('searcher') },
    );
    assert.match(result, /"ok":true/);

    const [message] = drainTeamMessages(root.id);
    assert.equal(message.kind, 'deliver');
    assert.equal(message.from, 'searcher');
    assert.equal(message.to, 'pi', 'a delivery always goes to the lead');
    assert.match(message.body, /缺少对照组/);

    const state = readTeamState(root.id);
    assert.equal(state.messages.at(-1)?.kind, 'deliver');
  });
});

test('a role cannot relay to the lead — that route is deliver', async (t) => {
  await withTeamConfig(async () => {
    const root = teamRoot(t);
    const result = await executeTeamMessage(
      { action: 'relay', to: 'pi', content: 'x' },
      { conversationId: root.id, agent: as('searcher') },
    );
    assert.match(result, /use_deliver/);
    assert.deepEqual(drainTeamMessages(root.id), []);
  });
});

test('an undecided peer relay escalates to the lead instead of blocking the role', async (t) => {
  await withTeamConfig(async () => {
    const root = teamRoot(t);

    const result = await executeTeamMessage(
      { action: 'relay', to: 'writer', content: '需要对照组的样本量', why: '结论不一致' },
      { conversationId: root.id, agent: as('searcher') },
    );
    assert.match(result, /"pending":"lead_decision"/);
    assert.match(result, /交给 pi 判断/);

    const queued = drainTeamMessages(root.id);
    assert.equal(queued.length, 1, 'the escalation is the only thing queued');
    assert.equal(queued[0].kind, 'deliver');
    assert.equal(queued[0].from, 'searcher');
    assert.equal(queued[0].to, 'pi');
    assert.match(queued[0].body, /\[待裁决\]/);
    assert.match(queued[0].body, /需要对照组的样本量/);

    // The lead keeps visibility without being woken: the notice is in its transcript.
    const leadSession = ensureRoleSession(root.id, 'pi');
    const notices = listContextMessages(leadSession.id);
    assert.ok(notices.some((entry) => entry.content.includes('[团队通信 · searcher → writer')), 'the lead sees the request');
  });
});

test('a lead relay is not gated', async (t) => {
  await withTeamConfig(async () => {
    const root = teamRoot(t);
    const result = await executeTeamMessage(
      { action: 'relay', to: 'writer', content: '评审已经通过了方法学部分' },
      { conversationId: root.id, agent: as('pi') },
    );
    assert.match(result, /"ok":true/);
    assert.match(result, /"action":"relay"/);

    const [message] = drainTeamMessages(root.id);
    assert.equal(message.from, 'pi');
    assert.equal(message.to, 'writer');
    assert.equal(message.gate, undefined, 'the gate only judges role-to-role hops');
  });
});
