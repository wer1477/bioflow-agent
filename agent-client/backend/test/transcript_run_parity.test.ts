import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readRecord } from '../src/agent/config/conversation_file_store.js';
import { createConversation, deleteConversation, getMessages } from '../src/agent/config/conversation_service.js';
import type { StoredRunState } from '../src/agent/config/conversation_types.js';
import { PersistedRunState } from '../src/agent/service/agent_service.js';
import { readTranscript, toAgentEvents, type ReconstructedAgentEvent } from '../src/agent/transcript_reader.js';
import { createTranscriptRecorder, getTranscriptEventsPath } from '../src/agent/transcript_store.js';
import { createTempProject } from './helpers/project_fixture.js';

/** The run state exactly as it sits in the session record on disk. */
function storedRun(conversationId: string): StoredRunState {
  const run = readRecord(conversationId)?.messages.find((message) => message.toolCalls?.run)?.toolCalls?.run;
  assert.ok(run, 'expected the assistant message to carry the run state');
  return run;
}

/** The events the read path attaches, rebuilt from the transcript. */
function attachedEvents(conversationId: string): ReconstructedAgentEvent[] {
  const events = getMessages(conversationId).find((message) => message.toolCalls?.run)?.toolCalls?.run?.events;
  assert.ok(events, 'expected the read path to attach run events');
  return events as ReconstructedAgentEvent[];
}

function rebuiltRunEvents(conversationId: string, runId: string): ReconstructedAgentEvent[] {
  return toAgentEvents(readTranscript(conversationId, { runId, unlimited: true }).events);
}

/** Drive one run through the real persistence path, without an LLM. */
function recordRun(conversationId: string): { runId: string; transcript: NonNullable<ReturnType<typeof createTranscriptRecorder>> } {
  const runState = new PersistedRunState({ conversationId, agentId: 'pi', agentRole: 'pi' });
  const runId = runState.runId;
  assert.ok(runId);
  const transcript = createTranscriptRecorder(conversationId, runId);
  assert.ok(transcript);
  runState.attachTranscript(transcript);

  // Raised by the service itself, before the runtime generator ever advances.
  runState.recordEvent({ type: 'info', content: 'Run context: main agent' });
  runState.applyRuntimeEvent({
    type: 'loop_health',
    level: 'info',
    reason: 'context_watermark_checked',
    detail: 'estimated=1000',
  });

  // Raised by the runtime. It records the tool call and result first and then yields
  // the matching runtime events — the ordering the projection depends on.
  const observation = { observationId: 'obs-1', mode: 'inline', sizeChars: 11, artifact: null };
  transcript.recordToolCall({
    requestId: 'request-1',
    turnIndex: 0,
    callId: 'call-1',
    toolName: 'lookup',
    rawArguments: '{"id":"1"}',
    parsedArguments: { id: '1' },
  });
  runState.applyRuntimeEvent({
    type: 'tool_call_start',
    tool_name: 'lookup',
    arguments: { id: '1' },
    turnIndex: 0,
    planStepIndex: null,
  });
  transcript.recordToolResult({
    requestId: 'request-1',
    turnIndex: 0,
    callId: 'call-1',
    toolName: 'lookup',
    rawResult: '{"ok":true}',
    modelVisibleResult: '{"ok":true}',
    observation,
  });
  runState.applyRuntimeEvent({
    type: 'tool_call_result',
    tool_name: 'lookup',
    result: '{"ok":true}',
    observation,
    turnIndex: 0,
    planStepIndex: null,
  });
  runState.applyRuntimeEvent({
    type: 'mcp_status',
    connected: [{ name: 'tavily', tools_count: 2, prompts_count: 0, resources_count: 0 }],
    failed: [],
    disconnected: [],
  });

  runState.persist('running');
  return { runId, transcript };
}

test('run events are derived from the transcript instead of stored on the message', () => {
  const project = createTempProject('transcript-parity');
  const conversation = createConversation({ title: 'parity', projectPath: project.projectPath });
  try {
    const { runId } = recordRun(conversation.id);

    // The stored copy is gone: the message now only points at its run.
    const stored = storedRun(conversation.id);
    assert.equal('events' in stored, false, 'run events must not be persisted on the message');
    assert.equal(stored.runId, runId);

    // …and the read path still hands the same stream to every consumer.
    const attached = attachedEvents(conversation.id);
    assert.deepEqual(attached.map((event) => event.type), [
      'info', 'loop_health', 'tool_call_start', 'tool_call_result', 'mcp_status',
    ]);
    assert.deepEqual(attached, rebuiltRunEvents(conversation.id, runId));
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a run whose transcript is missing yields no events rather than an error', () => {
  const project = createTempProject('transcript-parity-missing');
  const conversation = createConversation({ title: 'parity missing', projectPath: project.projectPath });
  try {
    const { runId, transcript } = recordRun(conversation.id);
    assert.ok(runId);
    assert.ok(transcript);
    // Delete the log behind the read path's back.
    fs.rmSync(getTranscriptEventsPath(conversation.id), { force: true });

    // The conversation must stay readable: a missing audit trail degrades the trace,
    // it does not take the session down.
    const run = getMessages(conversation.id).find((message) => message.toolCalls?.run)?.toolCalls?.run;
    assert.ok(run);
    assert.equal(run.events, undefined);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a rebuilt tool row shows the model-visible text, not the UI preview', () => {
  // A long result is the one place the rebuilt stream intentionally differs from the
  // runtime event: the UI preview is truncated differently from the text the model
  // saw, and only the latter belongs in a trajectory. The complete raw result stays
  // retrievable through the transcript blob route.
  const project = createTempProject('transcript-parity-long');
  const conversation = createConversation({ title: 'parity long', projectPath: project.projectPath });
  try {
    const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });
    const runId = runState.runId;
    assert.ok(runId);
    const transcript = createTranscriptRecorder(conversation.id, runId);
    assert.ok(transcript);
    runState.attachTranscript(transcript);

    transcript.recordToolResult({
      requestId: 'request-1',
      turnIndex: 0,
      callId: 'call-1',
      toolName: 'exec_command',
      rawResult: 'R'.repeat(9000),
      modelVisibleResult: 'M'.repeat(6000),
    });
    runState.applyRuntimeEvent({
      type: 'tool_call_result',
      tool_name: 'exec_command',
      result: 'P'.repeat(12000),
      turnIndex: 0,
      planStepIndex: null,
    });
    runState.persist('running');

    const rebuilt = rebuiltRunEvents(conversation.id, runId).find((event) => event.type === 'tool_call_result');
    assert.ok(rebuilt);
    assert.equal(rebuilt.result, 'M'.repeat(6000));
    assert.notEqual(rebuilt.result, 'P'.repeat(12000));
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('tool activity is not mirrored a second time as an engine event', () => {
  const project = createTempProject('transcript-parity-nodup');
  const conversation = createConversation({ title: 'parity nodup', projectPath: project.projectPath });
  try {
    const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });
    const runId = runState.runId;
    assert.ok(runId);
    const transcript = createTranscriptRecorder(conversation.id, runId);
    assert.ok(transcript);
    runState.attachTranscript(transcript);

    transcript.recordToolCall({
      requestId: 'request-1',
      turnIndex: 0,
      callId: 'call-1',
      toolName: 'lookup',
      rawArguments: '{}',
      parsedArguments: {},
    });
    runState.applyRuntimeEvent({ type: 'tool_call_start', tool_name: 'lookup', arguments: {} });
    runState.persist('running');

    const records = readTranscript(conversation.id, { runId, unlimited: true }).events;
    assert.deepEqual(records.map((record) => record.type), ['run_start', 'tool_call']);
    assert.deepEqual(rebuiltRunEvents(conversation.id, runId).map((event) => event.type), ['tool_call_start']);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

const normalise = (value: unknown) => String(value ?? '').replace(/\s+/g, '');

/**
 * Drive one run that narrates between tool calls through the real write order: the
 * runtime records `model_response` before the turn's `tool_call`, and records each tool
 * call/result before yielding the runtime event the service reacts to.
 */
function recordNarratedRun(conversationId: string): string {
  const runState = new PersistedRunState({ conversationId, agentId: 'pi', agentRole: 'pi' });
  const runId = runState.runId;
  assert.ok(runId);
  const transcript = createTranscriptRecorder(conversationId, runId);
  assert.ok(transcript);
  runState.attachTranscript(transcript);

  const turn = (turnIndex: number, content: string, toolName: string | null) => {
    transcript.recordModelResponse({
      requestId: `request-${turnIndex}`,
      turnIndex,
      content,
      toolCalls: [],
      finishReason: toolName ? 'tool_calls' : 'stop',
    });
    runState.applyRuntimeEvent({ type: 'content', content });
    if (!toolName) return;
    transcript.recordToolCall({
      requestId: `request-${turnIndex}`,
      turnIndex,
      callId: `call-${turnIndex}`,
      toolName,
      rawArguments: '{}',
      parsedArguments: {},
    });
    runState.applyRuntimeEvent({
      type: 'tool_call_start',
      tool_name: toolName,
      arguments: {},
      turnIndex,
      planStepIndex: null,
    });
    transcript.recordToolResult({
      requestId: `request-${turnIndex}`,
      turnIndex,
      callId: `call-${turnIndex}`,
      toolName,
      rawResult: '{"ok":true}',
      modelVisibleResult: '{"ok":true}',
    });
    runState.applyRuntimeEvent({
      type: 'tool_call_result',
      tool_name: toolName,
      result: '{"ok":true}',
      turnIndex,
      planStepIndex: null,
    });
  };

  turn(0, '先看目录\n', 'read_file');
  turn(1, '再看文件\n', 'exec_command');
  turn(2, '完成。', null);
  runState.persist('completed');
  return runId;
}

test('narration between tool calls is rebuilt in position instead of collapsing to the end', () => {
  const project = createTempProject('transcript-parity-narration');
  const conversation = createConversation({ title: 'parity narration', projectPath: project.projectPath });
  try {
    recordNarratedRun(conversation.id);

    // Each turn's text sits immediately before that turn's tool rows — the order the
    // live stream had. Before the projection existed the rebuilt stream held tool rows
    // only, so the message's single concatenated content string was appended after all
    // of them.
    assert.deepEqual(attachedEvents(conversation.id).map((event) => event.type), [
      'info', 'tool_call_start', 'tool_call_result',
      'info', 'tool_call_start', 'tool_call_result',
      'info',
    ]);
    assert.deepEqual(
      attachedEvents(conversation.id).filter((event) => event.type === 'info').map((event) => event.content),
      ['先看目录\n', '再看文件\n', '完成。'],
    );
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('rebuilt narration concatenates back to the message content the run kept', () => {
  const project = createTempProject('transcript-parity-narration-content');
  const conversation = createConversation({ title: 'parity narration content', projectPath: project.projectPath });
  try {
    const runId = recordNarratedRun(conversation.id);
    const message = getMessages(conversation.id).find((item) => item.toolCalls?.run?.runId === runId);
    assert.ok(message);

    const projected = attachedEvents(conversation.id)
      .filter((event) => event.type === 'info')
      .map((event) => event.content)
      .join('');
    // Whitespace-normalised: a turn that narrates nothing but whitespace is dropped on
    // purpose, and the run-context banner is not part of the content at all.
    assert.equal(normalise(projected), normalise(message.content));
    assert.ok(normalise(message.content).length > 0);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a length-capped turn is discarded from the rebuilt narration as well', () => {
  const project = createTempProject('transcript-parity-truncated');
  const conversation = createConversation({ title: 'parity truncated', projectPath: project.projectPath });
  try {
    const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });
    const runId = runState.runId;
    assert.ok(runId);
    const transcript = createTranscriptRecorder(conversation.id, runId);
    assert.ok(transcript);
    runState.attachTranscript(transcript);

    runState.applyRuntimeEvent({ type: 'content', content: 'kept narration\n' });
    transcript.recordModelResponse({
      requestId: 'request-0',
      turnIndex: 0,
      content: 'kept narration\n',
      toolCalls: [],
      finishReason: 'tool_calls',
    });
    transcript.recordToolCall({
      requestId: 'request-0',
      turnIndex: 0,
      callId: 'call-0',
      toolName: 'lookup',
      rawArguments: '{}',
      parsedArguments: {},
    });
    runState.applyRuntimeEvent({ type: 'tool_call_start', tool_name: 'lookup', arguments: {}, turnIndex: 0, planStepIndex: null });
    transcript.recordToolResult({
      requestId: 'request-0',
      turnIndex: 0,
      callId: 'call-0',
      toolName: 'lookup',
      rawResult: '{"ok":true}',
      modelVisibleResult: '{"ok":true}',
    });
    runState.applyRuntimeEvent({ type: 'tool_call_result', tool_name: 'lookup', result: '{"ok":true}', turnIndex: 0, planStepIndex: null });

    // The runtime discards a length-capped turn: its text leaves the message content and
    // nothing was executed, so replaying it as narration would show text the run threw away.
    const truncated = 'cut off mid';
    runState.applyRuntimeEvent({ type: 'content', content: truncated });
    transcript.recordModelResponse({
      requestId: 'request-1',
      turnIndex: 1,
      content: truncated,
      toolCalls: [],
      finishReason: 'length',
    });
    runState.applyRuntimeEvent({
      type: 'loop_health',
      level: 'warning',
      reason: 'model_response_truncated',
      detail: 'capped',
      discardedContentChars: truncated.length,
    });
    runState.persist('completed');

    const message = getMessages(conversation.id).find((item) => item.toolCalls?.run?.runId === runId);
    assert.ok(message);
    assert.equal(message.content, 'kept narration\n');
    assert.deepEqual(
      attachedEvents(conversation.id).filter((event) => event.type === 'info').map((event) => event.content),
      ['kept narration\n'],
    );
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});

test('a turn that narrates only whitespace produces no narration event', () => {
  const project = createTempProject('transcript-parity-blank');
  const conversation = createConversation({ title: 'parity blank', projectPath: project.projectPath });
  try {
    const runState = new PersistedRunState({ conversationId: conversation.id, agentId: 'pi', agentRole: 'pi' });
    const runId = runState.runId;
    assert.ok(runId);
    const transcript = createTranscriptRecorder(conversation.id, runId);
    assert.ok(transcript);
    runState.attachTranscript(transcript);

    // A tool-calling turn commonly emits nothing but newlines; an `info` row for it would
    // add an empty text block to the flow.
    runState.applyRuntimeEvent({ type: 'content', content: '\n\n' });
    transcript.recordModelResponse({ requestId: 'request-0', turnIndex: 0, content: '\n\n', toolCalls: [], finishReason: 'tool_calls' });
    transcript.recordToolCall({
      requestId: 'request-0',
      turnIndex: 0,
      callId: 'call-0',
      toolName: 'lookup',
      rawArguments: '{}',
      parsedArguments: {},
    });
    runState.applyRuntimeEvent({ type: 'tool_call_start', tool_name: 'lookup', arguments: {}, turnIndex: 0, planStepIndex: null });
    runState.persist('completed');

    assert.deepEqual(attachedEvents(conversation.id).map((event) => event.type), ['tool_call_start']);
  } finally {
    deleteConversation(conversation.id);
    project.cleanup();
  }
});
