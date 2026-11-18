import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConversation,
  createMessage,
  deleteConversation,
  getAllConversations,
  updateMessage,
} from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';

test('streaming updates do not reorder unpinned conversations', () => {
  const project = createTempProject('order');
  const first = createConversation({ title: 'first conversation', projectPath: project.projectPath });
  const second = createConversation({ title: 'second conversation', projectPath: project.projectPath });
  const firstMessage = createMessage({
    conversationId: first.id,
    role: 'assistant',
    content: '',
    toolCalls: null,
  });

  try {
    updateMessage(first.id, firstMessage.id, { content: 'a later streaming update' });
    const ids = getAllConversations()
      .filter((conversation) => conversation.id === first.id || conversation.id === second.id)
      .map((conversation) => conversation.id);

    assert.deepEqual(ids, [second.id, first.id]);
  } finally {
    deleteConversation(first.id);
    deleteConversation(second.id);
    project.cleanup();
  }
});
