import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import {
  createConversation,
  deleteConversation,
  getConversation,
  updateConversation,
} from '../src/agent/config/conversation_service.js';
import { createProject, listProjects } from '../src/agent/config/project_service.js';
import { createAgentRun, updateAgentRun } from '../src/agent/config/run_store.js';
import { ensureRoleSession } from '../src/agent/team/team_service.js';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';
import {
  describeSubagentConversation,
  listSubagentConversations,
  summarizeSubagents,
} from '../src/agent/subagent_catalog.js';
import { createTempProject } from './helpers/project_fixture.js';

function startTestServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/conversations', conversationsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server has no port.');
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface Delegation {
  projectPath: string;
  projectKey: string;
  parentId: string;
  runningId: string;
  completedId: string;
  idleId: string;
  cleanup: () => void;
}

/**
 * One parent and three children covering every status the catalog can report:
 * an unfinished run (`running`), a finished one (`completed`), and a child that
 * never started (`unknown`).
 */
function createDelegation(prefix: string): Delegation {
  // A hidden fixture directory would be skipped by project discovery, so this uses the
  // real creation path and removes the directory in `cleanup`.
  const project = createProject(`${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  const conversationIds: string[] = [];
  const make = (data: Parameters<typeof createConversation>[0]) => {
    const conversation = createConversation(data);
    conversationIds.push(conversation.id);
    return conversation;
  };

  const parent = make({ title: 'Parent session', projectPath: project.path });
  const running = make({
    title: 'Subagent · reads QC',
    projectPath: project.path,
    parentConversationId: parent.id,
    subagentDepth: 1,
    subagentDescription: 'reads QC',
  });
  const completed = make({
    title: 'Subagent · variant calling',
    projectPath: project.path,
    parentConversationId: parent.id,
    subagentDepth: 1,
    subagentDescription: 'variant calling',
  });
  // No `subagentDescription`: the row must fall back to the title without the prefix.
  const idle = make({
    title: 'Subagent · pathway enrichment',
    projectPath: project.path,
    parentConversationId: parent.id,
    subagentDepth: 1,
  });

  createAgentRun({ conversationId: running.id, status: 'model_turn' });
  const finishedRun = createAgentRun({ conversationId: completed.id, status: 'model_turn' });
  const completedAt = new Date(Date.parse(finishedRun.startedAt) + 4200).toISOString();
  updateAgentRun(completed.id, finishedRun.id, { status: 'completed', completedAt });
  agentContextResolver.createUserMessage(completed.id, 'count this message');

  return {
    projectPath: project.path,
    projectKey: project.key,
    parentId: parent.id,
    runningId: running.id,
    completedId: completed.id,
    idleId: idle.id,
    cleanup() {
      for (const id of conversationIds) deleteConversation(id);
      fs.rmSync(project.path, { recursive: true, force: true });
    },
  };
}

test('the catalog lists direct children with their live status, timing and message count', () => {
  const delegation = createDelegation('subagent-catalog');
  try {
    const rows = listSubagentConversations(delegation.parentId);
    const byId = new Map(rows.map((row) => [row.conversationId, row]));

    assert.equal(rows.length, 3);
    assert.equal(byId.get(delegation.runningId)?.status, 'running');
    assert.equal(byId.get(delegation.completedId)?.status, 'completed');
    assert.equal(byId.get(delegation.idleId)?.status, 'unknown');
    assert.equal(byId.get(delegation.runningId)?.description, 'reads QC');
    assert.equal(byId.get(delegation.idleId)?.description, 'pathway enrichment');
    assert.equal(byId.get(delegation.completedId)?.messageCount, 1);
    assert.ok((byId.get(delegation.completedId)?.durationMs ?? 0) >= 4200);
    assert.deepEqual(summarizeSubagents(rows), { total: 3, running: 1 });

    // The parent itself is not one of its own children.
    assert.equal(rows.some((row) => row.conversationId === delegation.parentId), false);
    assert.equal(describeSubagentConversation(delegation.parentId)?.parentConversationId, null);
  } finally {
    delegation.cleanup();
  }
});

test('the conversation list hides children while the child still resolves with its parent', async () => {
  const delegation = createDelegation('subagent-routes');
  const server = await startTestServer();
  try {
    const listed = await (await fetch(`${server.origin}/api/conversations?project=${encodeURIComponent(delegation.projectKey)}`)).json();
    const ids = listed.conversations.map((conversation: { id: string }) => conversation.id);
    assert.ok(ids.includes(delegation.parentId), 'the parent stays in the project session list');
    assert.equal(ids.includes(delegation.runningId), false, 'a child is not a project session');
    assert.equal(ids.includes(delegation.completedId), false);

    const detail = await (await fetch(`${server.origin}/api/conversations/${delegation.runningId}`)).json();
    assert.equal(detail.conversation.id, delegation.runningId);
    assert.deepEqual(detail.parent, { id: delegation.parentId, title: 'Parent session' });

    const parentDetail = await (await fetch(`${server.origin}/api/conversations/${delegation.parentId}`)).json();
    assert.equal(parentDetail.parent, null);

    const panel = await (await fetch(`${server.origin}/api/conversations/${delegation.parentId}/subagents`)).json();
    assert.equal(panel.total, 3);
    assert.equal(panel.running, 1);
    assert.deepEqual(panel.parent, { id: delegation.parentId, title: 'Parent session' });
    assert.deepEqual(
      panel.subagents.map((row: { status: string }) => row.status).sort(),
      ['completed', 'running', 'unknown'],
    );

    const missing = await fetch(`${server.origin}/api/conversations/does-not-exist/subagents`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    delegation.cleanup();
  }
});

test('a project counts only the conversations the user owns', () => {
  const delegation = createDelegation('subagent-project-counts');
  try {
    const summary = listProjects().projects.find((project) => project.key === delegation.projectKey);
    assert.equal(summary?.sessionCount, 1, 'three children must not inflate the project session count');
    assert.equal(summary?.runningCount, 0, 'a running child is not a running project session');
  } finally {
    delegation.cleanup();
  }
});

test('a delegated child keeps its delegation title instead of being renamed by its first message', () => {
  const project = createTempProject('subagent-title');
  const parent = createConversation({ title: 'Parent session', projectPath: project.projectPath });
  const child = createConversation({
    title: 'Subagent · reads QC',
    projectPath: project.projectPath,
    parentConversationId: parent.id,
    subagentDepth: 1,
    subagentDescription: 'reads QC',
  });
  const ordinary = createConversation({ title: 'New conversation', projectPath: project.projectPath });
  try {
    const delegationMessage = 'You are a delegated subagent. No user is present in this conversation: do not ask questions,';
    agentContextResolver.maybeUpdateConversationTitle(child.id, delegationMessage, 1);
    assert.equal(getConversation(child.id)?.title, 'Subagent · reads QC');
    assert.notEqual(getConversation(child.id)?.title, 'You are a delegated');

    agentContextResolver.maybeUpdateConversationTitle(ordinary.id, 'Check the FASTQ quality report for sample 12', 1);
    assert.match(getConversation(ordinary.id)?.title || '', /^Check the FASTQ/);

    // The title still only follows the first message.
    agentContextResolver.maybeUpdateConversationTitle(ordinary.id, 'second message', 2);
    assert.match(getConversation(ordinary.id)?.title || '', /^Check the FASTQ/);
  } finally {
    deleteConversation(child.id);
    deleteConversation(ordinary.id);
    deleteConversation(parent.id);
    fs.rmSync(project.projectPath, { recursive: true, force: true });
  }
});

test('a child renamed by its first message is shown under its delegation name', async () => {
  const project = createTempProject('subagent-legacy-title');
  const parent = createConversation({ title: 'Parent session', projectPath: project.projectPath });
  const child = createConversation({
    title: 'Subagent · reads QC',
    projectPath: project.projectPath,
    parentConversationId: parent.id,
    subagentDepth: 1,
    subagentDescription: 'reads QC',
  });
  // Simulate a record written before the title guard: the first message won the title.
  updateConversation(child.id, { title: 'You are a delegated' });
  const server = await startTestServer();
  try {
    const [row] = listSubagentConversations(parent.id);
    assert.equal(row.title, 'Subagent · reads QC');
    assert.equal(row.description, 'reads QC');

    const detail = await (await fetch(`${server.origin}/api/conversations/${child.id}`)).json();
    assert.equal(detail.conversation.title, 'Subagent · reads QC');
  } finally {
    await server.close();
    deleteConversation(child.id);
    deleteConversation(parent.id);
    fs.rmSync(project.projectPath, { recursive: true, force: true });
  }
});

test('deleting a parent removes the children that only its header could reach', () => {
  const project = createTempProject('subagent-cascade');
  const parent = createConversation({ title: 'Parent session', projectPath: project.projectPath });
  const child = createConversation({
    title: 'Subagent · reads QC',
    projectPath: project.projectPath,
    parentConversationId: parent.id,
    subagentDepth: 1,
    subagentDescription: 'reads QC',
  });
  const other = createConversation({ title: 'Unrelated session', projectPath: project.projectPath });
  try {
    assert.equal(deleteConversation(parent.id), true);
    assert.equal(getConversation(parent.id), undefined);
    assert.equal(getConversation(child.id), undefined, 'a child without a parent is unreachable state');
    assert.ok(getConversation(other.id), 'deleting a parent never touches unrelated sessions');
  } finally {
    deleteConversation(other.id);
    fs.rmSync(project.projectPath, { recursive: true, force: true });
  }
});

test('a team root lists the subagents its role sessions delegated', () => {
  const project = createTempProject('team-subagents');
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const pi = ensureRoleSession(root.id, 'pi');
  const writer = ensureRoleSession(root.id, 'writer');
  const child = createConversation({
    title: 'Subagent · probe',
    projectPath: project.projectPath,
    parentConversationId: pi.id,
    subagentDepth: 1,
    subagentDescription: 'probe',
  });
  try {
    const rows = listSubagentConversations(root.id);
    assert.deepEqual(rows.map((row) => row.conversationId), [child.id]);
    assert.equal(rows[0]?.roleId, 'pi');

    // The role session sees the same child, and the other role sees nothing.
    assert.deepEqual(listSubagentConversations(pi.id).map((row) => row.conversationId), [child.id]);
    assert.deepEqual(listSubagentConversations(writer.id), []);
  } finally {
    deleteConversation(root.id);
    project.cleanup();
  }
});
