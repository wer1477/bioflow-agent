import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { executeSubagent, setSubagentRunnerForTests } from '../src/agent/core_tools/subagent_executor.js';
import { subagentRuntime } from '../src/agent/core_tools/subagent_runtime.js';
import {
  createConversation,
  deleteConversation,
  getAllConversations,
  getConversation,
  resolveAnsweringAgentId,
} from '../src/agent/config/conversation_service.js';
import { findSessionProjectKey } from '../src/agent/config/conversation_file_store.js';
import { sessionsRoot } from '../src/paths.js';
import { createTempProject } from './helpers/project_fixture.js';

/**
 * A delegated child runs with the creating role's profile. That identity has to survive the
 * run that started it: the child conversation is durable, so continuing it later must answer
 * as the same role instead of falling back to whoever the caller selected.
 */

function sessionRecordPath(conversationId: string): string {
  const projectKey = findSessionProjectKey(conversationId);
  assert.ok(projectKey, `conversation ${conversationId} must have a session directory`);
  return path.join(sessionsRoot(), projectKey, conversationId, 'session.json');
}

test('the run route picks the answering agent from the conversation first', () => {
  assert.equal(resolveAnsweringAgentId({ roleId: 'searcher', agentId: 'writer' }, 'pi'), 'searcher');
  assert.equal(resolveAnsweringAgentId({ roleId: null, agentId: 'writer' }, 'pi'), 'writer');
  assert.equal(resolveAnsweringAgentId({ roleId: null, agentId: null }, 'pi'), 'pi');
  assert.equal(resolveAnsweringAgentId({}, undefined), undefined);
  assert.equal(resolveAnsweringAgentId({ roleId: '', agentId: '' }, ''), undefined);
});

test('a delegated child conversation stores the creating role on disk', async (t) => {
  const project = createTempProject('subagent-role-persist');
  const parent = createConversation({ title: 'parent', projectPath: project.projectPath });
  t.after(() => {
    subagentRuntime.resetForTests();
    setSubagentRunnerForTests(null);
    for (const conversation of getAllConversations()) {
      if (conversation.id === parent.id || conversation.parentConversationId === parent.id) deleteConversation(conversation.id);
    }
    project.cleanup();
  });

  let seenAgentId: string | undefined;
  setSubagentRunnerForTests(async (request, sink) => {
    seenAgentId = request.agentId;
    sink.emit({ type: 'content', content: 'child answer' });
  });
  subagentRuntime.registerParentRun(parent.id);

  const started = JSON.parse(await executeSubagent(
    { action: 'start', description: 'literature note', task: 'Read one paper.' },
    {
      conversationId: parent.id,
      projectPath: project.projectPath,
      delegationDepth: 0,
      agent: { id: 'searcher', role: 'searcher' } as never,
    },
  ));
  assert.equal(started.ok, true);

  // The child runs as the creating role…
  assert.equal(seenAgentId, 'searcher');
  // …and the conversation keeps that identity after the run, not only during it.
  const child = getConversation(started.subagent.conversationId);
  assert.equal(child?.agentId, 'searcher');
  assert.equal(resolveAnsweringAgentId(child!, 'pi'), 'searcher', 'continuing the child must not fall back to the caller');

  const record = JSON.parse(fs.readFileSync(sessionRecordPath(started.subagent.conversationId), 'utf8'));
  assert.equal(record.conversation.agentId, 'searcher', 'the role must be in the persisted session record');
  assert.equal(record.conversation.subagentDepth, 1);
  assert.equal(record.conversation.parentConversationId, parent.id);
});

test('a child created without a calling agent stores no identity and keeps the old fallback', async (t) => {
  const project = createTempProject('subagent-no-role');
  const parent = createConversation({ title: 'parent', projectPath: project.projectPath });
  t.after(() => {
    subagentRuntime.resetForTests();
    setSubagentRunnerForTests(null);
    for (const conversation of getAllConversations()) {
      if (conversation.id === parent.id || conversation.parentConversationId === parent.id) deleteConversation(conversation.id);
    }
    project.cleanup();
  });

  setSubagentRunnerForTests(async (_request, sink) => {
    sink.emit({ type: 'content', content: 'child answer' });
  });
  subagentRuntime.registerParentRun(parent.id);

  const started = JSON.parse(await executeSubagent(
    { action: 'start', description: 'no role', task: 'Do a thing.' },
    { conversationId: parent.id, projectPath: project.projectPath, delegationDepth: 0 },
  ));
  assert.equal(started.ok, true);
  const child = getConversation(started.subagent.conversationId);
  assert.equal(child?.agentId, undefined);
  assert.equal(resolveAnsweringAgentId(child!, 'pi'), 'pi', 'without a recorded role the caller still decides');
});
