import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import conversationsRouter from '../src/http/routes/conversations.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { TEAM_ROLE_IDS } from '../src/agent/config/agent_config_store.js';
import { executeTeamMessage } from '../src/agent/core_tools/team_message_executor.js';
import { drainTeamMessages } from '../src/agent/team/message_bus.js';
import { readTeamState } from '../src/agent/team/team_service.js';
import { createTempProject } from './helpers/project_fixture.js';

/** Streams one OpenAI-shaped chunk list, then closes. */
function writeChunks(response: import('node:http').ServerResponse, chunks: Array<Record<string, unknown>>, finishReason: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const delta of chunks) {
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

/**
 * Scripted provider: call 1 makes the lead dispatch to Searcher, call 2 closes the lead's
 * turn, call 3 is Searcher answering, call 4 is the lead accepting.
 */
async function startDispatchProvider(): Promise<{ server: Server; baseUrl: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls += 1;
      if (calls === 1) {
        writeChunks(response, [{
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_dispatch_1',
            type: 'function',
            function: {
              name: 'team_message',
              arguments: JSON.stringify({ action: 'delegate', to: 'searcher', task: '找三篇 2024 年后的综述', expect: '三篇带 DOI 的文献' }),
            },
          }],
        }], 'tool_calls');
        return;
      }
      const content = calls === 2
        ? '已派发给 Searcher，等待结果。'
        : calls === 3
          ? 'Searcher 的三篇文献结论：A、B、C。'
          : '验收通过，结论与产物如上。';
      writeChunks(response, [{ role: 'assistant', content }], 'stop');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, calls: () => calls };
}

async function withTeamConfig<T>(baseUrl: string, callback: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bioflow-dispatch-config-'));
  const previous = process.env.BIOFLOW_CONFIG_DIR;
  process.env.BIOFLOW_CONFIG_DIR = dir;
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(dir, 'llm.json'), JSON.stringify([{
    id: 'test', name: 'Test', baseUrl, model: 'test-model', apiKey: 'unused', isDefault: true, contextWindowTokens: 100_000,
  }]), 'utf8');
  await writeFile(path.join(dir, 'agents.json'), JSON.stringify({
    schemaVersion: 2,
    team: {
      leadRoleId: 'pi',
      roles: [...TEAM_ROLE_IDS],
      router: { engine: 'always-pi', fallbackRoleId: 'pi' },
      limits: { maxConcurrentDispatches: 3 },
    },
    agents: TEAM_ROLE_IDS.map((role) => ({
      id: role,
      name: role,
      label: role,
      description: '',
      orchestratorDescription: '',
      promptFile: `prompts/${role}.md`,
      llmProviderId: 'test',
      securityMode: 'unrestricted',
      // Only the lead may send team messages.
      coreToolIds: role === 'pi' ? ['team_message'] : [],
      knowledgeEntryIds: [],
      mcpServerIds: [],
      skillIds: [],
      createdAt: now,
      updatedAt: now,
    })),
  }), 'utf8');
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.BIOFLOW_CONFIG_DIR;
    else process.env.BIOFLOW_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function readNdjson(text: string): Array<Record<string, unknown>> {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

test('only the lead may send team messages, and only to another known role', async (t) => {
  const project = createTempProject('dispatch-guard');
  t.after(() => project.cleanup());
  const root = createConversation({ title: 'team', projectPath: project.projectPath });

  const asSearcher = await executeTeamMessage(
    { action: 'delegate', to: 'writer', task: 'x' },
    { conversationId: root.id, agent: { id: 'searcher', role: 'searcher' } as never },
  );
  assert.match(asSearcher, /action_not_allowed/);

  // A delegated child of the lead keeps the lead profile but not the authority: the queue it
  // would write is drained only by the lead's own team run.
  const asChild = await executeTeamMessage(
    { action: 'delegate', to: 'writer', task: 'x' },
    { conversationId: root.id, agent: { id: 'pi', role: 'pi' } as never, delegationDepth: 1 },
  );
  assert.match(asChild, /messages_not_allowed/);
  assert.deepEqual(drainTeamMessages(root.id), [], 'a refused dispatch must not queue anything');

  const unknown = await executeTeamMessage(
    { action: 'delegate', to: 'hacker', task: 'x' },
    { conversationId: root.id, agent: { id: 'pi', role: 'pi' } as never },
  );
  assert.match(unknown, /unknown_role/);

  const self = await executeTeamMessage(
    { action: 'delegate', to: 'pi', task: 'x' },
    { conversationId: root.id, agent: { id: 'pi', role: 'pi' } as never },
  );
  assert.match(self, /self_message/);

  const noTask = await executeTeamMessage(
    { action: 'delegate', to: 'writer' },
    { conversationId: root.id, agent: { id: 'pi', role: 'pi' } as never },
  );
  assert.match(noTask, /task_required/);

  const badAction = await executeTeamMessage(
    { action: 'forward', to: 'writer', content: 'x' },
    { conversationId: root.id, agent: { id: 'pi', role: 'pi' } as never },
  );
  assert.match(badAction, /action_not_allowed/);
});

test('the lead dispatches, the role runs in its own session and the lead accepts', async (t) => {
  const provider = await startDispatchProvider();
  t.after(() => provider.server.close());

  await withTeamConfig(provider.baseUrl, async () => {
    const project = createTempProject('dispatch-e2e');
    t.after(() => project.cleanup());
    const root = createConversation({ title: 'team', projectPath: project.projectPath });

    const app = express();
    app.use(express.json());
    app.use('/api/conversations', conversationsRouter);
    const server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created));
    });
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations/${root.id}/team/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '帮我找三篇综述' }),
    });
    assert.equal(response.status, 200);
    const events = readNdjson(await response.text());

    const switches = events.filter((event) => event.type === 'role_switch');
    assert.deepEqual(switches.map((event) => [event.fromRoleId, event.toRoleId]), [
      ['pi', 'searcher'],
      ['searcher', 'pi'],
    ], 'out to the role, then back to the lead');

    const cards = events.filter((event) => event.type === 'handoff_card');
    assert.equal(cards.length, 1);
    assert.equal((cards[0].card as { fromRole: string }).fromRole, 'searcher');

    const state = readTeamState(root.id);
    assert.equal(state.cards.length, 1);
    assert.equal(state.cards[0].fromRole, 'searcher');
    assert.match(state.cards[0].summary, /三篇文献/);
    assert.equal(state.activeRoleId, 'pi', 'the lead holds the team when the turn ends');
    assert.ok(provider.calls() >= 3, 'the role really ran');

    deleteConversation(root.id);
  });
});
