import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTranscriptRecorder, getTranscriptRoot } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

function startTestServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/conversations', conversationsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server has no port.');
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** One completed run with a tool call, so the blob endpoint has something to serve. */
function recordRun(conversationId: string, runId: string, rawResult: string): void {
  const recorder = createTranscriptRecorder(conversationId, runId);
  assert.ok(recorder);
  recorder.recordModelRequest({
    requestId: 'request-1',
    turnIndex: 1,
    llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
    maxOutputTokens: 1024,
    messages: [{ role: 'user', content: 'run the analysis' }],
    tools: null,
  });
  recorder.recordToolCall({
    requestId: 'request-1',
    turnIndex: 1,
    callId: 'call-1',
    toolName: 'exec_command',
    rawArguments: '{"command":"ls"}',
    parsedArguments: { command: 'ls' },
  });
  recorder.recordToolResult({
    requestId: 'request-1',
    turnIndex: 1,
    callId: 'call-1',
    toolName: 'exec_command',
    rawResult,
    modelVisibleResult: 'visible preview',
  });
  recorder.end('completed');
}

test('GET transcript returns runs and events for a conversation', async () => {
  const server = await startTestServer();
  const project = createTempProject('transcript-routes');
  const conversation = createConversation({ title: 'routes', projectPath: project.projectPath });
  try {
    recordRun(conversation.id, 'run-routes-1', 'complete raw tool output');

    const response = await fetch(`${server.origin}/api/conversations/${conversation.id}/transcript`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      conversationId: string;
      runs: Array<{ runId: string; status: string; eventCount: number }>;
      events: Array<{ type: string; sequence: number }>;
      truncated: boolean;
      tornTail: boolean;
    };
    assert.equal(body.conversationId, conversation.id);
    assert.deepEqual(body.runs.map((run) => [run.runId, run.status]), [['run-routes-1', 'completed']]);
    assert.deepEqual(body.events.map((event) => event.type), [
      'run_start', 'model_request', 'tool_call', 'tool_result', 'run_end',
    ]);
    assert.equal(body.truncated, false);
    assert.equal(body.tornTail, false);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});

test('GET transcript filters by run and by sequence, and reports truncation', async () => {
  const server = await startTestServer();
  const project = createTempProject('transcript-routes-filter');
  const conversation = createConversation({ title: 'routes filter', projectPath: project.projectPath });
  try {
    recordRun(conversation.id, 'run-a', 'a');
    recordRun(conversation.id, 'run-b', 'b');

    const byRun = await fetch(`${server.origin}/api/conversations/${conversation.id}/transcript?runId=run-b`);
    const runBody = await byRun.json() as { events: Array<{ runId: string }> };
    assert.deepEqual(runBody.events.map((event) => event.runId), Array(runBody.events.length).fill('run-b'));

    const limited = await fetch(`${server.origin}/api/conversations/${conversation.id}/transcript?limit=3`);
    const limitedBody = await limited.json() as { events: unknown[]; truncated: boolean };
    assert.equal(limitedBody.events.length, 3);
    assert.equal(limitedBody.truncated, true);

    const after = await fetch(`${server.origin}/api/conversations/${conversation.id}/transcript?afterSequence=8`);
    const afterBody = await after.json() as { events: Array<{ sequence: number }> };
    assert.ok(afterBody.events.every((event) => event.sequence > 8));
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});

test('GET transcript reports 404 for an unknown conversation or run', async () => {
  const server = await startTestServer();
  const project = createTempProject('transcript-routes-404');
  const conversation = createConversation({ title: 'routes 404', projectPath: project.projectPath });
  try {
    recordRun(conversation.id, 'run-known', 'x');

    const missingConversation = await fetch(`${server.origin}/api/conversations/does-not-exist/transcript`);
    assert.equal(missingConversation.status, 404);

    const missingRun = await fetch(`${server.origin}/api/conversations/${conversation.id}/transcript?runId=run-absent`);
    assert.equal(missingRun.status, 404);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});

test('GET transcript blob serves the complete result the model only previewed', async () => {
  const server = await startTestServer();
  const project = createTempProject('transcript-routes-blob');
  const conversation = createConversation({ title: 'routes blob', projectPath: project.projectPath });
  try {
    const rawResult = 'complete raw tool output that the model never saw in full';
    recordRun(conversation.id, 'run-blob', rawResult);

    const transcript = await fetch(`${server.origin}/api/conversations/${conversation.id}/transcript`);
    const body = await transcript.json() as { events: Array<{ type: string; data: Record<string, unknown> }> };
    const toolResult = body.events.find((event) => event.type === 'tool_result');
    const ref = (toolResult?.data.rawResult as { path: string }).path;

    const response = await fetch(
      `${server.origin}/api/conversations/${conversation.id}/transcript/blob?ref=${encodeURIComponent(ref)}`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), rawResult);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});

test('GET transcript blob rejects traversal and malformed references', async () => {
  const server = await startTestServer();
  const project = createTempProject('transcript-routes-blob-guard');
  const conversation = createConversation({ title: 'routes blob guard', projectPath: project.projectPath });
  try {
    recordRun(conversation.id, 'run-guard', 'x');
    // A file that exists inside the session directory but is not a blob.
    const sessionFile = path.join(getTranscriptRoot(conversation.id), 'manifest.json');
    assert.ok(fs.existsSync(sessionFile));

    const cases = [
      '', // missing
      '../manifest.json',
      'manifest.json',
      'blobs/sha256-not-a-digest.txt',
      '/etc/passwd',
    ];
    for (const ref of cases) {
      const response = await fetch(
        `${server.origin}/api/conversations/${conversation.id}/transcript/blob?ref=${encodeURIComponent(ref)}`,
      );
      assert.equal(response.status, ref === '' ? 400 : 400, `ref=${ref} should be rejected`);
    }

    // A well-formed reference to a blob that was never written is a 404, not a 400.
    const absent = await fetch(
      `${server.origin}/api/conversations/${conversation.id}/transcript/blob?ref=blobs/sha256-${'a'.repeat(64)}.txt`,
    );
    assert.equal(absent.status, 404);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});
