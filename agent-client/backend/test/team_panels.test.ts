import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { ensureRoleSession } from '../src/agent/team/team_service.js';
import { readCurrentGoal } from '../src/agent/core_tools/goal_executor.js';
import { runRegistry } from '../src/agent/run_registry.js';
import { appendConversationStateEvent } from '../src/agent/transcript_store.js';
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

async function getJson(url: string): Promise<any> {
  return (await fetch(url)).json();
}

test('one goal is visible to the Web on the root and to the model in every role session', async () => {
  const server = await startTestServer();
  const project = createTempProject('team-panels');
  const root = createConversation({ projectPath: project.projectPath, title: 'team' });
  const pi = ensureRoleSession(root.id, 'pi');
  // A delegated child is isolated on purpose: it must not inherit state it was never given.
  const child = createConversation({
    projectPath: project.projectPath,
    title: 'Subagent · probe',
    parentConversationId: pi.id,
    subagentDepth: 1,
  });
  try {
    const base = (id: string) => `${server.origin}/api/conversations/${id}`;

    const created = await fetch(`${base(root.id)}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', objective: 'Finish the clustering report', max_rounds: 3 }),
    });
    assert.equal(created.status, 200);
    const goal = (await created.json()).goal;

    const rootPanels = await getJson(`${base(root.id)}/panels`);
    assert.equal(rootPanels.scope, 'team');
    assert.equal(rootPanels.goal.id, goal.id);

    // The role session reads the same document, and so does the model inside it.
    const rolePanels = await getJson(`${base(pi.id)}/panels`);
    assert.equal(rolePanels.goal.id, goal.id);
    assert.equal(readCurrentGoal(pi.id)?.id, goal.id);

    // A to-do list written by a role is visible on the team root after a reload.
    appendConversationStateEvent(pi.id, {
      type: 'planning_panel',
      panel: 'todo',
      status: 'active',
      title: '任务',
      todos: [{ id: 't1', text: 'load matrix', status: 'in_progress' }],
    });
    const merged = await getJson(`${base(root.id)}/panels`);
    assert.deepEqual(merged.todos.map((todo: { id: string }) => todo.id), ['t1']);

    // A subagent is conversation-scoped: no team goal leaks into it.
    const childPanels = await getJson(`${base(child.id)}/panels`);
    assert.equal(childPanels.scope, 'conversation');
    assert.equal(childPanels.goal, null);
  } finally {
    deleteConversation(root.id);
    project.cleanup();
    await server.close();
  }
});

test('a team goal mutation is refused while any of its sessions is running', async () => {
  const server = await startTestServer();
  const project = createTempProject('team-panels-running');
  const root = createConversation({ projectPath: project.projectPath, title: 'team' });
  const pi = ensureRoleSession(root.id, 'pi');
  const release = await runRegistry.acquire(pi.id);
  try {
    const response = await fetch(`${server.origin}/api/conversations/${root.id}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(response.status, 409);
  } finally {
    release();
    deleteConversation(root.id);
    project.cleanup();
    await server.close();
  }
});
