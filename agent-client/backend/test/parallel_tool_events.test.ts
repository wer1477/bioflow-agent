import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent_runtime.js';
import { createConversation, deleteConversation } from '../src/agent/config/conversation_service.js';
import { createTempProject } from './helpers/project_fixture.js';

test('parallel CoreTools emit each result event exactly once', async () => {
  const project = createTempProject('parallel-events');
  const conversation = createConversation({ title: 'parallel-events', projectPath: project.projectPath });
  const calls = [
    { index: 0, id: 'call-a', type: 'function', function: { name: 'planning', arguments: JSON.stringify({ action: 'update_todo', todos: [{ id: 'a', text: 'A', status: 'completed' }] }) } },
    { index: 1, id: 'call-b', type: 'function', function: { name: 'planning', arguments: JSON.stringify({ action: 'update_todo', todos: [{ id: 'b', text: 'B', status: 'completed' }] }) } },
  ];
  const originalFetch = globalThis.fetch;
  let turn = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.stream) {
      turn += 1;
      const payload = turn === 1
        ? { choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] }
        : { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    const runtime = new AgentRuntime({
      async connectServers() {
        return { tools: [], serverCatalog: [], connected: [], failed: [], disconnected: [] };
      },
    } as never);
    const events: any[] = [];
    for await (const event of runtime.chat({
      runId: crypto.randomUUID(),
      conversationId: conversation.id,
      llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'unused', model: 'parallel-test', contextWindowTokens: 20_000 },
      messages: [],
      userMessage: 'write two files',
      systemPrompt: 'system',
      pinnedTail: [],
      mcpServers: [],
      securityMode: 'unrestricted',
      mainAgent: { id: 'pi', name: 'PI', coreToolIds: ['planning'], knowledgeEntryIds: [] } as never,
    })) events.push(event);
    const starts = events.filter((event) => event.type === 'tool_call_start' && event.tool_name === 'planning');
    const results = events.filter((event) => event.type === 'tool_call_result' && event.tool_name === 'planning');
    const panels = events.filter((event) => event.type === 'planning_panel');
    assert.equal(starts.length, 2);
    assert.equal(results.length, 2);
    assert.equal(panels.length, 2, `expected one planning event per parallel call, got ${panels.length}`);
  } finally {
    globalThis.fetch = originalFetch;
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
