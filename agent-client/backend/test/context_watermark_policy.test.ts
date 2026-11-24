import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { AgentRuntime, ContextBudgetExceededError, PendingTasksError } from '../src/agent/agent_runtime.js';
import {
  estimateContextBudget,
} from '../src/agent/context_manager.js';
import { buildResidentTools } from '../src/agent/resident_tools.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { getLatestContextCheckpoint } from '../src/agent/config/context_store.js';
import { getAgentRun } from '../src/agent/config/run_store.js';
import { agentContextResolver, type AgentRuntimeContext } from '../src/agent/service/agent_context_resolver.js';
import { AgentService } from '../src/agent/service/agent_service.js';
import { createTempProject } from './helpers/project_fixture.js';

// `toLlmConfig` interpolates the provider's `${BIOFLOW_LLM_API_KEY_*}` reference and tests
// never load `backend/.env`; the value itself is unused here.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

const SYSTEM_PROMPT = 'You are a test agent.';
const WINDOW = 20_000;

/**
 * Mirror the runtime's own estimate: the system prompt travels inside `messages`, so the
 * runtime passes `systemPrompt: ''` and counts one array. Reproducing it here is what lets
 * a test pick a payload that lands in a chosen band instead of guessing.
 */
function ratioFor(historyChars: number): number {
  return estimateContextBudget({
    systemPrompt: '',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      // Assistant first on purpose: the tail walk-back always takes the last message, so a
      // huge *user* message would become the tail and leave nothing summarisable, while a
      // huge assistant message stays in the cold zone where compaction can act on it.
      { role: 'assistant', content: 'x'.repeat(historyChars) },
      { role: 'user', content: 'continue' },
      { role: 'user', content: 'hi' },
    ],
    userMessage: '',
    contextWindowTokens: WINDOW,
    tools: buildResidentTools(),
  }).ratio;
}

/** Smallest payload whose budget ratio falls inside `[low, high]`. */
function payloadFor(low: number, high: number): number {
  let start = 1_000;
  let end = 400_000;
  let found = -1;
  while (start <= end) {
    const middle = Math.floor((start + end) / 2);
    const ratio = ratioFor(middle);
    if (ratio < low) start = middle + 1;
    else if (ratio > high) end = middle - 1;
    else {
      found = middle;
      break;
    }
  }
  assert.ok(found > 0, `no payload lands in [${low}, ${high}] for a ${WINDOW}-token window`);
  return found;
}

function toolCall(id: string, name: string, args: object) {
  return { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

async function runWithPayload(t: TestContext, historyChars: number, options: {
  systemPrompt?: string;
  userMessage?: string;
  deltas?: Array<{ content?: string; tool_calls?: unknown[] }>;
  invalidSummary?: boolean;
  budgetBlocked?: boolean;
  unfinishedTasks?: boolean;
} = {}): Promise<{ events: any[]; bodies: any[] }> {
  const bodies: any[] = [];
  let modelTurns = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.stream) {
      const delta = options.deltas?.[modelTurns++] ?? { content: 'ok' };
      const choice = { delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' };
      return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const content = options.invalidSummary ? 'invalid summary' : JSON.stringify({
      schemaVersion: 1, taskState: { userGoal: 'test', currentStatus: 'in_progress' },
      decisions: [], stableFacts: [], completedActions: [], pendingActions: [],
      discardedContext: {}, continuationPrompt: 'continue',
    });
    return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  });
  const runtime = new AgentRuntime({
    async connectServers() {
      return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] };
    },
  } as any);
  const events: any[] = [];
  const collect = async () => {
    for await (const event of runtime.chat({
      runId: 'watermark-policy',
      llm: { baseUrl: `http://${randomUUID()}.invalid/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: WINDOW },
      messages: historyChars ? [
        { role: 'assistant', content: 'x'.repeat(historyChars) },
        { role: 'user', content: 'continue' },
      ] : [],
      userMessage: options.userMessage ?? 'hi',
      systemPrompt: options.systemPrompt ?? SYSTEM_PROMPT,
      pinnedTail: [],
      mcpServers: [],
      securityMode: 'unrestricted',
    })) events.push(event);
  };
  if (options.budgetBlocked) await assert.rejects(collect, ContextBudgetExceededError);
  else if (options.unfinishedTasks) await assert.rejects(collect, PendingTasksError);
  else await collect();
  return { events, bodies };
}

test('between 0.6 and 0.8 the run is marked for a checkpoint but not compacted', async (t) => {
  const { events, bodies } = await runWithPayload(t, payloadFor(0.64, 0.78));
  const reasons = events.filter((event) => event.type === 'loop_health').map((event) => event.reason);
  assert.ok(reasons.includes('context_watermark_exceeded'), `expected the soft watermark notice, got ${reasons.join(',')}`);
  assert.ok(!reasons.includes('context_compaction_started'), 'the soft watermark must not rewrite messages');
  assert.ok(!reasons.includes('context_compaction_completed'));
  assert.equal(bodies.length, 1, 'only the model turn should reach the provider');
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].tools?.length, buildResidentTools().length, 'tools stay available below the hard watermark');
});

test('at the hard watermark the runtime compacts before the turn and keeps going', async (t) => {
  const { events, bodies } = await runWithPayload(t, payloadFor(0.85, 0.95));
  const reasons = events.filter((event) => event.type === 'loop_health').map((event) => event.reason);
  assert.ok(reasons.includes('context_compaction_started'), `expected compaction, got ${reasons.join(',')}`);
  assert.ok(reasons.includes('context_compaction_completed'), 'a successful compaction must be reported as such');
  const started = events.find((event) => event.reason === 'context_compaction_started');
  assert.match(started.detail, /attempt 1\/3/);
  assert.equal(bodies.length, 2, 'one summariser call, then the model turn');
  assert.notEqual(bodies[0].stream, true, 'the summariser is a non-streaming completion');
  assert.equal(bodies[1].stream, true);
  assert.deepEqual(bodies[1].tools, buildResidentTools());
});

test('a failed compaction above the hard watermark keeps tools when the full request fits', async (t) => {
  const { events, bodies } = await runWithPayload(t, payloadFor(0.85, 0.90), {
    invalidSummary: true,
    deltas: [
      toolCall('todo', 'planning', { action: 'update_todo', todos: [{ id: 'verify', text: 'Verify the result', status: 'pending' }] }),
      { content: 'Prematurely claiming completion' },
      toolCall('complete', 'planning', { action: 'complete' }),
      { content: 'Verified.' },
    ],
  });
  const requests = bodies.filter((body) => body.stream);
  assert.equal(requests.length, 4);
  for (const body of requests) {
    assert.deepEqual(body.tools, buildResidentTools());
    assert.ok(!JSON.stringify(body.messages).includes('Finish from the available context now'));
  }
  assert.ok(events.some((event) => event.reason === 'context_compaction_failed'));
  assert.ok(events.some((event) => event.reason === 'pending_tasks_continued'));
  assert.equal(events.filter((event) => event.type === 'tool_call_result').length, 2);
  assert.ok(events.filter((event) => event.type === 'run_status').every((event) => event.runId === 'watermark-policy'));
  assert.deepEqual(events.filter((event) => event.type === 'content').map((event) => event.content), ['Verified.']);
  assert.equal(events.at(-1)?.type, 'done');
});

test('a request that cannot fit emits a budget blocker without calling the main model', async (t) => {
  const { events, bodies } = await runWithPayload(t, 0, {
    userMessage: 'x'.repeat(WINDOW * 6),
    budgetBlocked: true,
  });
  assert.ok(events.some((event) => event.reason === 'context_budget_blocked'));
  assert.ok(!events.some((event) => event.type === 'done'));
  assert.ok(!bodies.some((body) => body.stream));
});

test('a second attempted finish with the same pending work fails without reporting done', async (t) => {
  const { events } = await runWithPayload(t, 0, {
    deltas: [
      toolCall('todo', 'planning', { action: 'update_todo', todos: [{ id: 'verify', text: 'Verify the result', status: 'pending' }] }),
      { content: 'done' },
      { content: 'still done' },
    ],
    unfinishedTasks: true,
  });
  assert.ok(events.some((event) => event.reason === 'pending_tasks_continued'));
  assert.ok(!events.some((event) => event.type === 'done' || event.type === 'content'));
});

test('one run can compact more than three times and keep doing tool work', async (t) => {
  const deltas = Array.from({ length: 7 }, (_, index) => toolCall(`todo-${index}`, 'planning', {
    action: 'update_todo',
    todos: [{ id: 'verify', text: 'Verify the result', status: 'in_progress' }],
    note: 'x'.repeat(9_500),
  }));
  const { events, bodies } = await runWithPayload(t, 0, {
    deltas: [...deltas, toolCall('complete', 'planning', { action: 'complete' })],
  });
  assert.ok(events.filter((event) => event.reason === 'context_compaction_completed').length > 3);
  assert.equal(events.filter((event) => event.type === 'tool_call_result').length, 8);
  assert.ok(bodies.filter((body) => body.stream).every((body) => body.tools?.length));
  assert.equal(events.at(-1)?.type, 'done');
});

test('compaction that still leaves the request above the hard watermark runs with tools', async (t) => {
  // The original 0.84-0.86 fixture landed 15 tokens over the 16000 context limit after
  // compaction (runtime correctly refuses to send it). Keep the intended band "above
  // hard watermark, below limit" by lowering the fixture; the runtime limit is unchanged.
  const { events, bodies } = await runWithPayload(t, 9_000, {
    systemPrompt: 'x'.repeat(payloadFor(0.82, 0.84)),
    userMessage: 'Complete and verify the outstanding task.',
    deltas: [
      toolCall('todo-complete', 'planning', { action: 'complete' }),
      { content: 'Verified.' },
    ],
  });
  const completed = events.find((event) => event.reason === 'context_compaction_completed');
  assert.match(completed?.detail ?? '', /ratio=(?:8\d|9\d|100)%/);
  assert.ok(events.filter((event) => event.reason === 'context_compaction_started').length >= 2);
  const mainRequests = bodies.filter((body) => body.stream);
  assert.equal(mainRequests.length, 2);
  assert.deepEqual(mainRequests[0].tools, buildResidentTools());
  assert.ok(mainRequests[0].messages.some((message: any) => message.role === 'user' && message.content === 'Complete and verify the outstanding task.'));
  assert.ok(events.some((event) => event.type === 'tool_call_result' && event.tool_name === 'planning'));
  assert.equal(events.at(-1)?.type, 'done');
});

test('budget exhaustion is persisted as failed and writes a recovery checkpoint', async (t) => {
  const project = createTempProject('watermark-budget-blocked');
  const conversation = createConversation({ title: 'Budget blocker', projectPath: project.projectPath });
  t.after(() => {
    deleteConversation(conversation.id);
    project.cleanup();
  });
  t.mock.method(agentContextResolver, 'resolve', () => ({
    agent: { id: 'pi', name: 'PI', role: 'pi' },
    llm: { baseUrl: 'http://invalid.test/v1', apiKey: 'unused', model: 'test', contextWindowTokens: WINDOW },
    coreTools: [], mcpServers: [], skills: [], workspace: null,
    systemPrompt: SYSTEM_PROMPT, systemPromptSections: [], pinnedTail: [], info: '',
  } as unknown as AgentRuntimeContext));
  const events: Array<{ type: string; status?: string; stopReason?: string | null; runId?: string | null }> = [];
  await new AgentService().runCompletion({
    conversationId: conversation.id,
    message: 'x'.repeat(WINDOW * 6),
  }, { isOpen: () => true, emit: (event) => { events.push(event); } });
  const failed = events.find((event) => event.type === 'run_status' && event.status === 'failed');
  assert.ok(failed?.runId);
  assert.equal(failed.stopReason, 'budget_exceeded');
  assert.equal(getAgentRun(conversation.id, failed.runId)?.stopReason, 'budget_exceeded');
  assert.equal(getLatestContextCheckpoint(conversation.id)?.triggerReason, 'context_budget_blocked');
  assert.ok(!events.some((event) => event.type === 'done' || event.status === 'completed'));
});
