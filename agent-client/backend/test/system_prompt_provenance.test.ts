import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation, getMessages } from '../src/agent/config/conversation_service.js';
import { agentContextResolver } from '../src/agent/service/agent_context_resolver.js';
import { PersistedRunState } from '../src/agent/service/agent_service.js';
import { readTranscript } from '../src/agent/transcript_reader.js';
import { createTranscriptRecorder } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The resolver builds an LLM config, and `toLlmConfig` interpolates the provider's
// `${BIOFLOW_LLM_API_KEY_*}` reference. Tests do not load `backend/.env`, so give the
// configured providers something to resolve — the key value is never used here.
for (const name of ['BIOFLOW_LLM_API_KEY_DGX', 'BIOFLOW_LLM_API_KEY_D1']) {
  process.env[name] ||= 'test-key';
}

/**
 * The assembled system prompt is recorded verbatim in `messages[0]`, so provenance is only
 * useful if the recorded offsets slice that exact string. These tests pin that contract —
 * a section list that drifts from the text would attribute the wrong lines to the wrong
 * source, which is worse than showing no provenance at all.
 */
test('recorded sections slice the assembled prompt exactly, in order and without overlap', () => {
  const project = createTempProject('system-prompt-provenance');
  const conversation = createConversation({ title: 'provenance', projectPath: project.projectPath });
  try {
    const context = agentContextResolver.resolve({ conversationId: conversation.id, agentId: 'pi' });
    const { systemPrompt, systemPromptSections } = context;

    assert.ok(systemPrompt.length > 0);
    assert.ok(systemPromptSections.length >= 3, `expected several sections, saw ${systemPromptSections.length}`);

    let cursor = 0;
    for (const [index, section] of systemPromptSections.entries()) {
      // Sections are laid out left to right over the joined text, separated by a blank line.
      assert.equal(section.start, cursor, `section ${index} (${section.kind}) must start where the previous one ended`);
      assert.ok(section.end > section.start, `section ${index} (${section.kind}) must not be empty`);
      const slice = systemPrompt.slice(section.start, section.end);
      assert.ok(slice.trim().length > 0, `section ${index} (${section.kind}) sliced to whitespace`);
      assert.ok(section.source.length > 0, `section ${index} (${section.kind}) must name a source`);
      cursor = section.end + '\n\n'.length;
    }
    assert.equal(cursor, systemPrompt.length + '\n\n'.length, 'sections must cover the whole prompt');
    // Blocks are separated by exactly one blank line. A prompt file ends with a newline, so
    // an untrimmed block would silently add a third one and change what the model sees.
    assert.doesNotMatch(systemPrompt, /\n{3,}/);

    // The agent prompt section is the config file the profile was read from — this is the
    // attribution the UI shows, so it has to be the real thing.
    const agentPrompt = systemPromptSections.find((section) => section.kind === 'agent-prompt');
    assert.ok(agentPrompt);
    assert.equal(agentPrompt.source, 'prompts/pi.md');
    assert.equal(
      systemPrompt.slice(agentPrompt.start, agentPrompt.end),
      fs.readFileSync(path.join(backendRoot, 'config/prompts/pi.md'), 'utf8').trim(),
    );
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

/**
 * The domain layer of the tool library is small and static, so it ships as prompt context
 * instead of costing a discovery turn. L2 catalogs and bodies stay behind the tools.
 */
test('the system prompt preloads the tool library domain index', () => {
  const project = createTempProject('system-prompt-toollibrary');
  const conversation = createConversation({ title: 'toollibrary', projectPath: project.projectPath });
  try {
    const context = agentContextResolver.resolve({ conversationId: conversation.id, agentId: 'pi' });
    const section = context.systemPromptSections.find((item) => item.kind === 'tool-library');
    assert.ok(section, 'the tool library section must be attributed');
    assert.equal(section.source, 'toollibrary/index.md');

    const block = context.systemPrompt.slice(section.start, section.end);
    assert.match(block, /^<tool_library_domains>\n/);
    assert.match(block, /\n<\/tool_library_domains>$/);

    const libraryRoot = path.join(backendRoot, '..', 'toollibrary');
    const domains = fs.readdirSync(libraryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
    assert.ok(domains.length >= 5);
    for (const domain of domains) {
      assert.ok(block.includes(`- ${domain}：`), `domain '${domain}' must be preloaded`);
    }
    assert.doesNotMatch(block, /Unclassified/, 'the runtime fallback domain is not static prompt content');
    assert.doesNotMatch(block, /warning/i, 'warnings belong to tool results, not the prompt');
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

/**
 * The read side must hand back the prompt the request actually sent. The text is sliced out
 * of the recorded `messages[0]` rather than stored twice, so this also pins that the
 * provenance survives the write/read round trip.
 */
test('a run reports the system prompt its first request sent', () => {
  const project = createTempProject('system-prompt-roundtrip');
  const conversation = createConversation({ title: 'roundtrip', projectPath: project.projectPath });
  try {
    const prompt = 'You are a test agent.\n\nBe brief.';
    const sections = [
      { kind: 'agent-prompt' as const, source: 'prompts/pi.md', start: 0, end: 21 },
      { kind: 'agent-guidance' as const, source: 'agent_context_resolver.ts (built-in guidance)', start: 23, end: prompt.length },
    ];

    const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });
    const runId = runState.runId;
    assert.ok(runId);
    const transcript = createTranscriptRecorder(conversation.id, runId);
    assert.ok(transcript);
    runState.attachTranscript(transcript);

    transcript.recordModelRequest({
      requestId: 'request-1',
      turnIndex: 0,
      llm: { baseUrl: 'http://example.invalid/v1', model: 'test' },
      maxOutputTokens: 4096,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'hi' }],
      tools: null,
      systemPrompt: { sha256: crypto.createHash('sha256').update(prompt).digest('hex'), sections },
    });
    transcript.recordModelResponse({ requestId: 'request-1', turnIndex: 0, content: 'ok', toolCalls: [], finishReason: 'stop' });
    runState.persist('completed');

    const message = getMessages(conversation.id).find((item) => item.toolCalls?.run?.runId === runId);
    assert.ok(message);
    const recorded = message.toolCalls?.run?.systemPrompt;
    assert.ok(recorded, 'the read path must attach the run system prompt');
    assert.equal(recorded.text, prompt);
    assert.equal(recorded.sha256, crypto.createHash('sha256').update(prompt).digest('hex'));
    assert.deepEqual(recorded.sections, sections);

    // A run recorded without provenance stays readable: no prompt, no error.
    assert.equal(sections.length, recorded.sections.length);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a run recorded before provenance existed reports no system prompt', () => {
  const project = createTempProject('system-prompt-legacy');
  const conversation = createConversation({ title: 'legacy', projectPath: project.projectPath });
  try {
    const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });
    const runId = runState.runId;
    assert.ok(runId);
    const transcript = createTranscriptRecorder(conversation.id, runId);
    assert.ok(transcript);
    runState.attachTranscript(transcript);

    transcript.recordModelRequest({
      requestId: 'request-1',
      turnIndex: 0,
      llm: { baseUrl: 'http://example.invalid/v1', model: 'test' },
      maxOutputTokens: 4096,
      messages: [{ role: 'system', content: 'legacy prompt' }, { role: 'user', content: 'hi' }],
      tools: null,
    });
    transcript.recordModelResponse({ requestId: 'request-1', turnIndex: 0, content: 'ok', toolCalls: [], finishReason: 'stop' });
    runState.persist('completed');

    const message = getMessages(conversation.id).find((item) => item.toolCalls?.run?.runId === runId);
    assert.ok(message);
    assert.equal(message.toolCalls?.run?.systemPrompt, undefined);
    // The run's events still come back — a missing prompt degrades one row, not the trace.
    assert.ok(Array.isArray(message.toolCalls?.run?.events));
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

/**
 * The link between the two halves: the runtime is the only writer of `model_request`, so the
 * provenance has to survive being handed from the resolver through the chat request into the
 * log. Everything downstream of that is covered by the two tests above.
 */
test('the runtime records the prompt provenance it was handed', async (t) => {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const project = createTempProject('system-prompt-runtime');
  const conversation = createConversation({ title: 'runtime provenance', projectPath: project.projectPath });
  t.after(() => {
    deleteConversation(conversation.id);
    project.cleanup();
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const prompt = 'You are a test agent.';
  const sections = [{ kind: 'agent-prompt' as const, source: 'prompts/pi.md', start: 0, end: prompt.length }];
  const runId = crypto.randomUUID();

  const runtime = new AgentRuntime({ async connectServers() { return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] }; } } as any);
  for await (const _event of runtime.chat({
    runId,
    llm: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused', model: 'test', contextWindowTokens: 128_000 },
    messages: [],
    userMessage: 'hi',
    systemPrompt: prompt,
    systemPromptSections: sections,
    conversationId: conversation.id,
    mcpServers: [],
  })) {
    // Drain the run; the recorded request is the assertion target.
  }

  const request = readTranscript(conversation.id, { runId, unlimited: true }).events.find((record) => record.type === 'model_request');
  assert.ok(request, 'the run must have recorded a model request');
  const data = request.data as { messages?: Array<{ role: string; content: string }>; systemPrompt?: { sha256: string; sections: unknown[] } };
  assert.equal(data.messages?.[0]?.content, prompt, 'the prompt text stays in messages[0], not duplicated');
  assert.ok(data.systemPrompt, 'the runtime must record prompt provenance');
  assert.equal(data.systemPrompt.sha256, crypto.createHash('sha256').update(prompt).digest('hex'));
  assert.deepEqual(data.systemPrompt.sections, sections);
});
