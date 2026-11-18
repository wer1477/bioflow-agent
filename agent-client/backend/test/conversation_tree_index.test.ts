import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConversation,
  deleteConversation,
  listChildConversations,
  listDescendantConversations,
} from '../src/agent/config/conversation_service.js';
import { ensureRoleSession } from '../src/agent/team/team_service.js';
import { createTempProject } from './helpers/project_fixture.js';

test('the child index follows creation and deletion without a stale scan', () => {
  const project = createTempProject('child-index');
  const parent = createConversation({ projectPath: project.projectPath, title: 'parent' });
  try {
    assert.deepEqual(listChildConversations(parent.id), []);

    const first = createConversation({
      projectPath: project.projectPath,
      title: 'first',
      parentConversationId: parent.id,
      subagentDepth: 1,
    });
    const second = createConversation({
      projectPath: project.projectPath,
      title: 'second',
      parentConversationId: parent.id,
      subagentDepth: 1,
    });

    // A second read must see both even though the index was built on the first read.
    const ids = listChildConversations(parent.id).map((child) => child.id).sort();
    assert.deepEqual(ids, [first.id, second.id].sort());

    deleteConversation(first.id);
    assert.deepEqual(listChildConversations(parent.id).map((child) => child.id), [second.id]);
  } finally {
    deleteConversation(parent.id);
    project.cleanup();
  }
});

test('the subtree walk spans roles and the subagents below them', () => {
  const project = createTempProject('descendant-tree');
  const root = createConversation({ projectPath: project.projectPath, title: 'team' });
  try {
    const pi = ensureRoleSession(root.id, 'pi');
    const writer = ensureRoleSession(root.id, 'writer');
    const child = createConversation({
      projectPath: project.projectPath,
      title: 'Subagent · probe',
      parentConversationId: pi.id,
      subagentDepth: 1,
    });

    const ids = listDescendantConversations(root.id).map((conversation) => conversation.id).sort();
    assert.deepEqual(ids, [pi.id, writer.id, child.id].sort());

    // The same rule applies one level down: a role session owns only what it delegated.
    assert.deepEqual(listDescendantConversations(pi.id).map((conversation) => conversation.id), [child.id]);
  } finally {
    deleteConversation(root.id);
    project.cleanup();
  }
});
