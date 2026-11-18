import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import * as contextStore from '../src/agent/config/context_store.js';
import { fingerprintPinnedContext, RuntimeContextManager } from '../src/agent/context_manager.js';
import type { AgentRuntimeContext } from '../src/agent/service/agent_context_resolver.js';
import type { Message } from '../src/agent/config/conversation_types.js';
import { createTempProject } from './helpers/project_fixture.js';

function contextFor(windowTokens = 20_000): AgentRuntimeContext {
  return {
    agent: { id: 'pi', name: 'PI', role: 'pi' },
    llmProvider: { id: 'p1', name: 'local', model: 'test-model' },
    llm: { model: 'test-model', contextWindowTokens: windowTokens },
    coreTools: [],
    mcpServers: [],
    skills: [],
    workspace: null,
    systemPrompt: 'You are the test agent.',
    systemPromptSections: [],
    pinnedTail: [],
    info: '',
  } as unknown as AgentRuntimeContext;
}

function historyOf(length: number): Message[] {
  return Array.from({ length }, (_, index) => ({
    id: `m${index}`,
    conversationId: 'c',
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index} ${'x'.repeat(200)}`,
    toolCalls: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })) as Message[];
}

test('the whole history is sent, not a sliding window of it', () => {
  const history = historyOf(200);
  const managed = new RuntimeContextManager().buildManagedHistory({
    history,
    context: contextFor(),
    userMessage: 'next',
  });

  assert.equal(managed.messages.length, history.length, 'every recorded message must reach the request');
  assert.deepEqual(
    managed.messages.map((message) => message.role),
    history.map((message) => message.role),
  );
  // The old fallback note only existed because history was truncated; with nothing dropped it
  // would be a stale instruction to go looking for content that is already there.
  assert.equal(JSON.stringify(managed.messages).includes('Older conversation history'), false);
});

test('a stale window makes the assembly exceed the hard watermark instead of losing history', () => {
  const managed = new RuntimeContextManager().buildManagedHistory({
    history: historyOf(200),
    context: contextFor(20_000),
    userMessage: 'next',
  });

  // Dropping used to hide this: the request fitted because it silently forgot. Now the
  // over-budget state is visible, and compaction is the only thing that acts on it.
  assert.equal(managed.budget.hardExceeded, true);
  assert.equal(managed.messages.length, 200);
});

test('a matching checkpoint is returned for reuse and kept out of the request', () => {
  const project = createTempProject('assembly-checkpoint');
  const conversation = createConversation({ title: 'assembly', projectPath: project.projectPath });
  try {
    const context = contextFor();
    contextStore.createContextCheckpoint({
      conversationId: conversation.id,
      triggerReason: 'test',
      tokenEstimate: 1_000,
      watermarkRatio: 0.7,
      pinnedFingerprint: fingerprintPinnedContext(context),
      programState: { latestUserPrompt: 'earlier work' },
      modelSummary: { taskState: { userGoal: 'earlier work' } },
    });

    const managed = new RuntimeContextManager().buildManagedHistory({
      conversationId: conversation.id,
      history: historyOf(4),
      context,
      userMessage: 'continue',
    });

    assert.ok(managed.checkpoint, 'the runtime needs it as the starting point for compaction');
    assert.equal(managed.messages.length, 4, 'the history is sent in full');
    assert.equal(
      JSON.stringify(managed.messages).includes('conversation_context_checkpoint'),
      false,
      'sending the summary next to the history it summarises pays for the same content twice',
    );
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
