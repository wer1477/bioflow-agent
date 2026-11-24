import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createConversation } from '../src/agent/config/conversation_service.js';
import { executeTeamMessage } from '../src/agent/core_tools/team_message_executor.js';
import {
  TEAM_MESSAGE_KEEP,
  buildTeamMessage,
  renderTeamMessagePrompt,
  summarizeTeamMessage,
} from '../src/agent/team/message.js';
import {
  drainTeamMessages,
  enqueueTeamMessage,
  peekTeamMessages,
  recoverTeamMessages,
  startTeamMessage,
} from '../src/agent/team/message_bus.js';
import { appendHandoffCard, appendTeamMessage, ensureRoleSession, readTeamState } from '../src/agent/team/team_service.js';
import { findSessionProjectKey } from '../src/agent/config/conversation_file_store.js';
import { createWorkspaceArtifact, saveArtifact } from '../src/agent/config/workspace_artifact_store.js';
import { teamStateFilePath } from '../src/agent/config/session_paths.js';
import { buildHandoffCard } from '../src/agent/team/dispatch.js';
import { createTempProject } from './helpers/project_fixture.js';

function delegateMessage(index: number) {
  return buildTeamMessage({
    kind: 'delegate',
    from: 'pi',
    to: 'searcher',
    body: `任务 ${index}`,
    expect: `产出 ${index}`,
  });
}

test('a team message names its author and kind in the row the role reads', () => {
  const message = buildTeamMessage({
    kind: 'delegate',
    from: 'pi',
    to: 'searcher',
    body: '找三篇 2024 年后的综述',
    expect: '三篇带 DOI 的文献',
  });

  const prompt = renderTeamMessagePrompt(message);
  assert.equal(prompt.split('\n')[0], '[团队消息 · 来自 pi · 委派]', 'the injected row must carry author and kind');
  assert.match(prompt, /找三篇 2024 年后的综述/);
  assert.match(prompt, /验收标准：三篇带 DOI 的文献/);
  assert.match(summarizeTeamMessage(message), /^\[pi → searcher\] 委派：/);
});

test('the durable record keeps the newest messages and drops the oldest', (t) => {
  const project = createTempProject('message-record');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const total = TEAM_MESSAGE_KEEP + 5;
  for (let index = 0; index < total; index += 1) {
    appendTeamMessage(root.id, delegateMessage(index));
  }

  const state = readTeamState(root.id);
  assert.equal(state.messages.length, TEAM_MESSAGE_KEEP, 'the record is capped');
  assert.equal(state.messages[0].body, `任务 ${total - TEAM_MESSAGE_KEEP}`, 'the oldest entries are the ones dropped');

  const projectKey = findSessionProjectKey(root.id);
  assert.ok(projectKey, 'the root has a session directory');
  const file = teamStateFilePath(projectKey, root.id);
  assert.ok(file, 'the root has a team state file');
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { messages: unknown[] };
  assert.equal(record.messages.length, TEAM_MESSAGE_KEEP, 'the cap is written to team.json, not just applied in memory');
});

test('the queue hands every pending message over once, in order', (t) => {
  const project = createTempProject('message-queue');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  enqueueTeamMessage(root.id, delegateMessage(1));
  enqueueTeamMessage(root.id, delegateMessage(2));
  assert.deepEqual(peekTeamMessages(root.id).map((message) => message.body), ['任务 1', '任务 2'], 'peek leaves the queue intact');

  assert.deepEqual(drainTeamMessages(root.id).map((message) => message.body), ['任务 1', '任务 2']);
  assert.deepEqual(drainTeamMessages(root.id), [], 'a drained queue is empty');
});

test('team_message records a typed delegate message instead of an opaque request', async (t) => {
  const project = createTempProject('message-dispatch');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const result = await executeTeamMessage(
    { action: 'delegate', to: 'searcher', task: '找三篇综述', expect: '带 DOI' },
    { conversationId: root.id, agent: { id: 'pi', role: 'pi' } as never },
  );
  assert.match(result, /"ok":true/);

  const [message] = drainTeamMessages(root.id);
  assert.equal(message.kind, 'delegate');
  assert.equal(message.from, 'pi');
  assert.equal(message.to, 'searcher');
  assert.equal(message.body, '找三篇综述');
  assert.equal(message.expect, '带 DOI');

  const state = readTeamState(root.id);
  assert.equal(state.messages.length, 1, 'the sent message is on the durable record');
  assert.equal(state.messages[0].id, message.id);
});

test('team delivery recovery reclaims unstarted work and preserves interrupted actions', (t) => {
  const project = createTempProject('delivery-recovery');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const first = delegateMessage(1);
  const second = delegateMessage(2);
  enqueueTeamMessage(root.id, first);
  enqueueTeamMessage(root.id, second);
  enqueueTeamMessage(root.id, second);
  assert.deepEqual(drainTeamMessages(root.id).map((message) => message.id), [first.id, second.id]);
  startTeamMessage(root.id, first.id);

  recoverTeamMessages(root.id);
  assert.deepEqual(readTeamState(root.id).pendingDeliveries.map(({ state }) => state), ['interrupted', 'queued']);
  assert.deepEqual(drainTeamMessages(root.id).map((message) => message.id), [second.id]);
  startTeamMessage(root.id, second.id);
  appendHandoffCard(root.id, buildHandoffCard({
    messageId: second.id,
    fromRole: 'searcher',
    toRole: 'pi',
    goal: second.body,
    answer: 'Result artifact saved.',
    artifacts: ['output/source-evidence.csv'],
    artifactVersions: [{ id: 'result', path: 'output/source-evidence.csv', version: 'v2' }],
  }));

  recoverTeamMessages(root.id);
  const state = readTeamState(root.id);
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.pendingDeliveries.map(({message, state}) => [message.id, state]), [[first.id, 'interrupted']]);
  assert.equal(state.cards[0].artifactVersions?.[0].version, 'v2');
});

test('team dependencies wait for the recorded handoff and block on a stale artifact version', async (t) => {
  const project = createTempProject('team-dependencies');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const research = ensureRoleSession(root.id, 'researcher');
  const upstream = buildTeamMessage({ kind: 'delegate', from: 'pi', to: 'researcher', body: 'Produce an input manifest.' });
  enqueueTeamMessage(root.id, upstream);
  const pi = { conversationId: root.id, agent: { id: 'pi', role: 'pi' } as never };
  const args = { action: 'delegate', to: 'writer', task: 'Summarize the manifest' };
  const unknown = JSON.parse(await executeTeamMessage({ ...args, after: ['unregistered'] }, pi));
  assert.equal(unknown.error.code, 'unknown_dependency');
  const queued = JSON.parse(await executeTeamMessage({ ...args, after: [upstream.id] }, pi));
  assert.equal(queued.ok, true);
  assert.deepEqual(drainTeamMessages(root.id).map((message) => message.id), [upstream.id]);

  const artifact = createWorkspaceArtifact({
    conversationId: research.id,
    scope: 'shared', planId: null, executionId: null, type: 'table', title: 'Manifest',
    path: 'output/manifest.csv', mimeType: 'text/csv', summary: '', tags: [],
    status: 'ready', createdByAgentId: 'researcher', metadata: {},
  });
  appendHandoffCard(root.id, buildHandoffCard({
    messageId: upstream.id, fromRole: 'researcher', toRole: 'pi', goal: upstream.body,
    answer: 'Manifest ready.', artifacts: [artifact.path],
    artifactVersions: [{ id: artifact.id, path: artifact.path, version: artifact.updatedAt }],
  }));
  assert.deepEqual(drainTeamMessages(root.id).map((message) => message.id), [queued.messageId]);
  recoverTeamMessages(root.id);
  const revisedAt = new Date(Date.parse(artifact.updatedAt) + 1000).toISOString();
  saveArtifact({ ...artifact, updatedAt: revisedAt });
  assert.deepEqual(drainTeamMessages(root.id), []);
  const [blocked] = readTeamState(root.id).pendingDeliveries;
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.reason || '', /产物版本已失效/);
});
