import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { readTranscript } from '../src/agent/transcript_reader.js';
import { TranscriptLogError } from '../src/agent/transcript_log.js';
import { createTranscriptRecorder, getTranscriptEventsPath } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

function line(sequence: number, type: string, data: Record<string, unknown> = {}, runId = 'run-1'): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    createdAt: '2026-10-01T00:00:00.000Z',
    conversationId: 'conversation-1',
    runId,
    type,
    data,
  })}\n`;
}

test('an interrupted tail is discarded and the next run continues the sequence', () => {
  const project = createTempProject('transcript-recovery-torn');
  const conversation = createConversation({ title: 'torn recovery', projectPath: project.projectPath });
  try {
    const first = createTranscriptRecorder(conversation.id, 'run-first');
    assert.ok(first);
    first.end('completed');

    const eventsPath = getTranscriptEventsPath(conversation.id);
    const text = fs.readFileSync(eventsPath, 'utf8');
    fs.writeFileSync(eventsPath, text.slice(0, text.length - 12));

    // The old reader threw here, and the throw escaped the chat generator, so the run
    // recorded nothing at all. A second run must now open cleanly.
    const second = createTranscriptRecorder(conversation.id, 'run-second');
    assert.ok(second);
    second.end('completed');

    const result = readTranscript(conversation.id);
    assert.equal(result.tornTail, false, 'the torn tail must have been repaired, not merely skipped');
    assert.deepEqual(result.events.map((event) => event.sequence), [0, 1, 2]);
    assert.deepEqual(result.events.map((event) => event.type), ['run_start', 'run_start', 'run_end']);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a complete record that lost its newline is kept and terminated', () => {
  const project = createTempProject('transcript-recovery-newline');
  const conversation = createConversation({ title: 'newline recovery', projectPath: project.projectPath });
  try {
    const first = createTranscriptRecorder(conversation.id, 'run-first');
    assert.ok(first);
    first.end('completed');

    const eventsPath = getTranscriptEventsPath(conversation.id);
    const text = fs.readFileSync(eventsPath, 'utf8');
    fs.writeFileSync(eventsPath, text.slice(0, -1)); // drop only the final newline

    const second = createTranscriptRecorder(conversation.id, 'run-second');
    assert.ok(second);
    second.end('completed');

    const result = readTranscript(conversation.id);
    assert.equal(result.tornTail, false);
    // The unterminated record survives, and the next append starts on its own line.
    assert.deepEqual(result.events.map((event) => event.sequence), [0, 1, 2, 3]);
    assert.deepEqual(
      result.events.map((event) => [event.runId, event.type]),
      [['run-first', 'run_start'], ['run-first', 'run_end'], ['run-second', 'run_start'], ['run-second', 'run_end']],
    );
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('an inconsistent committed prefix refuses to be appended to', () => {
  const project = createTempProject('transcript-recovery-gap');
  const conversation = createConversation({ title: 'gap recovery', projectPath: project.projectPath });
  try {
    // A gap means records are missing. Renumbering here is what produced duplicate
    // sequence numbers that nothing downstream could detect, so it must fail instead.
    const eventsPath = getTranscriptEventsPath(conversation.id);
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.writeFileSync(eventsPath, line(0, 'run_start') + line(2, 'run_end'));

    assert.throws(() => createTranscriptRecorder(conversation.id, 'run-after-gap'), TranscriptLogError);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
