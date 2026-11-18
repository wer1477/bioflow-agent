import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { readTranscript } from '../src/agent/transcript_reader.js';
import { createTranscriptRecorder, getTranscriptEventsPath } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

function request(recorder: NonNullable<ReturnType<typeof createTranscriptRecorder>>): void {
  recorder.recordModelRequest({
    requestId: 'request-1',
    turnIndex: 1,
    llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
    maxOutputTokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    tools: null,
  });
}

test('stream chunks are buffered and land with the next durable boundary', () => {
  const project = createTempProject('transcript-buffering');
  const conversation = createConversation({ title: 'buffering', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-buffer');
    assert.ok(recorder);
    request(recorder);
    const eventsPath = getTranscriptEventsPath(conversation.id);
    const afterRequest = fs.readFileSync(eventsPath, 'utf8');

    recorder.recordModelChunk('request-1', { choices: [{ delta: { content: 'a' } }] });
    recorder.recordModelChunk('request-1', { choices: [{ delta: { content: 'b' } }] });
    // Chunks are diagnostic: they must not cost a syscall each, and they must not
    // reach the log ahead of the record that describes what the model actually said.
    assert.equal(fs.readFileSync(eventsPath, 'utf8'), afterRequest);

    recorder.recordModelResponse({ requestId: 'request-1', turnIndex: 1, content: 'ab', toolCalls: [], finishReason: 'stop' });

    const result = readTranscript(conversation.id);
    assert.deepEqual(result.events.map((event) => event.type), [
      'run_start', 'model_request', 'model_chunk', 'model_chunk', 'model_response',
    ]);
    assert.deepEqual(result.events.map((event) => event.sequence), [0, 1, 2, 3, 4]);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('ending a run settles chunks that never reached a response boundary', () => {
  const project = createTempProject('transcript-buffering-end');
  const conversation = createConversation({ title: 'buffering end', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-buffer-end');
    assert.ok(recorder);
    request(recorder);
    recorder.recordModelChunk('request-1', { choices: [{ delta: { content: 'partial' } }] });
    // A cancelled or failed run still owes the log everything it produced.
    recorder.end('cancelled');

    const result = readTranscript(conversation.id);
    assert.deepEqual(result.events.map((event) => event.type), [
      'run_start', 'model_request', 'model_chunk', 'run_end',
    ]);
    assert.deepEqual(result.events.map((event) => event.sequence), [0, 1, 2, 3]);
    assert.equal(result.runs[0]?.status, 'cancelled');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
