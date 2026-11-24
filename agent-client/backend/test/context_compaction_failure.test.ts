import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import * as contextStore from '../src/agent/config/context_store.js';
import { compactRuntimeMessages, RuntimeContextManager } from '../src/agent/context_manager.js';
import type { AgentRuntimeContext } from '../src/agent/service/agent_context_resolver.js';
import { createTempProject } from './helpers/project_fixture.js';

/** A provider stub: `mode` decides whether the compaction summary call succeeds. */
async function startProvider(mode: 'fail' | 'ok' | 'empty' | 'text'): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (mode === 'text') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'The matrix is done.' }, finish_reason: 'stop' }],
        }));
        return;
      }
      if (mode === 'fail') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream summariser unavailable', type: 'server_error' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: mode === 'ok' ? JSON.stringify({
          schemaVersion: 1,
          taskState: { userGoal: 'build the matrix', currentStatus: 'in_progress' },
          stableFacts: [{ fact: 'row 3 was extracted', source: 'tool', confidence: 'high' }],
          decisions: [], completedActions: [], pendingActions: [],
          discardedContext: {}, continuationPrompt: 'continue',
        }) : '' }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function llmFor(baseUrl: string) {
  return { baseUrl, apiKey: 'unused', model: `compaction-${Date.now()}`, contextWindowTokens: 20_000 };
}

/** Enough history that the tail limit leaves a cold segment to summarise. */
function longHistory(): Array<Record<string, unknown>> {
  return Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message-${index} ${'x'.repeat(3_000)}`,
  }));
}

test('a failed summary keeps the cold segment instead of replacing it', async (t) => {
  const { server, baseUrl } = await startProvider('fail');
  t.after(() => server.close());

  const messages = longHistory();
  const outcome = await compactRuntimeMessages({
    llm: llmFor(baseUrl) as never,
    messages: messages as never[],
    contextWindowTokens: 20_000,
  });

  assert.equal(outcome.compacted, false);
  assert.ok(outcome.degraded?.reason, 'the failure reason must be reported, not swallowed');
  // The caller may show this: the run must not lose history to a one-line apology.
  assert.deepEqual(outcome.messages, messages);
  assert.equal(JSON.stringify(outcome.messages).includes('<runtime_context_checkpoint>'), false);
});

test('an empty summary is a failure, not a checkpoint with no content', async (t) => {
  const { server, baseUrl } = await startProvider('empty');
  t.after(() => server.close());

  const messages = longHistory();
  const outcome = await compactRuntimeMessages({
    llm: llmFor(baseUrl) as never,
    messages: messages as never[],
    contextWindowTokens: 20_000,
  });

  assert.equal(outcome.compacted, false);
  assert.match(String(outcome.degraded?.reason), /empty/i);
  assert.deepEqual(outcome.messages, messages);
});

test('a non-JSON summary is a failure too, not a checkpoint with prose in it', async (t) => {
  const { server, baseUrl } = await startProvider('text');
  t.after(() => server.close());

  const messages = longHistory();
  const outcome = await compactRuntimeMessages({
    llm: llmFor(baseUrl) as never,
    messages: messages as never[],
    contextWindowTokens: 20_000,
  });

  assert.equal(outcome.compacted, false);
  assert.match(String(outcome.degraded?.reason), /non-JSON/i);
  assert.deepEqual(outcome.messages, messages);
});

test('a successful summary still replaces the cold segment', async (t) => {
  const { server, baseUrl } = await startProvider('ok');
  t.after(() => server.close());

  const messages = longHistory();
  const outcome = await compactRuntimeMessages({
    llm: llmFor(baseUrl) as never,
    messages: messages as never[],
    contextWindowTokens: 20_000,
  });

  assert.equal(outcome.compacted, true);
  assert.equal(outcome.degraded, undefined);
  assert.ok(outcome.summary, 'the structured summary must be returned for the run-end checkpoint');
  assert.ok(outcome.messages.length < messages.length);
  const first = outcome.messages[0];
  assert.equal(first.role, 'assistant');
  assert.match(String(first.content), /<runtime_context_checkpoint>/);
  assert.match(String(first.content), /row 3 was extracted/);
});

test('a run-end compaction reports a degraded summary while still saving the checkpoint', async (t) => {
  const { server, baseUrl } = await startProvider('fail');
  t.after(() => server.close());

  const project = createTempProject('compaction-degraded');
  const conversation = createConversation({ title: 'compaction', projectPath: project.projectPath });
  try {
    const context = {
      agent: { id: 'pi', name: 'PI', role: 'pi' },
      llm: llmFor(baseUrl),
      systemPrompt: 'system',
      coreTools: [],
      mcpServers: [],
      skills: [],
      workspace: null,
    } as unknown as AgentRuntimeContext;

    const budget = {
      heuristicTokenEstimate: 1_000,
      tokenEstimate: 1_000,
      calibrationMultiplier: 1,
      contextLimit: 10_000,
      contextWindowTokens: 20_000,
      contextWindowSource: 'configured',
      contextWindowReason: 'llm.json contextWindowTokens',
      ratio: 0.1,
      softExceeded: false,
      hardExceeded: false,
      breakdown: { system: 0, messages: 0, user: 0, tools: 0, overhead: 0, reservedOutput: 0 },
    } as never;

    const { checkpoint, degraded } = await new RuntimeContextManager().compactAfterRun({
      conversationId: conversation.id,
      context,
      messages: longHistory().map((message) => ({ id: 'm', conversationId: conversation.id, ...message, createdAt: '2026-01-01T00:00:00.000Z' })) as never,
      budget,
      triggerReason: 'soft_watermark_after_task',
    });

    // The deterministic half is still worth keeping…
    assert.equal(contextStore.getLatestContextCheckpoint(conversation.id)?.id, checkpoint.id);
    assert.ok(checkpoint.programState);
    // …but it must not be reported as a clean compaction.
    assert.ok(degraded?.reason, 'a fallback summary must be reported as degraded');
    assert.match(JSON.stringify(checkpoint.modelSummary), /Compression fallback/);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
