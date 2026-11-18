import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getHistoryPath } from '../src/agent/config/conversation_file_store.js';
import { createConversation, createMessage, deleteConversation, updateMessage } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';
import { createAgentRun, createAgentRunStep, updateAgentRunStep } from '../src/agent/config/run_store.js';

test('run-step updates address their known conversation without enumerating all sessions', () => {
  const project = createTempProject('runsteps');
  const conversation = createConversation({ title: 'run-step direct lookup test', projectPath: project.projectPath });
  try {
    const run = createAgentRun({ conversationId: conversation.id });
    const step = createAgentRunStep({ conversationId: conversation.id, runId: run.id, kind: 'tool_call', title: 'Tool: test' });
    const originalReadDirectory = fs.readdirSync;
    let directoryReads = 0;
    fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
      directoryReads += 1;
      return originalReadDirectory(...args);
    }) as typeof fs.readdirSync;
    try {
      const updated = updateAgentRunStep(conversation.id, step.id, { status: 'completed' });
      assert.equal(updated?.status, 'completed');
      assert.equal(directoryReads, 0);
    } finally {
      fs.readdirSync = originalReadDirectory;
    }
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('patch logs compact during a long-running stream instead of waiting for terminal completion', () => {
  const project = createTempProject('compaction');
  const conversation = createConversation({ title: 'in-run compaction test', projectPath: project.projectPath });
  try {
    const message = createMessage({ conversationId: conversation.id, role: 'assistant', content: '', toolCalls: null });
    for (let index = 1; index < 500; index += 1) {
      updateMessage(conversation.id, message.id, { content: `stream chunk ${index}` });
    }
    const lines = fs.readFileSync(getHistoryPath(conversation.id), 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'the 500th patch is replaced by a snapshot before the run ends');
    assert.equal(JSON.parse(lines[0]).type, 'snapshot');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
