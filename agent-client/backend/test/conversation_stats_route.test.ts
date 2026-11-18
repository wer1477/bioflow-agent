import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { ensureRoleSession } from '../src/agent/team/team_service.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

// The resolver interpolates configured providers' `${BIOFLOW_LLM_API_KEY_*}` references.
// Tests do not load `backend/.env`, so give them something to resolve.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

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

function recordRun(conversationId: string, runId: string): void {
  const recorder = createTranscriptRecorder(conversationId, runId);
  assert.ok(recorder);
  recorder.recordModelRequest({
    requestId: 'request-1',
    turnIndex: 1,
    llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
    maxOutputTokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    tools: null,
  });
  recorder.recordModelChunk('request-1', { choices: [{ delta: { content: 'hello' } }] });
  recorder.recordEngineEvent({
    type: 'loop_health',
    level: 'info',
    reason: 'token_usage_observed',
    detail: 'usage',
    tokenUsage: {
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
      cachedPromptTokens: 750,
    },
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

test('GET stats returns activity, token usage and a three-category context snapshot', async () => {
  const server = await startTestServer();
  const project = createTempProject('conversation-stats-route');
  const conversation = createConversation({ title: 'stats', projectPath: project.projectPath });
  try {
    recordRun(conversation.id, 'run-stats-1');

    const response = await fetch(`${server.origin}/api/conversations/${conversation.id}/stats?agentId=pi`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      conversationId: string;
      activity: { turns: number; steps: number; decodeTokens: number; tokensPerSecond: number | null };
      tokenUsage: { totalTokens: number; cacheHitPercent: number | null };
      context: {
        usedTokens: number;
        contextWindowTokens: number;
        percent: number;
        breakdown: Record<string, number>;
      };
    };

    assert.equal(body.conversationId, conversation.id);
    assert.equal(body.activity.turns, 1);
    assert.equal(body.activity.steps, 1);
    assert.equal(body.activity.decodeTokens, 100);
    assert.ok((body.activity.tokensPerSecond ?? 0) > 0);
    assert.equal(body.tokenUsage.totalTokens, 1100);
    assert.equal(body.tokenUsage.cacheHitPercent, 75);
    assert.ok(body.context.contextWindowTokens > 0);
    assert.equal(typeof body.context.percent, 'number');
    assert.deepEqual(Object.keys(body.context.breakdown).sort(), ['messages', 'system', 'tools']);
    assert.ok(body.context.breakdown.system > 0);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});

test('GET stats reports 404 for an unknown conversation', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.origin}/api/conversations/no-such-conversation/stats`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test('a team root counts the role sessions whose messages it shows', async () => {
  const server = await startTestServer();
  const project = createTempProject('conversation-stats-team');
  const root = createConversation({ title: 'New conversation', projectPath: project.projectPath });
  const roleSession = ensureRoleSession(root.id, 'pi');
  try {
    recordRun(roleSession.id, 'run-team-1');

    const response = await fetch(`${server.origin}/api/conversations/${root.id}/stats?agentId=pi`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      activity: { turns: number; steps: number };
      tokenUsage: { totalTokens: number };
      context: { percent: number; agentLabel: string | null } | null;
    };

    // The root's own transcript is empty; the work is one level down.
    assert.equal(body.activity.turns, 1);
    assert.equal(body.activity.steps, 1);
    assert.equal(body.tokenUsage.totalTokens, 1100);
    // The window belongs to the role the team is on, and the reading says which role.
    assert.ok(body.context);
    assert.equal(body.context?.agentLabel, 'PI');
    assert.equal(typeof body.context?.percent, 'number');
  } finally {
    deleteConversation(roleSession.id);
    deleteConversation(root.id);
    project.cleanup();
    await server.close();
  }
});

test('a team root counts the work its role sessions delegated', async () => {
  const server = await startTestServer();
  const project = createTempProject('conversation-stats-subagent');
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const pi = ensureRoleSession(root.id, 'pi');
  const child = createConversation({
    title: 'Subagent · probe',
    projectPath: project.projectPath,
    parentConversationId: pi.id,
    subagentDepth: 1,
  });
  try {
    recordRun(pi.id, 'run-role');
    recordRun(child.id, 'run-child');

    const body = await (await fetch(`${server.origin}/api/conversations/${root.id}/stats`)).json() as {
      activity: { turns: number };
      tokenUsage: { totalTokens: number };
    };

    // Both the role session and the child it delegated are the team's work.
    assert.equal(body.activity.turns, 2);
    assert.equal(body.tokenUsage.totalTokens, 2200);
  } finally {
    deleteConversation(root.id);
    project.cleanup();
    await server.close();
  }
});

test('a role session keeps its own totals instead of folding the team in', async () => {
  const server = await startTestServer();
  const project = createTempProject('conversation-stats-role');
  const root = createConversation({ title: 'team', projectPath: project.projectPath });
  const pi = ensureRoleSession(root.id, 'pi');
  const writer = ensureRoleSession(root.id, 'writer');
  try {
    recordRun(pi.id, 'run-role-pi');
    recordRun(writer.id, 'run-role-writer');

    const rootBody = await (await fetch(`${server.origin}/api/conversations/${root.id}/stats`)).json() as {
      activity: { turns: number; steps: number };
      context: { agentLabel: string | null } | null;
    };
    const roleBody = await (await fetch(`${server.origin}/api/conversations/${pi.id}/stats`)).json() as {
      activity: { turns: number; steps: number };
      context: { agentLabel: string | null } | null;
    };

    assert.equal(rootBody.activity.turns, 2, 'the root counts both roles');
    assert.equal(roleBody.activity.turns, 1, 'the role counts only itself');
    // The role session is read as itself, not as the caller-selected agent.
    assert.equal(roleBody.context?.agentLabel, 'PI');
  } finally {
    deleteConversation(pi.id);
    deleteConversation(writer.id);
    deleteConversation(root.id);
    project.cleanup();
    await server.close();
  }
});

test('a binding only the context probe rejects still leaves activity and usage standing', async () => {
  const server = await startTestServer();
  const project = createTempProject('conversation-stats-bad-agent');
  const conversation = createConversation({ title: 'stats', projectPath: project.projectPath });
  try {
    recordRun(conversation.id, 'run-stats-bad-agent');

    const response = await fetch(`${server.origin}/api/conversations/${conversation.id}/stats?agentId=no-such-agent`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      activity: { turns: number; steps: number };
      tokenUsage: { totalTokens: number };
      context: unknown;
    };

    assert.equal(body.activity.turns, 1);
    assert.equal(body.tokenUsage.totalTokens, 1100);
    assert.equal(body.context, null, 'the window is unknown, the totals are not');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
    await server.close();
  }
});
