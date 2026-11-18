import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import * as contextStore from '../src/agent/config/context_store.js';
import {
  fingerprintPinnedContext,
  RuntimeContextManager,
} from '../src/agent/context_manager.js';
import type { AgentRuntimeContext } from '../src/agent/service/agent_context_resolver.js';
import { createTempProject } from './helpers/project_fixture.js';

function makeContext(overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext {
  return {
    agent: { id: 'pi', name: 'PI', role: 'pi' },
    llmProvider: { id: 'p1', name: 'local', model: 'test-model' },
    llm: { model: 'test-model', contextWindowTokens: 128_000 },
    coreTools: [],
    mcpServers: [],
    skills: [],
    workspace: null,
    systemPrompt: 'You are the test agent.',
    systemPromptSections: [],
    pinnedTail: [],
    info: '',
    ...overrides,
  } as unknown as AgentRuntimeContext;
}

function storeCheckpoint(conversationId: string, fingerprint: string): contextStore.ContextCheckpoint {
  return contextStore.createContextCheckpoint({
    conversationId,
    triggerReason: 'test',
    tokenEstimate: 1_000,
    watermarkRatio: 0.7,
    pinnedFingerprint: fingerprint,
    programState: { summary: 'earlier work' },
    modelSummary: { taskState: { userGoal: 'summarise the run' } },
  });
}

function withConversation(run: (conversationId: string) => void): void {
  const project = createTempProject('checkpoint-fingerprint');
  const conversation = createConversation({ title: 'fingerprint', projectPath: project.projectPath });
  try {
    run(conversation.id);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
}

test('a checkpoint is injected when the pinned context still matches', () => {
  withConversation((conversationId) => {
    const context = makeContext();
    storeCheckpoint(conversationId, fingerprintPinnedContext(context));

    const managed = new RuntimeContextManager().buildManagedHistory({
      conversationId,
      history: [],
      context,
      userMessage: 'continue',
    });

    assert.ok(managed.checkpoint);
    assert.equal(managed.discardedCheckpoint, undefined);
    // The checkpoint is returned for the runtime to reuse when it compacts; it is not
    // injected, because the request already carries the full history.
    assert.equal(
      JSON.stringify(managed.messages).includes('<conversation_context_checkpoint>'),
      false,
      'a checkpoint must not be sent alongside the history it summarises',
    );
  });
});

test('a checkpoint written under a different system prompt is not injected', () => {
  withConversation((conversationId) => {
    storeCheckpoint(conversationId, fingerprintPinnedContext(makeContext()));
    const changed = makeContext({ systemPrompt: 'You are a different agent.' });

    const managed = new RuntimeContextManager().buildManagedHistory({
      conversationId,
      history: [],
      context: changed,
      userMessage: 'continue',
    });

    assert.equal(managed.checkpoint, null);
    assert.equal(managed.discardedCheckpoint?.reason, 'pinned_context_changed');
    // Nothing that looks like a summary may reach the model.
    assert.equal(managed.messages.some((message) => String(message.content).includes('<conversation_context_checkpoint>')), false);
  });
});

test('a checkpoint written under a different agent or capability catalog is not injected', () => {
  withConversation((conversationId) => {
    storeCheckpoint(conversationId, fingerprintPinnedContext(makeContext()));

    for (const context of [
      makeContext({ agent: { id: 'analysis', name: 'Analysis', kind: 'main' } as never }),
      makeContext({ coreTools: [{ id: 'read_file', name: 'read_file', description: 'reads files' } as never] }),
      makeContext({ mcpServers: [{ id: 'tavily', name: 'tavily', description: 'search' } as never] }),
      makeContext({ skills: [{ id: 'bio', name: 'bio', description: 'bioinformatics' } as never] }),
    ]) {
      const managed = new RuntimeContextManager().buildManagedHistory({
        conversationId,
        history: [],
        context,
        userMessage: 'continue',
      });
      assert.equal(managed.checkpoint, null);
      assert.equal(managed.discardedCheckpoint?.reason, 'pinned_context_changed');
    }
  });
});

test('a checkpoint without a fingerprint is treated as unverifiable, not as valid', () => {
  withConversation((conversationId) => {
    // Checkpoints written before the fingerprint existed carry an empty string.
    storeCheckpoint(conversationId, '');

    const managed = new RuntimeContextManager().buildManagedHistory({
      conversationId,
      history: [],
      context: makeContext(),
      userMessage: 'continue',
    });

    assert.equal(managed.checkpoint, null);
    assert.equal(managed.discardedCheckpoint?.reason, 'pinned_context_changed');
  });
});

test('the fingerprint ignores volatile content that is rebuilt per run', () => {
  const base = fingerprintPinnedContext(makeContext());
  // The artifact map and date live in `pinnedTail`, not in the fingerprint inputs.
  assert.equal(fingerprintPinnedContext(makeContext({ pinnedTail: ['<runtime_context_snapshot>\nnow\n</runtime_context_snapshot>'] })), base);
  assert.equal(
    fingerprintPinnedContext(makeContext({
      workspace: { root: '/tmp/project', artifacts: [{ path: 'a.txt', type: 'file', title: 'a' }] } as never,
    })),
    base,
  );
});
