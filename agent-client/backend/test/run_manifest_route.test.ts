import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createAgentRun, updateAgentRun } from '../src/agent/config/run_store.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import { finalizeRunManifest } from '../src/agent/provenance/run_manifest.js';
import type { EnvironmentSnapshot } from '../src/agent/provenance/environment_snapshot.js';
import { createTempProject } from './helpers/project_fixture.js';

const ENVIRONMENT: EnvironmentSnapshot = {
  schemaVersion: 1,
  capturedAt: '2026-11-05T00:00:00.000Z',
  host: 'test-host',
  platform: 'linux-x64',
  node: 'v22.12.0',
  code: { repositoryRoot: '/repo', available: true, commit: 'feedface', branch: 'main', dirty: false },
  python: null,
  r: null,
  warnings: [],
};

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

test('serves the run manifest as JSON and as a Markdown reproducibility card', async () => {
  const server = await startTestServer();
  const project = createTempProject('run-manifest-route');
  const conversation = createConversation({ title: 'manifest-route', projectPath: project.projectPath });
  try {
    const run = createAgentRun({ conversationId: conversation.id, agentId: 'pi', status: 'completed' });
    const recorder = createTranscriptRecorder(conversation.id, run.id);
    assert.ok(recorder);
    recorder.end('completed');
    updateAgentRun(conversation.id, run.id, {
      status: 'completed',
      stopReason: 'final_answer',
      completedAt: new Date().toISOString(),
    });
    await finalizeRunManifest({
      conversationId: conversation.id,
      runId: run.id,
      environment: ENVIRONMENT,
      scanProject: false,
    });

    const jsonResponse = await fetch(`${server.origin}/api/conversations/${conversation.id}/runs/${run.id}/manifest`);
    assert.equal(jsonResponse.status, 200);
    const body = (await jsonResponse.json()) as { manifest: { run: { id: string }; code: { commit: string } } };
    assert.equal(body.manifest.run.id, run.id);
    assert.equal(body.manifest.code.commit, 'feedface');

    const markdownResponse = await fetch(
      `${server.origin}/api/conversations/${conversation.id}/runs/${run.id}/manifest?format=markdown`,
    );
    assert.equal(markdownResponse.status, 200);
    assert.match(markdownResponse.headers.get('content-type') || '', /text\/markdown/);
    const markdown = await markdownResponse.text();
    assert.match(markdown, /feedface/);
    assert.match(markdown, /Reproduce/);

    const detailResponse = await fetch(`${server.origin}/api/conversations/${conversation.id}/runs/${run.id}`);
    const detail = (await detailResponse.json()) as { manifestPath: string | null };
    assert.ok(detail.manifestPath, 'run detail must expose the manifest path');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});

test('answers 404 manifest_not_ready for a run without a manifest', async () => {
  const server = await startTestServer();
  const project = createTempProject('run-manifest-missing');
  const conversation = createConversation({ title: 'manifest-missing', projectPath: project.projectPath });
  try {
    const run = createAgentRun({ conversationId: conversation.id, agentId: 'pi', status: 'completed' });
    const response = await fetch(`${server.origin}/api/conversations/${conversation.id}/runs/${run.id}/manifest`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'manifest_not_ready');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});
