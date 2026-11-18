import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { readTranscriptRecords } from '../src/agent/transcript_reader.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

test('run_start records the agent, role and lineage of the run', () => {
  const project = createTempProject('run-identity');
  const conversation = createConversation({ projectPath: project.projectPath, title: 'identity' });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-child', {
      agentId: 'pi',
      roleId: 'pi',
      parentConversationId: 'parent-conversation',
      parentRunId: 'parent-run',
      delegationDepth: 1,
    });
    assert.ok(recorder);
    recorder.end('completed');

    const { records } = readTranscriptRecords(conversation.id);
    assert.equal(records[0]?.type, 'run_start');
    assert.deepEqual(records[0]?.data, {
      transcriptVersion: 1,
      agentId: 'pi',
      roleId: 'pi',
      parentConversationId: 'parent-conversation',
      parentRunId: 'parent-run',
      delegationDepth: 1,
    });
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a run without identity keeps the minimal run_start record', () => {
  const project = createTempProject('run-identity-empty');
  const conversation = createConversation({ projectPath: project.projectPath, title: 'identity' });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-plain');
    assert.ok(recorder);
    const { records } = readTranscriptRecords(conversation.id);
    assert.deepEqual(records[0]?.data, { transcriptVersion: 1 });
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
