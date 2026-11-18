import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import {
  assertContiguousSequences,
  foldRuns,
  parseTranscriptText,
  readTranscript,
  resolveTranscriptBlobPath,
  toAgentEvents,
  TranscriptLogError,
} from '../src/agent/transcript_reader.js';
import { createTranscriptRecorder, getTranscriptEventsPath, getTranscriptRoot } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

/** Build one stored line exactly as the writer would. */
function line(
  sequence: number,
  type: string,
  data: Record<string, unknown> = {},
  options: { runId?: string; createdAt?: string } = {},
): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    createdAt: options.createdAt ?? '2026-10-01T00:00:00.000Z',
    conversationId: 'conversation-1',
    runId: options.runId ?? 'run-1',
    type,
    data,
  })}\n`;
}

// ---------------------------------------------------------------------------
// Pure line parsing: every crash shape must be testable without the filesystem.
// ---------------------------------------------------------------------------

test('parseTranscriptText reads a well-formed log', () => {
  const parsed = parseTranscriptText(line(0, 'run_start') + line(1, 'run_end', { status: 'completed' }));
  assert.equal(parsed.tornTail, false);
  assert.deepEqual(parsed.events.map((event) => event.sequence), [0, 1]);
  assert.deepEqual(parsed.events.map((event) => event.type), ['run_start', 'run_end']);
});

test('parseTranscriptText drops an unusable final line instead of throwing', () => {
  const parsed = parseTranscriptText(`${line(0, 'run_start')}{"schemaVersion":1,"eventId":"torn","seq`);
  assert.equal(parsed.tornTail, true);
  assert.deepEqual(parsed.events.map((event) => event.sequence), [0]);
});

test('parseTranscriptText keeps an unterminated final line that is still a complete record', () => {
  // A crash between the record bytes and the trailing newline must not cost us the record.
  const parsed = parseTranscriptText(`${line(0, 'run_start')}{"schemaVersion":1,"eventId":"e1","sequence":1,"createdAt":"2026-10-01T00:00:01.000Z","conversationId":"conversation-1","runId":"run-1","type":"run_end","data":{"status":"completed"}}`);
  assert.equal(parsed.tornTail, false);
  assert.deepEqual(parsed.events.map((event) => event.sequence), [0, 1]);
});

test('parseTranscriptText refuses a damaged interior record', () => {
  // Damage inside the committed prefix is corruption: skipping it would silently
  // hand back a history with a hole in it.
  assert.throws(
    () => parseTranscriptText(`${line(0, 'run_start')}{not json}\n${line(2, 'run_end')}`),
    TranscriptLogError,
  );
});

test('parseTranscriptText tolerates an empty log', () => {
  assert.deepEqual(parseTranscriptText(''), { events: [], tornTail: false });
  assert.deepEqual(parseTranscriptText('\n'), { events: [], tornTail: false });
});

// ---------------------------------------------------------------------------
// Sequence integrity
// ---------------------------------------------------------------------------

test('assertContiguousSequences accepts a contiguous log', () => {
  const events = parseTranscriptText(line(0, 'run_start') + line(1, 'run_end')).events;
  assert.doesNotThrow(() => assertContiguousSequences(events));
});

test('assertContiguousSequences rejects a gap', () => {
  const events = parseTranscriptText(line(0, 'run_start') + line(2, 'run_end')).events;
  assert.throws(() => assertContiguousSequences(events), TranscriptLogError);
});

test('assertContiguousSequences rejects a repeated sequence number', () => {
  // The historical reader returned -1 when it could not read the last sequence and
  // restarted numbering at 0, so duplicates could exist with nothing to detect them.
  const events = parseTranscriptText(line(0, 'run_start') + line(0, 'run_end')).events;
  assert.throws(() => assertContiguousSequences(events), TranscriptLogError);
});

// ---------------------------------------------------------------------------
// Run folding
// ---------------------------------------------------------------------------

test('foldRuns reports an open run when run_end never landed', () => {
  const events = parseTranscriptText(line(0, 'run_start') + line(1, 'model_request')).events;
  const runs = foldRuns(events);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, 'open');
  assert.equal(runs[0]?.endedAt, null);
  assert.equal(runs[0]?.eventCount, 2);
});

test('foldRuns reads the terminal status and groups by run', () => {
  const text = line(0, 'run_start', {}, { runId: 'run-a' })
    + line(1, 'run_end', { status: 'cancelled' }, { runId: 'run-a' })
    + line(2, 'run_start', {}, { runId: 'run-b' })
    + line(3, 'run_end', { status: 'failed', error: 'boom' }, { runId: 'run-b' });
  const runs = foldRuns(parseTranscriptText(text).events);
  assert.deepEqual(runs.map((run) => [run.runId, run.status]), [['run-a', 'cancelled'], ['run-b', 'failed']]);
});

// ---------------------------------------------------------------------------
// Filesystem-backed reads
// ---------------------------------------------------------------------------

test('readTranscript returns an empty transcript for a conversation that never ran', () => {
  const project = createTempProject('transcript-reader-empty');
  const conversation = createConversation({ title: 'empty', projectPath: project.projectPath });
  try {
    const result = readTranscript(conversation.id);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.runs, []);
    assert.equal(result.truncated, false);
    assert.equal(result.tornTail, false);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('readTranscript reads back a recorded run end to end', () => {
  const project = createTempProject('transcript-reader-run');
  const conversation = createConversation({ title: 'reader', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-reader-1');
    assert.ok(recorder);
    recorder.recordModelRequest({
      requestId: 'request-1',
      turnIndex: 1,
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
      maxOutputTokens: 1024,
      messages: [{ role: 'user', content: 'what does the model see?' }],
      tools: null,
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
      modelVisibleResult: 'visible result',
    });
    recorder.end('completed');

    const result = readTranscript(conversation.id);
    assert.deepEqual(result.events.map((event) => event.type), [
      'run_start', 'model_request', 'tool_call', 'tool_result', 'run_end',
    ]);
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0]?.status, 'completed');
    assert.equal(result.runs[0]?.endedAt, result.events.at(-1)?.createdAt);

    // The request body is the exact model-visible payload, not a summary.
    const request = result.events[1]?.data as { messages: unknown[]; tools: unknown };
    assert.deepEqual(request.messages, [{ role: 'user', content: 'what does the model see?' }]);
    assert.equal(request.tools, null);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('readTranscript filters by run, sequence and limit', () => {
  const project = createTempProject('transcript-reader-filter');
  const conversation = createConversation({ title: 'filter', projectPath: project.projectPath });
  try {
    const first = createTranscriptRecorder(conversation.id, 'run-filter-1');
    assert.ok(first);
    first.end('completed');
    const second = createTranscriptRecorder(conversation.id, 'run-filter-2');
    assert.ok(second);
    second.end('completed');

    assert.equal(readTranscript(conversation.id).events.length, 4);
    assert.deepEqual(
      readTranscript(conversation.id, { runId: 'run-filter-2' }).events.map((event) => event.runId),
      ['run-filter-2', 'run-filter-2'],
    );
    assert.deepEqual(
      readTranscript(conversation.id, { afterSequence: 1 }).events.map((event) => event.sequence),
      [2, 3],
    );
    const limited = readTranscript(conversation.id, { limit: 3 });
    assert.equal(limited.events.length, 3);
    assert.equal(limited.truncated, true);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('readTranscript reports an interrupted tail without repairing the file', () => {
  const project = createTempProject('transcript-reader-torn');
  const conversation = createConversation({ title: 'torn', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-torn-1');
    assert.ok(recorder);
    recorder.end('completed');

    const eventsPath = getTranscriptEventsPath(conversation.id);
    const text = fs.readFileSync(eventsPath, 'utf8');
    fs.writeFileSync(eventsPath, text.slice(0, text.length - 12));
    const damaged = fs.readFileSync(eventsPath, 'utf8');

    const result = readTranscript(conversation.id);
    assert.equal(result.tornTail, true);
    assert.deepEqual(result.events.map((event) => event.type), ['run_start']);
    assert.equal(result.runs[0]?.status, 'open');
    // The read path never repairs storage; a write handle owns that.
    assert.equal(fs.readFileSync(eventsPath, 'utf8'), damaged);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Blob references arrive from the network and must not escape the conversation.
// ---------------------------------------------------------------------------

test('resolveTranscriptBlobPath accepts a real reference and rejects escapes', () => {
  const project = createTempProject('transcript-reader-blob');
  const conversation = createConversation({ title: 'blob', projectPath: project.projectPath });
  try {
    const digest = 'a'.repeat(64);
    const resolved = resolveTranscriptBlobPath(conversation.id, `blobs/sha256-${digest}.txt`);
    assert.equal(resolved, `${getTranscriptRoot(conversation.id)}/blobs/sha256-${digest}.txt`);

    assert.throws(() => resolveTranscriptBlobPath(conversation.id, '../session.json'), TranscriptLogError);
    assert.throws(() => resolveTranscriptBlobPath(conversation.id, 'blobs/sha256-nope.txt'), TranscriptLogError);
    assert.throws(() => resolveTranscriptBlobPath(conversation.id, `/etc/passwd`), TranscriptLogError);
    assert.throws(() => resolveTranscriptBlobPath(conversation.id, `blobs/../blobs/sha256-${digest}.txt`), TranscriptLogError);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Reasoning: the raw provider chunks are the only place it was ever stored, so the
// read side is what makes it visible — for runs recorded before it became a stream event.
// ---------------------------------------------------------------------------

/** One stored `model_chunk` line carrying a provider delta, as the writer would. */
function chunkLine(sequence: number, delta: Record<string, unknown>, requestId: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    createdAt: '2026-10-01T00:00:00.000Z',
    conversationId: 'conversation-1',
    runId: 'run-1',
    requestId,
    type: 'model_chunk',
    data: { chunk: { choices: [{ delta }] } },
  })}\n`;
}

test('reasoning deltas are concatenated into one event per request', () => {
  const text = [
    line(0, 'run_start'),
    chunkLine(1, { reasoning_content: 'first ' }, 'req-1'),
    chunkLine(2, { reasoning_content: 'thought' }, 'req-1'),
    line(3, 'model_response', { turnIndex: 0, content: 'answer', toolCalls: [], finishReason: 'stop' }, { runId: 'run-1' }),
    line(4, 'run_end', { status: 'completed' }),
  ].join('');

  assert.deepEqual(toAgentEvents(parseTranscriptText(text).events), [
    { type: 'thinking', content: 'first thought' },
    { type: 'info', content: 'answer' },
  ]);
});

test('each request contributes its own reasoning event, ahead of its answer', () => {
  const text = [
    line(0, 'run_start'),
    chunkLine(1, { reasoning_content: 'turn one' }, 'req-1'),
    line(2, 'model_response', { turnIndex: 0, content: '', toolCalls: [], finishReason: 'tool_calls' }),
    line(3, 'tool_call', { turnIndex: 0, callId: 'call-1', toolName: 'lookup', parsedArguments: {} }),
    chunkLine(4, { reasoning_content: 'turn two' }, 'req-2'),
    line(5, 'model_response', { turnIndex: 1, content: 'done', toolCalls: [], finishReason: 'stop' }),
  ].join('');

  assert.deepEqual(toAgentEvents(parseTranscriptText(text).events).map((event) => event.type), [
    'thinking', 'tool_call_start', 'thinking', 'info',
  ]);
});

test('the plain reasoning alias is recognized and other spellings are not guessed at', () => {
  const aliased = [
    line(0, 'run_start'),
    chunkLine(1, { reasoning: 'alias text' }, 'req-1'),
    line(2, 'model_response', { turnIndex: 0, content: 'answer', toolCalls: [], finishReason: 'stop' }),
  ].join('');
  assert.deepEqual(toAgentEvents(parseTranscriptText(aliased).events), [
    { type: 'thinking', content: 'alias text' },
    { type: 'info', content: 'answer' },
  ]);

  const unknown = [
    line(0, 'run_start'),
    chunkLine(1, { chain_of_thought: 'not recognized' }, 'req-1'),
    line(2, 'model_response', { turnIndex: 0, content: 'answer', toolCalls: [], finishReason: 'stop' }),
  ].join('');
  assert.deepEqual(toAgentEvents(parseTranscriptText(unknown).events), [
    { type: 'info', content: 'answer' },
  ]);
});

test('a response without reasoning adds no thinking event', () => {
  const text = [
    line(0, 'run_start'),
    chunkLine(1, { reasoning_content: '' }, 'req-1'),
    chunkLine(2, { content: 'answer' }, 'req-1'),
    line(3, 'model_response', { turnIndex: 0, content: 'answer', toolCalls: [], finishReason: 'stop' }),
  ].join('');

  assert.deepEqual(toAgentEvents(parseTranscriptText(text).events), [
    { type: 'info', content: 'answer' },
  ]);
});
