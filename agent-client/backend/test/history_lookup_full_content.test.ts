import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createConversation, deleteConversation, getMessages } from '../src/agent/config/conversation_service.js';
import { lookupConversationHistory } from '../src/agent/config/context_store.js';
import { PersistedRunState } from '../src/agent/service/agent_service.js';
import { createTranscriptRecorder, getTranscriptRoot } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

const FULL_RESULT = `{"ok":true,"rows":[${Array.from({ length: 2_000 }, (_, index) => `"row-${index}"`).join(',')}]}`;

/** Record one run with a single oversized tool result, through the real persistence path. */
function recordLongToolResult(conversationId: string): string {
  const runState = new PersistedRunState({ conversationId, agentId: 'pi', agentRole: 'pi' });
  const runId = runState.runId;
  assert.ok(runId);
  const transcript = createTranscriptRecorder(conversationId, runId);
  assert.ok(transcript);
  runState.attachTranscript(transcript);

  const observation = { observationId: 'obs-long', mode: 'file', sizeChars: FULL_RESULT.length, artifact: null };
  transcript.recordToolCall({
    requestId: 'request-1',
    turnIndex: 0,
    callId: 'call-1',
    toolName: 'read_file',
    rawArguments: '{"path":"matrix.tsv"}',
    parsedArguments: { path: 'matrix.tsv' },
  });
  runState.applyRuntimeEvent({
    type: 'tool_call_start',
    tool_name: 'read_file',
    arguments: { path: 'matrix.tsv' },
    turnIndex: 0,
    planStepIndex: null,
  });
  transcript.recordToolResult({
    requestId: 'request-1',
    turnIndex: 0,
    callId: 'call-1',
    toolName: 'read_file',
    rawResult: FULL_RESULT,
    // What the model actually saw is a truncated view, not the stored bytes.
    modelVisibleResult: '{"ok":true,"rows":["row-0", …]} [truncated]',
    observation,
  });
  runState.applyRuntimeEvent({
    type: 'tool_call_result',
    tool_name: 'read_file',
    result: '{"ok":true,"rows":["row-0", …]} [truncated]',
    observation,
    turnIndex: 0,
    planStepIndex: null,
  });
  runState.persist('running');
  return runId;
}

function toolResultEvent(conversationId: string): Record<string, unknown> {
  const events = getMessages(conversationId).find((message) => message.toolCalls?.run)?.toolCalls?.run?.events as
    | Array<Record<string, unknown>>
    | undefined;
  assert.ok(events, 'expected the read path to attach run events');
  const event = events.find((entry) => entry.type === 'tool_call_result');
  assert.ok(event);
  return event;
}

test('a rebuilt tool result carries the blob reference, not the content', () => {
  const project = createTempProject('history-lookup-blob');
  const conversation = createConversation({ title: 'history lookup', projectPath: project.projectPath });
  try {
    recordLongToolResult(conversation.id);

    const event = toolResultEvent(conversation.id);
    assert.match(String(event.rawResult), /^blobs\/sha256-[0-9a-f]{64}\.txt$/);
    // The event itself stays small: the model-visible text is the preview, not the blob.
    assert.equal(String(event.result).length < FULL_RESULT.length, true);
    assert.equal(JSON.stringify(event).includes('row-1999'), false);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('includeFullContent returns the exact stored result from the transcript blob', () => {
  const project = createTempProject('history-lookup-full');
  const conversation = createConversation({ title: 'history lookup', projectPath: project.projectPath });
  try {
    recordLongToolResult(conversation.id);

    const items = lookupConversationHistory(conversation.id, getMessages(conversation.id), {
      types: ['tool_result'],
      includeFullContent: true,
      limit: 5,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].content, FULL_RESULT);
    // Without the flag the item stays a preview, so the default path cannot blow up a turn.
    const previews = lookupConversationHistory(conversation.id, getMessages(conversation.id), {
      types: ['tool_result'],
      limit: 5,
    });
    assert.equal(previews.length, 1);
    assert.equal('content' in previews[0], false);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('an unreadable blob degrades to the event instead of failing the lookup', () => {
  const project = createTempProject('history-lookup-missing-blob');
  const conversation = createConversation({ title: 'history lookup', projectPath: project.projectPath });
  try {
    recordLongToolResult(conversation.id);
    const event = toolResultEvent(conversation.id);
    const blobPath = String(event.rawResult);

    // Remove the blob behind the reader's back.
    fs.rmSync(`${getTranscriptRoot(conversation.id)}/${blobPath}`, { force: true });

    const items = lookupConversationHistory(conversation.id, getMessages(conversation.id), {
      types: ['tool_result'],
      includeFullContent: true,
      limit: 5,
    });
    assert.equal(items.length, 1);
    assert.equal(typeof items[0].content, 'object');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
