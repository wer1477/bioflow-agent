import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  createConversation,
  createMessage,
  deleteConversation,
  getMessage,
  updateMessage,
} from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';

test('streaming message updates touch only the owning conversation record', () => {
  const project = createTempProject('perf');
  const conversation = createConversation({ title: 'streaming update performance test', projectPath: project.projectPath });
  const message = createMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    toolCalls: null,
  });
  const originalReadDirectory = fs.readdirSync;
  const originalStructuredClone = globalThis.structuredClone;
  let directoryReads = 0;
  let cloneCalls = 0;

  fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
    directoryReads += 1;
    return originalReadDirectory(...args);
  }) as typeof fs.readdirSync;
  globalThis.structuredClone = ((value: unknown) => {
    cloneCalls += 1;
    return originalStructuredClone(value);
  }) as typeof structuredClone;

  try {
    try {
      const updated = updateMessage(conversation.id, message.id, { content: 'first streamed chunk' });
      assert.equal(updated?.content, 'first streamed chunk');
      assert.equal(directoryReads, 0, 'a stream tick must not enumerate all conversation directories');
      assert.equal(cloneCalls, 0, 'a stream tick must not clone the complete conversation record');
    } finally {
      fs.readdirSync = originalReadDirectory;
      globalThis.structuredClone = originalStructuredClone;
    }
    assert.equal(getMessage(conversation.id, message.id)?.content, 'first streamed chunk');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
