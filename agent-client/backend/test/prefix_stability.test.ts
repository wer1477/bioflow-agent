import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { listContextMessages } from '../src/agent/config/context_message_store.js';
import { createWorkspaceArtifact } from '../src/agent/config/workspace_artifact_store.js';
import { extractPinnedRuntimeBlocks } from '../src/agent/context_manager.js';
import { agentContextResolver, buildPinnedTail } from '../src/agent/service/agent_context_resolver.js';
import { createTempProject } from './helpers/project_fixture.js';

// `toLlmConfig` interpolates the provider's `${BIOFLOW_LLM_API_KEY_*}` reference and tests
// never load `backend/.env`; the value itself is unused here.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * The property the whole design rests on: `messages[0]` must be the same bytes for every
 * run of a conversation. A provider prefix cache only matches from token 0, so a date or an
 * artifact appearing in the system prompt would invalidate the entire history behind it on
 * the next run.
 */
test('the system prompt is byte-identical across runs and carries no volatile content', () => {
  const project = createTempProject('prefix-stability');
  const conversation = createConversation({ title: 'prefix', projectPath: project.projectPath });
  try {
    createWorkspaceArtifact({
      conversationId: conversation.id,
      scope: 'execution',
      planId: null,
      executionId: null,
      type: 'table',
      title: 'summary.tsv',
      path: 'results/summary.tsv',
      mimeType: 'text/tab-separated-values',
      summary: 'a'.repeat(64),
      tags: [],
      status: 'ready',
      createdByAgentId: 'pi',
      metadata: {},
    });

    const first = agentContextResolver.resolve({ conversationId: conversation.id, agentId: 'pi' });
    const second = agentContextResolver.resolve({ conversationId: conversation.id, agentId: 'pi' });

    assert.equal(sha256(first.systemPrompt), sha256(second.systemPrompt), 'messages[0] must not drift between runs');
    assert.doesNotMatch(first.systemPrompt, /Current date:/, 'the date belongs to the volatile tail');
    assert.doesNotMatch(first.systemPrompt, /Recent project artifacts/, 'the artifact map belongs to the volatile tail');
    assert.match(first.systemPrompt, /<pinned_project_workspace>/, 'the stable path rules stay in the system prompt');
    assert.match(first.systemPrompt, /<tool_library_domains>/, 'the static domain index stays in the system prompt');

    const tail = first.pinnedTail.join('\n');
    assert.match(tail, /^<runtime_context_snapshot>\nCurrent date: /);
    assert.match(tail, /<recent_project_artifacts>/);
    assert.match(tail, /results\/summary\.tsv/);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a conversation without artifacts still gets the date snapshot, and nothing else', () => {
  assert.equal(buildPinnedTail(null).length, 1);
  assert.match(buildPinnedTail(null)[0], /^<runtime_context_snapshot>/);
});

/**
 * The tail used to live only in the live message array: run N sent `[S, H, P, U]` while run
 * N+1 replayed `[S, H, U, …]`, so the two diverged immediately after `H` and everything the
 * previous run produced was pre-filled again. Persisting the blocks keeps the stream
 * continuous across run boundaries.
 */
test('the pinned tail is persisted where it is sent, so the next run continues the prefix', () => {
  const project = createTempProject('prefix-tail-persisted');
  const conversation = createConversation({ title: 'tail', projectPath: project.projectPath });
  try {
    const first = agentContextResolver.resolve({ conversationId: conversation.id, agentId: 'pi' });
    assert.ok(first.pinnedTail.length > 0, 'the fixture must produce a tail');

    agentContextResolver.appendPinnedTail(conversation.id, 'run-1', first.pinnedTail);
    agentContextResolver.appendUserContextMessage(conversation.id, 'run-1', 'analyse this');

    const replay = listContextMessages(conversation.id).map((row) => String(row.content));
    assert.deepEqual(replay, [...first.pinnedTail, 'analyse this']);
    // Byte-identical to what the first run sent: that is what makes it a prefix, not merely
    // a similar-looking array.
    assert.deepEqual(replay.slice(0, first.pinnedTail.length), first.pinnedTail);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

/**
 * Compaction used to summarise whatever sat in the cold segment. The runtime snapshot is an
 * exact fact (today's date, where the files are), so it is lifted out instead.
 */
test('compaction keeps the runtime snapshot out of the summary source', () => {
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: '<runtime_context_snapshot>\nCurrent date: 2026-10-31\n</runtime_context_snapshot>' },
    { role: 'user', content: '<recent_project_artifacts>\n- a.tsv: results/a.tsv\n</recent_project_artifacts>' },
    { role: 'user', content: 'newest question' },
  ];

  const { rest, preserved } = extractPinnedRuntimeBlocks(messages);
  assert.equal(preserved.length, 2);
  assert.equal(rest.length, 3);
  assert.match(String(preserved[0].content), /runtime_context_snapshot/);
  assert.match(String(preserved[1].content), /recent_project_artifacts/);
  assert.ok(rest.every((message) => typeof message.content === 'string' && !message.content.startsWith('<runtime_context')));
});

/** Repeated compactions must not accumulate copies of the same per-run block. */
test('only the last copy of each pinned block survives repeated extraction', () => {
  const snapshot = { role: 'user', content: '<runtime_context_snapshot>\nCurrent date: 2026-10-30\n</runtime_context_snapshot>' };
  const { preserved } = extractPinnedRuntimeBlocks([
    snapshot,
    { role: 'user', content: 'question' },
    { role: 'user', content: '<runtime_context_snapshot>\nCurrent date: 2026-10-31\n</runtime_context_snapshot>' },
  ]);
  assert.equal(preserved.length, 1);
  assert.match(String(preserved[0].content), /2026-10-31/);
});

/**
 * End-to-end half: the resolver's volatile blocks must reach the request at the tail. If the
 * runtime put them anywhere before the history, the previous test's stability guarantee
 * would be pointless.
 */
test('the runtime appends volatile blocks after history and before the user message', async (t) => {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const runtime = new AgentRuntime({
    async connectServers() {
      return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] };
    },
  } as any);

  const prompt = 'You are a test agent.';
  for await (const _event of runtime.chat({
    runId: crypto.randomUUID(),
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: 128_000 },
    messages: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ],
    userMessage: 'hi',
    systemPrompt: prompt,
    systemPromptSections: [{ kind: 'agent-prompt', source: 'test', start: 0, end: prompt.length }],
    pinnedTail: ['<runtime_context_snapshot>\nCurrent date: 2026-10-31\n</runtime_context_snapshot>'],
    mcpServers: [],
  })) {
    // Drain the run; the recorded request body is the assertion target.
  }

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].messages.map((message: any) => message.role), ['system', 'user', 'assistant', 'user', 'user']);
  assert.match(bodies[0].messages[3].content, /^<runtime_context_snapshot>/);
  assert.equal(bodies[0].messages[4].content, 'hi');
});
