import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import type { ContextBudgetStatus } from '../src/agent/context_manager.js';
import { readTranscript } from '../src/agent/transcript_reader.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

const BUDGET: ContextBudgetStatus = {
  heuristicTokenEstimate: 8400,
  tokenEstimate: 9240,
  calibrationMultiplier: 1.1,
  contextLimit: 200000,
  contextWindowTokens: 200000,
  contextWindowSource: 'configured',
  contextWindowReason: 'provider default',
  ratio: 0.046,
  softExceeded: false,
  hardExceeded: true,
  breakdown: { system: 8400, messages: 0, user: 0, tools: 800, overhead: 40, reservedOutput: 8000 },
};

function readRequest(conversationId: string): Record<string, unknown> {
  const event = readTranscript(conversationId).events.find((candidate) => candidate.type === 'model_request');
  assert.ok(event, 'expected a model_request record');
  return event.data;
}

test('a budget-forced tool-less request records why the tools are missing', () => {
  const project = createTempProject('transcript-request-degraded');
  const conversation = createConversation({ title: 'degraded', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-degraded');
    assert.ok(recorder);
    recorder.recordModelRequest({
      requestId: 'request-1',
      turnIndex: 1,
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
      maxOutputTokens: 8000,
      messages: [{ role: 'system', content: 'finish now' }],
      // The hard watermark dropped the tools, so `tools` is null — which on its own
      // looks exactly like a turn that deliberately had no tools.
      tools: null,
      degradations: [{ kind: 'tools_dropped', reason: 'context_hard_watermark' }],
      budget: BUDGET,
    });
    recorder.end('completed');

    const request = readRequest(conversation.id);
    assert.equal(request.tools, null);
    assert.deepEqual(request.degradations, [{ kind: 'tools_dropped', reason: 'context_hard_watermark' }]);
    const budget = request.budget as ContextBudgetStatus;
    assert.equal(budget.hardExceeded, true);
    assert.equal(budget.calibrationMultiplier, 1.1);
    assert.equal(budget.breakdown.tools, 800);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('an ordinary request stays free of degradation and budget noise', () => {
  const project = createTempProject('transcript-request-plain');
  const conversation = createConversation({ title: 'plain', projectPath: project.projectPath });
  try {
    const recorder = createTranscriptRecorder(conversation.id, 'run-plain');
    assert.ok(recorder);
    recorder.recordModelRequest({
      requestId: 'request-1',
      turnIndex: 1,
      llm: { baseUrl: 'https://llm.example.test/v1', model: 'bio-model' },
      maxOutputTokens: 4096,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'x', parameters: { type: 'object' } } }],
      toolChoice: 'auto',
    });
    recorder.end('completed');

    const request = readRequest(conversation.id);
    assert.equal(request.toolChoice, 'auto');
    assert.equal('degradations' in request, false);
    assert.equal('budget' in request, false);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
