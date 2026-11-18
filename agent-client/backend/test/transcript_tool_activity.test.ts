import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { readTranscript } from '../src/agent/transcript_reader.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

function readToolResult(conversationId: string): Record<string, unknown> {
  const event = readTranscript(conversationId).events.find((candidate) => candidate.type === 'tool_result');
  assert.ok(event, 'expected a tool_result record');
  return event.data;
}

test('a tool result records execution time, outcome and produced files', () => {
  const project = createTempProject('transcript-tool-activity');
  const conversation = createConversation({ title: 'tool activity', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-tool');
    assert.ok(recorder);
    recorder.recordToolCall({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'exec_command',
      rawArguments: '{"command":"make plot"}',
      parsedArguments: { command: 'make plot' },
    });
    recorder.recordToolResult({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'exec_command',
      rawResult: '{"ok":true,"exit_code":0}',
      modelVisibleResult: '{"ok":true,"exit_code":0}',
      durationMs: 1234,
      isError: false,
      producedFiles: ['/projects/p1/Result/plot.png'],
    });
    recorder.end('completed');

    const result = readToolResult(conversation.id);
    assert.equal(result.durationMs, 1234);
    assert.equal(result.isError, false);
    assert.deepEqual(result.producedFiles, ['/projects/p1/Result/plot.png']);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a tool call that never executed records no execution facts', () => {
  const project = createTempProject('transcript-tool-denied');
  const conversation = createConversation({ title: 'tool denied', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-denied');
    assert.ok(recorder);
    recorder.recordToolCall({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'write_file',
      rawArguments: '{"path":"out.txt"}',
      parsedArguments: { path: 'out.txt' },
    });
    // A denied approval produces a result without executing anything: the absence of
    // timing is what tells a reader the tool never ran.
    recorder.recordToolResult({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'write_file',
      rawResult: '{"ok":false,"error":"Operation was not approved by the user."}',
      modelVisibleResult: '{"ok":false,"error":"Operation was not approved by the user."}',
      isError: true,
    });
    recorder.end('completed');

    const result = readToolResult(conversation.id);
    assert.equal('durationMs' in result, false);
    assert.equal('producedFiles' in result, false);
    assert.equal(result.isError, true);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
