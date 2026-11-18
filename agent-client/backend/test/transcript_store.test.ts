import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { compactRecord } from '../src/agent/config/conversation_file_store.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';
import {
  createTranscriptRecorder,
  getTranscriptEventsPath,
  getTranscriptRoot,
  type TranscriptEvent,
} from '../src/agent/transcript_store.js';

function readEvents(conversationId: string): TranscriptEvent[] {
  return fs.readFileSync(getTranscriptEventsPath(conversationId), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEvent);
}

test('transcript records exact model-visible requests and tool-result text in an append-only log', () => {
  const project = createTempProject('transcript');
  const conversation = createConversation({ title: 'transcript test', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-transcript-1');
    assert.ok(recorder);
    recorder.recordModelRequest({
      requestId: 'request-1',
      turnIndex: 1,
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model', thinkingLevel: 'high' },
      maxOutputTokens: 4096,
      messages: [
        { role: 'system', content: 'exact rendered system prompt' },
        { role: 'user', content: 'what does the model see?' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup a source.',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      }],
    });
    recorder.recordModelChunk('request-1', { choices: [{ delta: { content: 'checking' } }] });
    recorder.recordModelResponse({
      requestId: 'request-1',
      turnIndex: 1,
      content: 'checking',
      toolCalls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"id":"PMID:1"}' } }],
      finishReason: 'tool_calls',
    });
    recorder.recordToolCall({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'lookup',
      rawArguments: '{"id":"PMID:1"}',
      parsedArguments: { id: 'PMID:1' },
    });
    recorder.recordToolResult({
      requestId: 'request-1',
      turnIndex: 1,
      callId: 'call-1',
      toolName: 'lookup',
      rawResult: 'complete raw source result',
      modelVisibleResult: 'exact tool text returned to the model',
    });
    recorder.end('completed');

    const events = readEvents(conversation.id);
    assert.deepEqual(events.map((event) => event.type), [
      'run_start', 'model_request', 'model_chunk', 'model_response', 'tool_call', 'tool_result', 'run_end',
    ]);
    assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(events[1]?.data, {
      turnIndex: 1,
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model', thinkingLevel: 'high' },
      maxOutputTokens: 4096,
      messages: [
        { role: 'system', content: 'exact rendered system prompt' },
        { role: 'user', content: 'what does the model see?' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup a source.',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      }],
    });
    assert.equal(events[4]?.data.rawArguments, '{"id":"PMID:1"}');
    assert.equal(events[5]?.data.modelVisibleResult, 'exact tool text returned to the model');

    const rawResult = events[5]?.data.rawResult as { path: string };
    assert.equal(fs.readFileSync(path.join(getTranscriptRoot(conversation.id), rawResult.path), 'utf8'), 'complete raw source result');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('conversation history compaction never rewrites the transcript', () => {
  const project = createTempProject('transcript-compaction');
  const conversation = createConversation({ title: 'transcript compaction test', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-transcript-2');
    assert.ok(recorder);
    recorder.recordModelRequest({
      requestId: 'request-2',
      turnIndex: 1,
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
      maxOutputTokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
      tools: null,
    });
    recorder.end('completed');
    const before = fs.readFileSync(getTranscriptEventsPath(conversation.id), 'utf8');

    compactRecord(conversation.id);

    assert.equal(fs.readFileSync(getTranscriptEventsPath(conversation.id), 'utf8'), before);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('model request transcripts store a placeholder instead of base64 image data', () => {
  const project = createTempProject('transcript-images');
  const conversation = createConversation({ title: 'transcript images', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-images');
    assert.ok(recorder);
    const base64 = 'A'.repeat(10_000);
    recorder.recordModelRequest({
      requestId: 'request-image',
      turnIndex: 1,
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
      maxOutputTokens: 1024,
      messages: [{
        role: 'tool',
        tool_call_id: 'call_1',
        content: [
          { type: 'text', text: 'image attached' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
      tools: null,
    });
    const stored = fs.readFileSync(getTranscriptEventsPath(conversation.id), 'utf8');
    assert.ok(!stored.includes(base64), 'base64 must not be stored in the transcript');
    assert.match(stored, /image omitted from stored transcript/);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
