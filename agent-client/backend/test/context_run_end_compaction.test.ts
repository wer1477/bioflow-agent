import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import * as contextStore from '../src/agent/config/context_store.js';
import {
  planRunEndCompaction,
  RuntimeContextManager,
} from '../src/agent/context_manager.js';
import type { AgentRuntimeContext } from '../src/agent/service/agent_context_resolver.js';
import { createTempProject } from './helpers/project_fixture.js';

for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

function summaryFixture(userGoal = 'x') {
  return {
    schemaVersion: 1,
    taskState: { userGoal, currentStatus: 'in_progress', latestUserInstruction: '', openQuestions: [] },
    decisions: [],
    stableFacts: [],
    completedActions: [],
    pendingActions: [],
    discardedContext: {},
    continuationPrompt: 'continue',
  };
}

function contextFor(overrides: Record<string, unknown> = {}): AgentRuntimeContext {
  return {
    agent: { id: 'pi', name: 'PI', role: 'pi' },
    llmProvider: { id: 'p1', name: 'local', model: 'test-model' },
    llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'unused', model: 'test-model', contextWindowTokens: 20_000 },
    coreTools: [],
    mcpServers: [],
    skills: [],
    workspace: null,
    systemPrompt: 'system',
    systemPromptSections: [],
    pinnedTail: [],
    info: '',
    ...overrides,
  } as unknown as AgentRuntimeContext;
}

test('the run-end plan separates "reuse the summary" from "summarise again"', () => {
  assert.deepEqual(planRunEndCompaction({ aboveSoftWatermark: false }), { action: 'skip' });
  assert.deepEqual(planRunEndCompaction({ aboveSoftWatermark: true }), { action: 'summarise' });
  assert.deepEqual(
    planRunEndCompaction({ runtimeSummary: { taskState: {} }, aboveSoftWatermark: false }),
    { action: 'reuse' },
  );
  assert.deepEqual(
    planRunEndCompaction({ runtimeSummary: { taskState: {} }, aboveSoftWatermark: true }),
    { action: 'summarise' },
  );
});

test('a reused summary is persisted without calling the summariser', () => {
  const project = createTempProject('run-end-reuse');
  const conversation = createConversation({ title: 'reuse', projectPath: project.projectPath });
  try {
    const summary = {
      schemaVersion: 1,
      taskState: { userGoal: 'reuse me', currentStatus: 'in_progress' },
      pendingActions: ['run the last step'],
    };
    const checkpoint = new RuntimeContextManager().saveCheckpoint({
      conversationId: conversation.id,
      context: contextFor(),
      messages: [{
        id: 'm1', conversationId: conversation.id, role: 'user', content: 'the goal',
        toolCalls: null, createdAt: '2026-10-31T00:00:00.000Z',
      }] as never,
      budget: { tokenEstimate: 1_000, ratio: 0.2 },
      triggerReason: 'runtime_summary_after_task',
      modelSummary: summary,
    });

    const stored = contextStore.getLatestContextCheckpoint(conversation.id);
    assert.ok(stored, 'the checkpoint must be readable from the conversation');
    assert.deepEqual(stored.modelSummary, summary);
    assert.deepEqual((stored.programState as any).latestUserPrompt, 'the goal');
    assert.equal(checkpoint.triggerReason, 'runtime_summary_after_task');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('the run-end summary covers groups a request would have kept verbatim', async (t) => {
  const prompts: string[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      prompts.push(String(body.messages[body.messages.length - 1]?.content || ''));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(summaryFixture()) }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const project = createTempProject('run-end-checkpoint-mode');
  const conversation = createConversation({ title: 'mode', projectPath: project.projectPath });
  try {
    // KEEPMARK sits on a small, high-fidelity group: a *request* plan would keep it verbatim
    // and never summarise it. A checkpoint has no request to keep it in, so it must reach the
    // summariser or it is lost from the checkpoint entirely.
    const messages = [
      { role: 'assistant', content: 'samtools sort -@8 -o /project/KEEPMARK.bam in.bam' },
      { role: 'assistant', content: `filler ${'f'.repeat(2_000)}` },
      { role: 'assistant', content: `TAIL ${'t'.repeat(40_000)}` },
    ] as never;

    await new RuntimeContextManager().compactAfterRun({
      conversationId: conversation.id,
      context: contextFor({
        llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'checkpoint-mode', contextWindowTokens: 20_000 },
      }),
      messages,
      budget: { tokenEstimate: 8_000, ratio: 0.4, contextWindowTokens: 20_000 },
      triggerReason: 'soft_watermark_after_task',
    });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /KEEPMARK/, 'a checkpoint must summarise what a request would have kept');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('the run-end summary reads the zone the next assembly drops, not the tail it re-sends', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(summaryFixture()) }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const project = createTempProject('run-end-zone');
  const conversation = createConversation({ title: 'zone', projectPath: project.projectPath });
  try {
    // 20k window -> 6k-token tail. The final message alone is larger than the tail budget,
    // so the tail is exactly that message and everything before it is the zone the next
    // assembly would drop. ZONEMARK sits on an assistant message, which `programState`
    // does not copy, so finding it in the prompt proves the zone reached the summariser.
    const messages = [
      // Large enough that the cold-zone verbatim quota (2% of the window) cannot keep it:
      // the point of the test is which text reaches the summariser, not quota arithmetic.
      { role: 'assistant', content: `ZONEMARK ${'z'.repeat(4_000)}` },
      ...Array.from({ length: 3 }, (_, index) => ({
        role: 'assistant',
        content: `BARRIER ${index} ${'b'.repeat(2_000)}`,
      })),
      { role: 'assistant', content: `TAILMARK ${'t'.repeat(30_000)}` },
    ] as never;

    const { checkpoint } = await new RuntimeContextManager().compactAfterRun({
      conversationId: conversation.id,
      context: contextFor({
        llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'zone-test', contextWindowTokens: 20_000 },
      }),
      messages,
      budget: { tokenEstimate: 8_000, ratio: 0.4, contextWindowTokens: 20_000 },
      triggerReason: 'soft_watermark_after_task',
    });

    assert.ok(checkpoint.modelSummary);
    assert.equal(bodies.length, 1);
    const prompt = String(bodies[0].messages[bodies[0].messages.length - 1].content);
    assert.match(prompt, /ZONEMARK/, 'the dropped zone must reach the summariser');
    assert.doesNotMatch(prompt, /TAILMARK/, 'the verbatim tail must not be summarised again');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a failed run-end summary preserves the prior summary and marks the new tail uncovered', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const project = createTempProject('run-end-failed-summary');
  const conversation = createConversation({ title: 'failed-summary', projectPath: project.projectPath });
  try {
    const manager = new RuntimeContextManager();
    manager.saveCheckpoint({
      conversationId: conversation.id,
      context: contextFor(),
      messages: [{ id: 'm0', conversationId: conversation.id, role: 'user', content: 'PRIOR-GOAL', toolCalls: null, createdAt: '2026-10-31T00:00:00.000Z' }] as never,
      budget: { tokenEstimate: 1_000, ratio: 0.1 },
      triggerReason: 'prior',
      modelSummary: {
        schemaVersion: 1,
        taskState: { userGoal: 'PRIOR-GOAL', currentStatus: 'in_progress' },
        stableFacts: ['PRIOR-FACT'],
        contextCoverage: { summarisedMessages: 1, totalMessages: 1, uncoveredTail: false },
      },
    });
    const messages = [
      { role: 'assistant', content: `OLDFACT ${'o'.repeat(4_000)}` },
      ...Array.from({ length: 3 }, (_, index) => ({ role: 'assistant', content: `BARRIER ${index} ${'b'.repeat(2_000)}` })),
      { role: 'assistant', content: `NEWTAIL ${'n'.repeat(30_000)}` },
    ] as never;

    const result = await manager.compactAfterRun({
      conversationId: conversation.id,
      context: contextFor({
        llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'failed-summary', contextWindowTokens: 20_000 },
      }),
      messages,
      budget: { tokenEstimate: 12_000, ratio: 0.6, contextWindowTokens: 20_000 },
      triggerReason: 'soft_watermark_after_task',
    });

    assert.ok(result.degraded);
    assert.match(result.degraded.reason, /empty text/);
    assert.equal(bodies.length, 2, 'an empty reply is retried once with the repair prompt');
    assert.equal(bodies[0].reasoning_effort, 'none', 'summariser must explicitly disable provider-default reasoning');
    const stored = contextStore.getLatestContextCheckpoint(conversation.id);
    assert.ok(stored);
    assert.deepEqual((stored.modelSummary as any).stableFacts, ['PRIOR-FACT']);
    assert.equal((stored.modelSummary as any).taskState.userGoal, 'PRIOR-GOAL');
    assert.equal((stored.modelSummary as any).contextCoverage.uncoveredTail, true);
    assert.equal((stored.modelSummary as any).contextCoverage.summarisedMessages, 1);
    assert.equal((stored.modelSummary as any).contextCoverage.totalMessages, 5);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a later successful retry covers the tail without losing prior facts', async (t) => {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              ...summaryFixture('PRIOR-GOAL'),
              taskState: { userGoal: 'PRIOR-GOAL', currentStatus: 'completed', latestUserInstruction: '', openQuestions: [] },
              stableFacts: ['PRIOR-FACT', 'RETRY-FACT'],
            }),
          },
          finish_reason: 'stop',
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const project = createTempProject('run-end-retry-summary');
  const conversation = createConversation({ title: 'retry-summary', projectPath: project.projectPath });
  try {
    const manager = new RuntimeContextManager();
    manager.saveCheckpoint({
      conversationId: conversation.id,
      context: contextFor(),
      messages: [{ id: 'm0', conversationId: conversation.id, role: 'user', content: 'PRIOR-GOAL', toolCalls: null, createdAt: '2026-10-31T00:00:00.000Z' }] as never,
      budget: { tokenEstimate: 1_000, ratio: 0.1 },
      triggerReason: 'prior',
      modelSummary: { schemaVersion: 1, taskState: { userGoal: 'PRIOR-GOAL' }, stableFacts: ['PRIOR-FACT'] },
    });
    const messages = [
      { role: 'assistant', content: `OLDFACT ${'o'.repeat(4_000)}` },
      ...Array.from({ length: 3 }, (_, index) => ({ role: 'assistant', content: `BARRIER ${index} ${'b'.repeat(2_000)}` })),
      { role: 'assistant', content: `NEWTAIL ${'n'.repeat(30_000)}` },
    ] as never;

    const result = await manager.compactAfterRun({
      conversationId: conversation.id,
      context: contextFor({
        llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'retry-summary', contextWindowTokens: 20_000 },
      }),
      messages,
      budget: { tokenEstimate: 12_000, ratio: 0.6, contextWindowTokens: 20_000 },
      triggerReason: 'soft_watermark_after_task',
    });

    assert.equal(result.degraded, undefined);
    const stored = contextStore.getLatestContextCheckpoint(conversation.id);
    assert.ok(stored);
    assert.deepEqual((stored.modelSummary as any).stableFacts, ['PRIOR-FACT', 'RETRY-FACT']);
    // The summary covers the cold segment; the verbatim tail is explicitly not claimed.
    assert.equal((stored.modelSummary as any).contextCoverage.uncoveredTail, true);
    assert.ok((stored.modelSummary as any).contextCoverage.summarisedMessages <= 5);
    assert.ok((stored.modelSummary as any).contextCoverage.tailMessages >= 1);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a schema-invalid summary is retried with a bounded repair prompt', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      const content = bodies.length === 1
        ? JSON.stringify({ user_goal: 'wrong schema', completed_work: 'nothing' })
        : JSON.stringify({
            schemaVersion: 1,
            taskState: { userGoal: 'right schema', currentStatus: 'in_progress' },
            decisions: [], stableFacts: [], completedActions: [], pendingActions: [],
            discardedContext: {}, continuationPrompt: 'continue',
          });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const project = createTempProject('run-end-schema-retry');
  const conversation = createConversation({ title: 'schema-retry', projectPath: project.projectPath });
  try {
    const messages = [
      { role: 'assistant', content: `OLDFACT ${'o'.repeat(4_000)}` },
      ...Array.from({ length: 3 }, (_, index) => ({ role: 'assistant', content: `BARRIER ${index} ${'b'.repeat(2_000)}` })),
      { role: 'assistant', content: `NEWTAIL ${'n'.repeat(30_000)}` },
    ] as never;
    const result = await new RuntimeContextManager().compactAfterRun({
      conversationId: conversation.id,
      context: contextFor({
        llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'schema-retry', contextWindowTokens: 20_000 },
      }),
      messages,
      budget: { tokenEstimate: 12_000, ratio: 0.6, contextWindowTokens: 20_000 },
      triggerReason: 'soft_watermark_after_task',
    });
    assert.equal(result.degraded, undefined);
    assert.equal(bodies.length, 2);
    assert.match(String(bodies[1].messages.at(-1)?.content), /previous reply was rejected/i);
    const stored = contextStore.getLatestContextCheckpoint(conversation.id);
    assert.equal((stored?.modelSummary as any).taskState.userGoal, 'right schema');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('an endpoint that rejects reasoning_effort still completes the run-end summary', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      if (body.reasoning_effort) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Unknown parameter: reasoning_effort' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(summaryFixture('compat')) }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const project = createTempProject('run-end-compat');
  const conversation = createConversation({ title: 'compat', projectPath: project.projectPath });
  try {
    const messages = [
      { role: 'assistant', content: `OLDFACT ${'o'.repeat(4_000)}` },
      ...Array.from({ length: 3 }, (_, index) => ({ role: 'assistant', content: `BARRIER ${index} ${'b'.repeat(2_000)}` })),
      { role: 'assistant', content: `NEWTAIL ${'n'.repeat(30_000)}` },
    ] as never;
    const result = await new RuntimeContextManager().compactAfterRun({
      conversationId: conversation.id,
      context: contextFor({
        llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'compat', contextWindowTokens: 20_000 },
      }),
      messages,
      budget: { tokenEstimate: 12_000, ratio: 0.6, contextWindowTokens: 20_000 },
      triggerReason: 'soft_watermark_after_task',
    });
    assert.equal(result.degraded, undefined);
    assert.ok(bodies.length >= 2);
    assert.equal(bodies[0].reasoning_effort, 'none');
    assert.equal('reasoning_effort' in bodies[1], false);
    assert.equal((result.checkpoint.modelSummary as any).taskState.userGoal, 'compat');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
