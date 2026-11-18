import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { ensureRoleSession } from '../src/agent/team/team_service.js';
import {
  createTranscriptRecorder,
  getTranscriptEventsPath,
} from '../src/agent/transcript_store.js';
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

function recordRun(conversationId: string, runId: string, identity: Parameters<typeof createTranscriptRecorder>[2] = {}): void {
  const recorder = createTranscriptRecorder(conversationId, runId, identity);
  assert.ok(recorder);
  recorder.recordModelRequest({
    requestId: 'request-1',
    turnIndex: 1,
    llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
    maxOutputTokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    tools: null,
  });
  recorder.recordModelResponse({
    requestId: 'request-1',
    turnIndex: 1,
    content: 'hello',
    toolCalls: [],
    finishReason: 'stop',
  });
  recorder.end('completed');
}

test('the tree endpoint maps the root, every role session and every delegated child', async () => {
  const server = await startTestServer();
  const project = createTempProject('transcript-tree');
  const root = createConversation({ projectPath: project.projectPath, title: 'team' });
  const pi = ensureRoleSession(root.id, 'pi');
  const child = createConversation({
    projectPath: project.projectPath,
    title: 'Subagent · probe',
    parentConversationId: pi.id,
    subagentDepth: 1,
  });
  try {
    recordRun(pi.id, 'run-pi');
    recordRun(child.id, 'run-child', {
      agentId: 'pi',
      parentConversationId: pi.id,
      parentRunId: 'run-pi',
      delegationDepth: 1,
    });

    const response = await fetch(`${server.origin}/api/conversations/${root.id}/transcript/tree`);
    assert.equal(response.status, 200);
    const tree = await response.json() as {
      rootId: string;
      conversations: Array<{
        conversationId: string;
        roleId: string | null;
        parentConversationId: string | null;
        depth: number;
        runs: Array<{ runId: string; status: string }>;
        eventCount: number;
        damaged: boolean;
      }>;
      totals: { conversations: number; runs: number; events: number; damaged: number };
    };

    assert.equal(tree.rootId, root.id);
    assert.equal(tree.conversations.length, 3);
    const byId = new Map(tree.conversations.map((node) => [node.conversationId, node]));

    assert.equal(byId.get(root.id)?.depth, 0);
    assert.equal(byId.get(root.id)?.runs.length, 0, 'the container never ran');
    assert.equal(byId.get(pi.id)?.roleId, 'pi');
    assert.equal(byId.get(pi.id)?.depth, 1);
    assert.deepEqual(byId.get(pi.id)?.runs.map((run) => run.runId), ['run-pi']);
    assert.equal(byId.get(pi.id)?.runs[0]?.status, 'completed');
    assert.equal(byId.get(child.id)?.parentConversationId, pi.id);
    assert.deepEqual(byId.get(child.id)?.runs.map((run) => run.runId), ['run-child']);
    assert.equal(tree.totals.runs, 2);
    assert.equal(tree.totals.damaged, 0);
  } finally {
    deleteConversation(root.id);
    project.cleanup();
    await server.close();
  }
});

test('a damaged node is reported without hiding the rest of the tree', async () => {
  const server = await startTestServer();
  const project = createTempProject('transcript-tree-damaged');
  const root = createConversation({ projectPath: project.projectPath, title: 'team' });
  const pi = ensureRoleSession(root.id, 'pi');
  const child = createConversation({
    projectPath: project.projectPath,
    title: 'Subagent · probe',
    parentConversationId: pi.id,
    subagentDepth: 1,
  });
  try {
    recordRun(pi.id, 'run-pi');
    recordRun(child.id, 'run-child', { parentConversationId: pi.id, delegationDepth: 1 });
    // A malformed *committed* record (terminated line) is corruption, not a torn tail.
    fs.appendFileSync(getTranscriptEventsPath(child.id), 'this is not json\n');

    const tree = await (await fetch(`${server.origin}/api/conversations/${root.id}/transcript/tree`)).json() as {
      conversations: Array<{ conversationId: string; damaged: boolean; runs: unknown[] }>;
      totals: { damaged: number; runs: number };
    };
    const childNode = tree.conversations.find((node) => node.conversationId === child.id);
    assert.equal(childNode?.damaged, true);
    assert.deepEqual(childNode?.runs, []);
    assert.equal(tree.totals.damaged, 1);
    assert.equal(tree.totals.runs, 1, 'the healthy role session is still counted');

    // The single-conversation endpoint stays loud about the same file.
    const single = await fetch(`${server.origin}/api/conversations/${child.id}/transcript`);
    assert.equal(single.status, 500);
  } finally {
    deleteConversation(root.id);
    project.cleanup();
    await server.close();
  }
});
