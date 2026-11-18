import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { TEAM_ROLE_IDS, ensureTeamRoles, getAllAgents, getTeamConfig } from '../src/agent/config/agent_config_store.js';
import { alwaysPiRouter, decideRole, setRoleRouterForTests } from '../src/agent/team/role_router.js';
import { describeTeam, listRoleSessions, readTeamState } from '../src/agent/team/team_service.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * A provider stub that speaks the OpenAI streaming protocol: the runtime always asks for
 * `stream: true`, so a plain JSON body would fail before any routing assertion ran.
 */
async function startStreamingProvider(reply = 'hello from the role'): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) => `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
      response.write(chunk({ role: 'assistant', content: reply }, null));
      response.write(chunk({}, 'stop'));
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function withTeamConfig<T>(baseUrl: string, callback: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-team-config-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(dir, 'llm.json'), JSON.stringify([{
    id: 'test',
    name: 'Test',
    baseUrl,
    model: 'test-model',
    apiKey: 'unused',
    isDefault: true,
    contextWindowTokens: 100_000,
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
      coreToolIds: [],
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

function readNdjson(text: string): Array<Record<string, unknown>> {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

test('the shipped biod router falls back to the lead when the sidecar is disabled', async () => {
  setRoleRouterForTests(null);
  const previous = process.env.BIOFLOW_BIOD_DISABLED;
  process.env.BIOFLOW_BIOD_DISABLED = '1';
  try {
    const decision = await decideRole({ conversationId: 'c1', message: '帮我找文献', mode: 'auto', activeRoleId: 'searcher' });
    assert.equal(decision.roleId, getTeamConfig().leadRoleId);
    assert.equal(decision.source, 'fallback');
    assert.equal(decision.confidence, 0);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_BIOD_DISABLED;
    else process.env.BIOFLOW_BIOD_DISABLED = previous;
  }
});

test('manual mode keeps the role the user picked', async () => {
  setRoleRouterForTests(null);
  const decision = await decideRole({ conversationId: 'c1', message: '继续', mode: 'manual', activeRoleId: 'writer' });
  assert.equal(decision.roleId, 'writer');
  assert.equal(decision.source, 'manual');
});

test('an explicit role wins over both mode and engine', async () => {
  setRoleRouterForTests(null);
  const decision = await alwaysPiRouter.decide({
    conversationId: 'c1',
    message: '让 reviewer 看一下',
    mode: 'auto',
    activeRoleId: 'pi',
    requestedRoleId: 'reviewer',
  });
  assert.equal(decision.roleId, 'reviewer');
  assert.equal(decision.source, 'manual');
});

test('a router that throws falls back instead of losing the turn', async () => {
  setRoleRouterForTests({ decide: () => { throw new Error('classifier offline'); } });
  try {
    const decision = await decideRole({ conversationId: 'c1', message: 'x', mode: 'auto', activeRoleId: 'pi' });
    assert.equal(decision.roleId, getTeamConfig().router.fallbackRoleId);
    assert.equal(decision.source, 'fallback');
    assert.match(decision.reason, /classifier offline/);
  } finally {
    setRoleRouterForTests(null);
  }
});

test('an engine that is configured but not implemented falls back to the fallback role', async () => {
  setRoleRouterForTests(null);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-team-engine-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  try {
    await writeFile(path.join(dir, 'agents.json'), JSON.stringify({
      schemaVersion: 2,
      team: {
        leadRoleId: 'pi',
        roles: [...TEAM_ROLE_IDS],
        router: { engine: 'biod', fallbackRoleId: 'pi' },
        limits: { maxConcurrentDispatches: 3 },
      },
      agents: [],
    }), 'utf8');
    ensureTeamRoles();
    const decision = await decideRole({ conversationId: 'c1', message: 'x', mode: 'auto', activeRoleId: 'pi' });
    assert.equal(decision.roleId, 'pi');
    assert.equal(decision.source, 'fallback');
    assert.equal(getAllAgents().length, 5);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /:id/team/runs routes, runs in the role session and tags the stream', async (t) => {
  const provider = await startStreamingProvider();
  t.after(() => provider.server.close());

  await withTeamConfig(provider.baseUrl, async () => {
    const project = createTempProject('team-run');
    t.after(() => project.cleanup());
    const root = createConversation({ title: 'team', projectPath: project.projectPath });

    const app = express();
    app.use(express.json());
    app.use('/api/conversations', conversationsRouter);
    const server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created));
    });
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${origin}/api/conversations/${root.id}/team/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    assert.equal(response.status, 200);
    const events = readNdjson(await response.text());

    const route = events.find((event) => event.type === 'route_decision');
    assert.ok(route, 'the stream starts with a routing decision');
    assert.equal(route!.roleId, 'pi');
    assert.equal(events.at(-1)?.type, 'done');

    const content = events.filter((event) => event.type === 'content');
    assert.ok(content.length > 0, 'the role produced streamed content');
    assert.ok(content.every((event) => event.roleId === 'pi'), 'every relayed event carries the role');
    assert.ok(content.every((event) => typeof event.roleSessionId === 'string'));

    const sessions = listRoleSessions(root.id);
    assert.deepEqual(sessions.map((session) => session.roleId), ['pi']);
    assert.equal(readTeamState(root.id).activeRoleId, 'pi');
    assert.equal(readTeamState(root.id).lastRoute?.roleId, 'pi');
    const piRole = describeTeam(root.id)?.roles.find((role) => role.id === 'pi');
    assert.ok((piRole?.messageCount || 0) > 0, 'the role session holds the conversation');

    // The message went to the role session, not the root: the root stays a container.
    assert.equal(describeTeam(root.id)?.title, 'team');
    deleteConversation(root.id);
  });
});

test('the team run endpoint validates its input', async (t) => {
  const project = createTempProject('team-run-invalid');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const app = express();
  app.use(express.json());
  app.use('/api/conversations', conversationsRouter);
  const server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const empty = await fetch(`${origin}/api/conversations/${root.id}/team/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(empty.status, 400);

  const unknownRole = await fetch(`${origin}/api/conversations/${root.id}/team/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi', roleId: 'hacker' }),
  });
  assert.equal(unknownRole.status, 400);

  const missing = await fetch(`${origin}/api/conversations/nope/team/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi' }),
  });
  assert.equal(missing.status, 404);
});
