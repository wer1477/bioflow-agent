import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { appendConversationStateEvent } from '../src/agent/transcript_store.js';
import { executeGoalTool } from '../src/agent/core_tools/goal_executor.js';
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

async function readJson(response: Response): Promise<any> {
  return response.json();
}

test('goal routes and tools operate on the durable panels', async () => {
  const project = createTempProject('goal-panels');
  const conversation = createConversation({ projectPath: project.projectPath, title: 'Goal test' });
  const server = await startTestServer();
  const base = `${server.origin}/api/conversations/${conversation.id}`;

  try {
    // 1. A fresh conversation has no panels at all.
    const empty = await readJson(await fetch(`${base}/panels`));
    assert.equal(empty.goal, null);
    assert.equal(empty.todos, null);

    // 2. A todo write becomes visible through the fold.
    appendConversationStateEvent(conversation.id, {
      type: 'planning_panel',
      panel: 'todo',
      status: 'active',
      title: '任务',
      todos: [
        { id: 't1', text: 'load matrix', status: 'completed' },
        { id: 't2', text: 'cluster cells', status: 'in_progress' },
      ],
    });
    const withTodos = await readJson(await fetch(`${base}/panels`));
    assert.deepEqual(withTodos.todos.map((todo: { status: string }) => todo.status), ['completed', 'in_progress']);

    // 3. Create a goal from the Web action.
    const created = await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', objective: 'Finish the clustering report', max_rounds: 3 }),
    });
    assert.equal(created.status, 200);
    const createdBody = await readJson(created);
    assert.equal(createdBody.goal.phase, 'active');
    assert.equal(createdBody.goal.maxRounds, 3);
    assert.equal(createdBody.goal.autoContinue, true);

    // 4. The fold agrees with what the endpoint returned.
    const panels = await readJson(await fetch(`${base}/panels`));
    assert.equal(panels.goal.id, createdBody.goal.id);
    assert.equal(panels.goal.roundsStarted, 0);

    // 5. Pause then resume keeps the same goal identity.
    const paused = await readJson(await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    }));
    assert.equal(paused.goal.phase, 'paused');
    assert.equal(paused.goal.autoContinue, false);

    const resumed = await readJson(await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    }));
    assert.equal(resumed.goal.phase, 'active');
    assert.equal(resumed.goal.id, createdBody.goal.id);

    // 6. A second create is refused while the goal is still current.
    const conflict = await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', objective: 'another goal' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await readJson(conflict)).code, 'GOAL_ALREADY_EXISTS');

    // 7. Unknown actions are a client error, not a state change.
    const bogus = await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'explode' }),
    });
    assert.equal(bogus.status, 400);

    // 8. The model-facing tool reads the same document.
    const read = JSON.parse(executeGoalTool('get_goal', {}, { conversationId: conversation.id }));
    assert.equal(read.ok, true);
    assert.equal(read.goal.id, resumed.goal.id);
    assert.equal(read.goal.revision, resumed.goal.revision);

    // 9. A stale revision is rejected instead of silently overwriting.
    const stale = JSON.parse(executeGoalTool('update_goal', {
      goal_id: resumed.goal.id,
      revision: resumed.goal.revision - 1,
      action: 'complete',
    }, { conversationId: conversation.id }));
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'GOAL_STALE_REVISION');

    // 10. A delegated run may not pause the goal, but may report it complete.
    const delegatedPause = JSON.parse(executeGoalTool('update_goal', {
      goal_id: resumed.goal.id,
      revision: resumed.goal.revision,
      action: 'pause',
    }, { conversationId: conversation.id, delegationDepth: 1 }));
    assert.equal(delegatedPause.ok, false);
    assert.equal(delegatedPause.code, 'GOAL_REQUIRES_TOP_LEVEL_AGENT');

    const completed = JSON.parse(executeGoalTool('update_goal', {
      goal_id: resumed.goal.id,
      revision: resumed.goal.revision,
      action: 'complete',
    }, { conversationId: conversation.id, delegationDepth: 1 }));
    assert.equal(completed.ok, true);
    assert.equal(completed.goal.phase, 'complete');

    // 11. Clear produces a tombstone the fold turns back into "no goal".
    const cleared = await readJson(await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    }));
    assert.equal(cleared.goal, null);
    assert.equal((await readJson(await fetch(`${base}/panels`))).goal, null);
  } finally {
    await server.close();
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('missing conversations are 404 for both panel endpoints', async () => {
  const server = await startTestServer();
  try {
    const panels = await fetch(`${server.origin}/api/conversations/nope/panels`);
    assert.equal(panels.status, 404);
    const goal = await fetch(`${server.origin}/api/conversations/nope/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(goal.status, 404);
  } finally {
    await server.close();
  }
});
