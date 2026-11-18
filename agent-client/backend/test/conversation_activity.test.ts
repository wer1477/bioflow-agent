import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { listConversationActivity } from '../src/agent/conversation_activity.js';
import { PersistedRunState } from '../src/agent/service/agent_service.js';
import {
  beginRunActivity,
  endRunActivity,
  resetRunActivityForTests,
  settleRunActivity,
  snapshotRunActivity,
} from '../src/agent/run_activity.js';
import { createTempProject } from './helpers/project_fixture.js';

function activityOf(snapshot, conversationId) {
  return snapshot.conversations[conversationId];
}

test('a run is live until it settles, and settling bumps the completion counter once', (t) => {
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  beginRunActivity('conv-1', 'run-1');
  let snapshot = snapshotRunActivity();
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].status, 'running');
  assert.equal(snapshot.records[0].seq, 0);

  settleRunActivity('conv-1', 'run-1', 'completed');
  snapshot = snapshotRunActivity();
  assert.equal(snapshot.records[0].status, 'completed');
  assert.equal(snapshot.records[0].seq, 1);
  assert.ok(snapshot.records[0].finishedAt);

  // A corrected status is the same completion, not a second one.
  settleRunActivity('conv-1', 'run-1', 'cancelled');
  snapshot = snapshotRunActivity();
  assert.equal(snapshot.records[0].status, 'cancelled');
  assert.equal(snapshot.records[0].seq, 1);
});

test('a settle for a run that is not the current one is ignored', (t) => {
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  beginRunActivity('conv-1', 'run-1');
  settleRunActivity('conv-1', 'stale-run', 'completed');
  assert.equal(snapshotRunActivity().records[0].status, 'running');

  // The safety net only closes an open record; it never reopens or double-settles.
  endRunActivity('conv-1', 'run-1');
  assert.equal(snapshotRunActivity().records[0].status, 'failed');
});

test('role and subagent runs light up every ancestor, with the nearest role name', (t) => {
  const project = createTempProject('activity-ancestors');
  t.after(() => project.cleanup());
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const researcher = createConversation({
    title: 'Researcher',
    projectPath: project.projectPath,
    parentConversationId: root.id,
    roleId: 'researcher',
  });
  const child = createConversation({
    title: 'Subagent · probe',
    projectPath: project.projectPath,
    parentConversationId: researcher.id,
    subagentDepth: 1,
  });

  beginRunActivity(child.id, 'child-run');
  const running = listConversationActivity();

  const childView = activityOf(running, child.id);
  assert.equal(childView.selfRunning, true);
  assert.deepEqual(childView.runningRoles, [], 'a delegated child has no role of its own');

  const roleView = activityOf(running, researcher.id);
  assert.equal(roleView.running, true);
  assert.equal(roleView.selfRunning, false, 'the role session itself is not running');
  assert.deepEqual(roleView.runningRoles, ['researcher'], 'the role that delegated the work is named');
  assert.equal(roleView.runningCount, 1);

  const rootView = activityOf(running, root.id);
  assert.equal(rootView.running, true, 'the team root inherits the activity of its roles');
  assert.equal(rootView.selfRunning, false);
  assert.deepEqual(rootView.runningRoles, ['researcher']);

  settleRunActivity(child.id, 'child-run', 'completed');
  const settled = listConversationActivity();
  for (const id of [root.id, researcher.id, child.id]) {
    assert.equal(activityOf(settled, id).running, false, `${id} stops spinning`);
  }
  assert.equal(activityOf(settled, root.id).seq, 1, 'the root carries the completion for its dot');
  assert.equal(activityOf(settled, root.id).status, 'completed');
});

test('a conversation keeps its own run separate from its descendants', (t) => {
  const project = createTempProject('activity-self');
  t.after(() => project.cleanup());
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  const root = createConversation({ title: 'plain', projectPath: project.projectPath });
  beginRunActivity(root.id, 'root-run');

  const view = activityOf(listConversationActivity(), root.id);
  assert.equal(view.selfRunning, true);
  assert.equal(view.running, true);
  assert.equal(view.runningCount, 1);
});

test('the newest settled run wins; an older one cannot overwrite it', (t) => {
  const project = createTempProject('activity-newest');
  t.after(() => project.cleanup());
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const role = createConversation({
    title: 'PI',
    projectPath: project.projectPath,
    parentConversationId: root.id,
    roleId: 'pi',
  });

  beginRunActivity(role.id, 'first');
  settleRunActivity(role.id, 'first', 'completed');
  beginRunActivity(role.id, 'second');
  settleRunActivity(role.id, 'second', 'failed');

  const view = activityOf(listConversationActivity(), role.id);
  assert.equal(view.runId, 'second');
  assert.equal(view.status, 'failed');
  assert.equal(view.seq, 2);
});

test('a deleted conversation is dropped instead of resurrecting in the sidebar', (t) => {
  const project = createTempProject('activity-deleted');
  t.after(() => project.cleanup());
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const role = createConversation({
    title: 'Writer',
    projectPath: project.projectPath,
    parentConversationId: root.id,
    roleId: 'writer',
  });

  beginRunActivity(role.id, 'run-1');
  assert.ok(activityOf(listConversationActivity(), role.id));
  deleteConversation(role.id);

  const snapshot = listConversationActivity();
  assert.equal(activityOf(snapshot, role.id), undefined);
  // Nothing is left to point at: a deleted session must not leave its team spinning.
  assert.equal(activityOf(snapshot, root.id), undefined);
});

test('the run state registers and settles activity as it runs', (t) => {
  const project = createTempProject('activity-run-state');
  t.after(() => project.cleanup());
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  const conversation = createConversation({ title: 'run', projectPath: project.projectPath });
  const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });

  assert.equal(activityOf(listConversationActivity(), conversation.id)?.running, true);

  runState.persist('completed');
  const view = activityOf(listConversationActivity(), conversation.id);
  assert.equal(view.running, false);
  assert.equal(view.status, 'completed');
  assert.equal(view.seq, 1);
  assert.ok(view.finishedAt);
});

test('GET /api/conversations/activity reports the live snapshot', async (t) => {
  const project = createTempProject('activity-route');
  t.after(() => project.cleanup());
  resetRunActivityForTests();
  t.after(() => resetRunActivityForTests());

  const conversation = createConversation({ title: 'route', projectPath: project.projectPath });
  beginRunActivity(conversation.id, 'run-1');

  const app = express();
  app.use(express.json());
  app.use('/api/conversations', conversationsRouter);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations/activity`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.epoch, 'the epoch lets the client spot a restarted process');
  assert.equal(body.conversations[conversation.id].running, true);
  assert.deepEqual(body.conversations[conversation.id].runningRoles, []);
});
