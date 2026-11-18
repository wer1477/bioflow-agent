import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeSubagent,
  setSubagentRunnerForTests,
} from '../src/agent/core_tools/subagent_executor.js';
import { subagentRuntime } from '../src/agent/core_tools/subagent_runtime.js';
import { listContextMessages } from '../src/agent/config/context_message_store.js';
import {
  createConversation,
  createMessage,
  deleteConversation,
  getAllConversations,
} from '../src/agent/config/conversation_service.js';
import { createAgentRun, updateAgentRun } from '../src/agent/config/run_store.js';
import { createTempProject } from './helpers/project_fixture.js';
import {
  buildAllCoreTools,
  buildCoreToolsPrompt,
  getCoreToolForCall,
  getCoreToolRisk,
} from '../src/agent/core_tools_runtime.js';

/**
 * The delegation lifecycle without a live model: a stub child runner drives the same
 * path the real `agentService.runCompletion` uses, so conversation creation, the
 * concurrency/depth gates, notices, cancellation and status reads stay under test.
 */

interface Fixture {
  projectPath: string;
  parentId: string;
  cleanup: () => void;
}

function fixture(label: string): Fixture {
  const project = createTempProject(label);
  const parent = createConversation({ title: 'parent', projectPath: project.projectPath });
  return {
    projectPath: project.projectPath,
    parentId: parent.id,
    cleanup: () => {
      subagentRuntime.resetForTests();
      setSubagentRunnerForTests(null);
      for (const conversation of getAllConversations()) {
        if (conversation.id === parent.id || conversation.parentConversationId === parent.id) {
          deleteConversation(conversation.id);
        }
      }
      project.cleanup();
    },
  };
}

function startArgs(description = 'sample qc', task = 'Check the sample.') {
  return { action: 'start' as const, description, task };
}

function contextOf(fixtureValue: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    conversationId: fixtureValue.parentId,
    projectPath: fixtureValue.projectPath,
    delegationDepth: 0,
    ...overrides,
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for a subagent notice');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function childNotice(fixtureValue: Fixture): string | undefined {
  return listContextMessages(fixtureValue.parentId)
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .find((content) => content.startsWith('[subagent'));
}

test('the subagent tool is registered with a schema, guidance, and a code-execution risk', () => {
  const schema = buildAllCoreTools().find((tool) => tool.function.name === 'subagent');
  assert.ok(schema, 'subagent must be one of the resident core tool schemas');
  assert.match(schema.function.description || '', /child agent/);
  assert.equal(getCoreToolForCall('subagent')?.id, 'subagent');
  assert.equal(getCoreToolRisk('subagent'), 'code_execution');
  const prompt = buildCoreToolsPrompt(['subagent']);
  assert.ok(prompt && prompt.includes('Subagent delegation is enabled'));
});

test('delegation depth is enforced before any child conversation exists', async () => {
  const previous = process.env.BIOFLOW_SUBAGENT_MAX_DEPTH;
  process.env.BIOFLOW_SUBAGENT_MAX_DEPTH = '1';
  const fx = fixture('subagent-depth');
  try {
    const result = JSON.parse(await executeSubagent(
      startArgs(),
      contextOf(fx, { delegationDepth: 1 }),
    ));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'subagent_depth_exceeded');
    assert.equal(getAllConversations().filter((item) => item.parentConversationId === fx.parentId).length, 0);
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_SUBAGENT_MAX_DEPTH;
    else process.env.BIOFLOW_SUBAGENT_MAX_DEPTH = previous;
    fx.cleanup();
  }
});

test('start rejects incomplete arguments and unknown actions', async () => {
  const fx = fixture('subagent-args');
  try {
    const missingTask = JSON.parse(await executeSubagent(
      { action: 'start', description: 'only a label' },
      contextOf(fx),
    ));
    assert.equal(missingTask.error.code, 'invalid_arguments');

    const missingDescription = JSON.parse(await executeSubagent(
      { action: 'start', task: 'only a task' },
      contextOf(fx),
    ));
    assert.equal(missingDescription.error.code, 'invalid_arguments');

    const unknownAction = JSON.parse(await executeSubagent({ action: 'delegate' }, contextOf(fx)));
    assert.equal(unknownAction.error.code, 'invalid_arguments');
  } finally {
    fx.cleanup();
  }
});

test('start creates a linked child conversation and delivers one completion notice', async () => {
  const previousConcurrent = process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT;
  process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT = '2';
  const fx = fixture('subagent-complete');
  try {
    setSubagentRunnerForTests(async (_request, sink) => {
      sink.emit({ type: 'content', content: 'child final answer' });
    });
    subagentRuntime.registerParentRun(fx.parentId);

    const started = JSON.parse(await executeSubagent(startArgs('region scan', 'Scan the region.'), contextOf(fx)));
    assert.equal(started.ok, true);
    assert.equal(started.action, 'start');
    assert.equal(started.subagent.status, 'running');

    const child = getAllConversations().find((item) => item.id === started.subagent.conversationId);
    assert.ok(child);
    assert.equal(child.parentConversationId, fx.parentId);
    assert.equal(child.subagentDepth, 1);
    assert.equal(child.title, 'Subagent · region scan');

    const notice = await waitFor(() => childNotice(fx));
    assert.match(notice, /^\[subagent completed\] "region scan"/);
    assert.match(notice, /child final answer/);

    const queued = subagentRuntime.drainNotices(fx.parentId);
    assert.equal(queued.length, 1);
    assert.match(queued[0], /^\[subagent completed\]/);
    assert.equal(subagentRuntime.drainNotices(fx.parentId).length, 0, 'draining twice must not replay a notice');
  } finally {
    if (previousConcurrent === undefined) delete process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT;
    else process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT = previousConcurrent;
    fx.cleanup();
  }
});

test('a second start is refused while the concurrency limit is reached', async () => {
  const previousConcurrent = process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT;
  process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT = '1';
  const fx = fixture('subagent-busy');
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    setSubagentRunnerForTests(async () => held);
    const first = JSON.parse(await executeSubagent(startArgs('first', 'First task.'), contextOf(fx)));
    assert.equal(first.ok, true);

    const second = JSON.parse(await executeSubagent(startArgs('second', 'Second task.'), contextOf(fx)));
    assert.equal(second.ok, false);
    assert.equal(second.error.code, 'subagent_busy');
    assert.equal(getAllConversations().filter((item) => item.parentConversationId === fx.parentId).length, 1);
  } finally {
    release();
    if (previousConcurrent === undefined) delete process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT;
    else process.env.BIOFLOW_SUBAGENT_MAX_CONCURRENT = previousConcurrent;
    fx.cleanup();
  }
});

test('cancel aborts the child and reports a cancelled notice', async () => {
  const fx = fixture('subagent-cancel');
  try {
    setSubagentRunnerForTests(async (request) => {
      await new Promise((_resolve, reject) => {
        request.abortSignal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });

    const started = JSON.parse(await executeSubagent(startArgs('long job', 'Run the long job.'), contextOf(fx)));
    assert.equal(started.ok, true);

    const cancelled = JSON.parse(await executeSubagent(
      { action: 'cancel', conversation_id: started.subagent.conversationId },
      contextOf(fx),
    ));
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.cancelled, true);

    const notice = await waitFor(() => childNotice(fx));
    assert.match(notice, /^\[subagent cancelled\] "long job"/);
  } finally {
    fx.cleanup();
  }
});

test('aborting the parent run cancels its child', async () => {
  const fx = fixture('subagent-parent-abort');
  const parentRun = new AbortController();
  try {
    setSubagentRunnerForTests(async (request) => {
      await new Promise((_resolve, reject) => {
        request.abortSignal?.addEventListener('abort', () => reject(new Error('parent cancelled')), { once: true });
      });
    });

    const started = JSON.parse(await executeSubagent(
      startArgs('inherited job', 'Work while the parent runs.'),
      contextOf(fx, { abortSignal: parentRun.signal }),
    ));
    assert.equal(started.ok, true);

    parentRun.abort();
    const notice = await waitFor(() => childNotice(fx));
    assert.match(notice, /^\[subagent cancelled\] "inherited job"/);
  } finally {
    fx.cleanup();
  }
});

test('status and result read a finished child from its own conversation', async () => {
  const fx = fixture('subagent-status');
  try {
    const child = createConversation({
      title: 'Subagent · finished',
      projectPath: fx.projectPath,
      parentConversationId: fx.parentId,
      subagentDepth: 1,
      subagentDescription: 'finished',
    });
    createMessage({ conversationId: child.id, role: 'assistant', content: 'durable child output', toolCalls: null });
    const run = createAgentRun({ conversationId: child.id });
    updateAgentRun(child.id, run.id, { status: 'completed', completedAt: new Date().toISOString() });

    const status = JSON.parse(await executeSubagent({ action: 'status' }, contextOf(fx)));
    assert.equal(status.ok, true);
    assert.equal(status.subagents.length, 1);
    assert.equal(status.subagents[0].status, 'completed');
    assert.equal(status.subagents[0].description, 'finished');

    const result = JSON.parse(await executeSubagent(
      { action: 'result', conversation_id: child.id },
      contextOf(fx),
    ));
    assert.equal(result.ok, true);
    assert.equal(result.output, 'durable child output');

    const foreign = JSON.parse(await executeSubagent(
      { action: 'result', conversation_id: fx.parentId },
      contextOf(fx),
    ));
    assert.equal(foreign.error.code, 'subagent_not_found');
  } finally {
    fx.cleanup();
  }
});

test('a completed child that finished while the parent was idle is not queued', async () => {
  const fx = fixture('subagent-idle');
  try {
    setSubagentRunnerForTests(async (_request, sink) => {
      sink.emit({ type: 'content', content: 'idle parent answer' });
    });
    const started = JSON.parse(await executeSubagent(startArgs('idle job', 'Finish later.'), contextOf(fx)));
    assert.equal(started.ok, true);

    const notice = await waitFor(() => childNotice(fx));
    assert.match(notice, /idle parent answer/);
    assert.equal(subagentRuntime.drainNotices(fx.parentId).length, 0, 'no parent run is live, so nothing may be injected');
  } finally {
    fx.cleanup();
  }
});
