import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import {
  createConversation,
  createMessage,
  deleteConversation,
  getConversation,
  getMessages,
  updateConversation,
} from '../src/agent/config/conversation_service.js';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';
import { listSubagentConversations } from '../src/agent/subagent_catalog.js';
import {
  describeTeam,
  ensureRoleSession,
  listRoleSessions,
  readTeamState,
  resolveTeamRoot,
  updateTeamState,
} from '../src/agent/team/team_service.js';
import { createTempProject } from './helpers/project_fixture.js';

test('a role session is created once per role and inherits the root project', (t) => {
  const project = createTempProject('team-container');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const searcher = ensureRoleSession(root.id, 'searcher');
  assert.equal(searcher.parentConversationId, root.id);
  assert.equal(searcher.roleId, 'searcher');
  assert.equal(searcher.projectPath, root.projectPath, 'the role works in the same directory');
  assert.equal(searcher.subagentDepth, 0);

  const again = ensureRoleSession(root.id, 'searcher');
  assert.equal(again.id, searcher.id, 'a second call reuses the session');
  assert.equal(listRoleSessions(root.id).length, 1);

  const pi = ensureRoleSession(root.id, 'pi');
  assert.deepEqual(listRoleSessions(root.id).map((session) => session.roleId).sort(), ['pi', 'searcher']);
  assert.notEqual(pi.id, searcher.id);
});

test('a role session cannot own role sessions', (t) => {
  const project = createTempProject('team-nested');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const writer = ensureRoleSession(root.id, 'writer');
  assert.throws(() => ensureRoleSession(writer.id, 'reviewer'), /cannot own role sessions/);
});

test('role sessions are hidden from the subagent panel and resolve to the root', (t) => {
  const project = createTempProject('team-hidden');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const reviewer = ensureRoleSession(root.id, 'reviewer');
  const subagent = createConversation({
    title: 'Subagent · probe',
    projectPath: project.projectPath,
    parentConversationId: reviewer.id,
    subagentDepth: 1,
    subagentDescription: 'probe',
  });

  // The root's own panel now covers the delegations its role sessions made; the role
  // sessions themselves stay out of it (they are the team, not delegations).
  assert.deepEqual(listSubagentConversations(root.id).map((row) => row.conversationId), [subagent.id]);
  assert.equal(listSubagentConversations(root.id)[0]?.roleId, 'reviewer');
  assert.deepEqual(listSubagentConversations(reviewer.id).map((row) => row.conversationId), [subagent.id]);
  assert.equal(resolveTeamRoot(reviewer.id)?.id, root.id);
  assert.equal(resolveTeamRoot(root.id)?.id, root.id);
});

test('the team roster lists every role and reports which sessions exist', (t) => {
  const project = createTempProject('team-roster');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const before = describeTeam(root.id);
  assert.ok(before);
  assert.equal(before!.roles.length, 5);
  assert.deepEqual(before!.roles.map((role) => role.id), ['pi', 'searcher', 'researcher', 'writer', 'reviewer']);
  assert.equal(before!.roles.every((role) => role.sessionId === null), true);
  assert.equal(before!.roles.every((role) => role.label.length > 0), true);

  const searcher = ensureRoleSession(root.id, 'searcher');
  createMessage({ conversationId: searcher.id, role: 'user', content: 'hi', toolCalls: null });

  const after = describeTeam(searcher.id);
  assert.ok(after, 'the roster is reachable from a role session too');
  assert.equal(after!.rootId, root.id);
  assert.equal(after!.roles.find((role) => role.id === 'searcher')?.sessionId, searcher.id);
  assert.equal(after!.roles.find((role) => role.id === 'searcher')?.messageCount, 1);
});

test('team state defaults to auto on the lead role and persists edits', (t) => {
  const project = createTempProject('team-state');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  assert.deepEqual(readTeamState(root.id), {
    schemaVersion: 1,
    mode: 'auto',
    activeRoleId: 'pi',
    lastRoute: null,
    cards: [],
    messages: [],
    pendingDeliveries: [],
    handoffOutcomes: {},
  });

  const manual = updateTeamState(root.id, { mode: 'manual', activeRoleId: 'writer' });
  assert.equal(manual.mode, 'manual');
  assert.equal(manual.activeRoleId, 'writer');
  assert.deepEqual(readTeamState(root.id).activeRoleId, 'writer');

  const normalized = updateTeamState(root.id, { activeRoleId: 'nobody' as never });
  assert.equal(normalized.activeRoleId, 'writer', 'an unknown role falls back to the current one');
});

test('the merged timeline interleaves the root and every role session by time', (t) => {
  const project = createTempProject('team-timeline');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const searcher = ensureRoleSession(root.id, 'searcher');
  const writer = ensureRoleSession(root.id, 'writer');

  createMessage({ conversationId: root.id, role: 'user', content: 'old root message', toolCalls: null });
  createMessage({ conversationId: searcher.id, role: 'assistant', content: 's1', toolCalls: null });
  createMessage({ conversationId: writer.id, role: 'assistant', content: 'w1', toolCalls: null });

  const rows = [
    ...getMessages(root.id).map((message) => ({ ...message, roleId: null as string | null })),
    ...listRoleSessions(root.id).flatMap((session) => (
      getMessages(session.id).map((message) => ({ ...message, roleId: session.roleId || null }))
    )),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.content).sort(), ['old root message', 's1', 'w1']);
  assert.deepEqual(rows.map((row) => row.roleId).filter(Boolean).sort(), ['searcher', 'writer']);
});

test('deleting the root deletes every role session', (t) => {
  const project = createTempProject('team-delete');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const pi = ensureRoleSession(root.id, 'pi');
  const reviewer = ensureRoleSession(root.id, 'reviewer');

  assert.equal(deleteConversation(root.id), true);
  assert.equal(getConversation(root.id), undefined);
  assert.equal(getConversation(pi.id), undefined);
  assert.equal(getConversation(reviewer.id), undefined);
});

test('GET /:id/team and PUT /:id/team round-trip through the router', async (t) => {
  const project = createTempProject('team-route');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const app = express();
  app.use(express.json());
  app.use('/api/conversations', conversationsRouter);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const get = await fetch(`${origin}/api/conversations/${root.id}/team`);
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.rootId, root.id);
  assert.equal(body.mode, 'auto');
  assert.equal(body.roles.length, 5);

  const put = await fetch(`${origin}/api/conversations/${root.id}/team`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'manual', activeRoleId: 'researcher' }),
  });
  assert.equal(put.status, 200);
  const updated = await put.json();
  assert.equal(updated.mode, 'manual');
  assert.equal(updated.activeRoleId, 'researcher');
  assert.equal(updated.lastRoute.source, 'manual');
  // Picking a role materialises its session so the Web can switch into it immediately.
  const researcherSession = updated.roles.find((role: { id: string }) => role.id === 'researcher')?.sessionId;
  assert.ok(researcherSession, 'the selected role session exists');
  assert.equal(getConversation(researcherSession)?.roleId, 'researcher');

  const invalid = await fetch(`${origin}/api/conversations/${root.id}/team`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activeRoleId: 'hacker' }),
  });
  assert.equal(invalid.status, 400);

  const missing = await fetch(`${origin}/api/conversations/does-not-exist/team`);
  assert.equal(missing.status, 404);
});

test('the team root takes its name from the first message, and keeps a name typed by hand', (t) => {
  const project = createTempProject('team-naming');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'New conversation', projectPath: project.projectPath });
  const pi = ensureRoleSession(root.id, 'pi');

  agentContextResolver.maybeUpdateTeamRootTitle(root.id, 'Run the FASTQ quality report and summarize the warnings');
  assert.match(getConversation(root.id)?.title || '', /^Run the FASTQ quality report/);
  // The role session is the row for the role, not for the conversation the user reads.
  assert.equal(getConversation(pi.id)?.title, 'PI');

  // A name the user typed survives every later turn.
  updateConversation(root.id, { title: 'QC review' });
  agentContextResolver.maybeUpdateTeamRootTitle(root.id, 'and now check the adapters');
  assert.equal(getConversation(root.id)?.title, 'QC review');

  // An empty title counts as unnamed, so a hand-written session still gets a name.
  updateConversation(root.id, { title: '' });
  agentContextResolver.maybeUpdateTeamRootTitle(root.id, 'trim adapters');
  assert.match(getConversation(root.id)?.title || '', /^trim adapters/);
});
