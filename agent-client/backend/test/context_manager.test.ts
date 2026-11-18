import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateContextBudget,
  getTokenUsageCalibration,
  recordObservedPromptTokens,
  resolveMaxOutputTokens,
  RuntimeContextManager,
} from '../src/agent/context_manager.js';
import { buildResidentTools } from '../src/agent/resident_tools.js';
import { getAllCoreTools } from '../src/agent/config/agent_config_store.js';

test('context budget includes assistant tool-call arguments', () => {
  const status = estimateContextBudget({
    systemPrompt: '',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{ function: { name: 'search', arguments: '{"query":"very-specific-needle"}' } }],
    }],
    userMessage: '',
    contextWindowTokens: 10_000,
  });

  assert.ok(status.breakdown.messages > 10);
});

test('output cap leaves a context safety margin', () => {
  const maxTokens = resolveMaxOutputTokens({ tokenEstimate: 9_700, contextWindowTokens: 10_000 }, 4_000);
  assert.equal(maxTokens, 44);
});

test('the output reserve scales with the window instead of collapsing small ones', () => {
  for (const window of [1_000, 4_000, 8_000, 16_000, 32_000]) {
    const status = estimateContextBudget({
      systemPrompt: '',
      messages: [],
      userMessage: 'abcd',
      contextWindowTokens: window,
    });
    assert.ok(status.breakdown.reservedOutput < window, `reserve must leave room at window=${window}`);
    assert.ok(status.contextLimit >= Math.floor(window / 2), `input budget must stay usable at window=${window}`);
    assert.ok(status.ratio < 1, `an empty request must not start over budget at window=${window}`);
    assert.equal(status.hardExceeded, false, `hard watermark must not fire on an empty request at window=${window}`);
  }
});

test('large windows keep the default 8000-token reserve', () => {
  for (const window of [128_000, 1_000_000]) {
    const status = estimateContextBudget({
      systemPrompt: '', messages: [], userMessage: '', contextWindowTokens: window,
    });
    assert.equal(status.breakdown.reservedOutput, 8_000);
    assert.equal(status.contextLimit, window - 8_000);
  }
});

test('an explicit output limit is capped by the proportional reserve', () => {
  const status = estimateContextBudget({
    systemPrompt: '',
    messages: [],
    userMessage: '',
    contextWindowTokens: 16_000,
    maxOutputTokens: 32_000,
  });
  // 16k window: 20% = 3,200, which beats the 8,000 default and caps the explicit 32,000.
  assert.equal(status.breakdown.reservedOutput, 3_200);
});

test('observed provider usage conservatively calibrates later estimates for the same endpoint and model', () => {
  const llm = { baseUrl: 'https://usage-calibration.example.test/v1', model: `test-${Date.now()}` } as any;
  assert.equal(getTokenUsageCalibration(llm), 1);
  assert.equal(recordObservedPromptTokens(llm, 100, 140), 1.4);

  const status = estimateContextBudget({
    systemPrompt: '', messages: [], userMessage: 'abcd', contextWindowTokens: 10_000,
    calibrationMultiplier: getTokenUsageCalibration(llm),
  });
  assert.equal(status.tokenEstimate, Math.ceil(status.heuristicTokenEstimate * 1.4));
});

test('history is retained by token budget rather than a message count', () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    conversationId: 'conversation',
    role: index % 2 ? 'assistant' : 'user',
    content: `message-${index}`,
    toolCalls: null,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  })) as any;
  const managed = new RuntimeContextManager().buildManagedHistory({
    history,
    userMessage: 'next',
    context: {
      agent: {},
      llm: { model: 'test', contextWindowTokens: 128_000 },
      systemPrompt: '',
      coreTools: [],
      mcpServers: [],
      skills: [],
      workspace: null,
    } as any,
  });

  assert.equal(managed.messages.length, 12);
});

test('image content parts are estimated as images, not as base64 text', () => {
  const hugeImage = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
  const status = estimateContextBudget({
    systemPrompt: '',
    messages: [{
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: 'screenshot attached' },
        { type: 'image_url', image_url: { url: hugeImage } },
      ],
    }],
    userMessage: '',
    contextWindowTokens: 1_000_000,
  });

  // The base64 payload alone would be ~500k tokens; the estimate must stay tiny.
  assert.ok(status.breakdown.messages < 3_000, `image should not be counted as text (${status.breakdown.messages})`);
  assert.ok(status.breakdown.messages > 1_000, 'the image itself should still cost a conservative estimate');
});

test('the assembled budget prices the schemas the runtime installs', () => {
  const coreToolIds = ['shell', 'file', 'search', 'toollibrary'];
  const context = {
    agent: {},
    llm: { model: 'test', contextWindowTokens: 128_000 },
    systemPrompt: 'system',
    coreTools: getAllCoreTools().filter((tool) => coreToolIds.includes(tool.id)),
    mcpServers: [],
    skills: [],
    workspace: null,
  } as any;

  const managed = new RuntimeContextManager().buildManagedHistory({
    conversationId: 'budget-scope-conversation',
    history: [],
    userMessage: '',
    context,
  });

  // The expected figure is the one the runtime's own tool array would produce.
  const expected = estimateContextBudget({
    systemPrompt: '',
    messages: [],
    userMessage: '',
    contextWindowTokens: 128_000,
    tools: buildResidentTools(coreToolIds),
  }).breakdown.tools;

  assert.equal(managed.budget.breakdown.tools, expected);
  assert.ok(expected > 1_000, `resident schemas must be priced, got ${expected}`);
  assert.equal(managed.budget.toolsScope, 'resident');
});

test('a budget for a concrete turn is scoped to that request', () => {
  const status = estimateContextBudget({
    systemPrompt: '', messages: [], userMessage: '', contextWindowTokens: 128_000, tools: [],
  });
  assert.equal(status.toolsScope, 'request');
});

