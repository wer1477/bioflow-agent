import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistedNarrationBuffer } from '../src/agent/service/agent_service.js';

test('persists narration around tool boundaries for main-agent runs', () => {
  const narration = new PersistedNarrationBuffer();
  const events: Array<{ type: 'info'; content: string } | { type: 'tool_call_start'; tool_name: string }> = [];

  narration.append('Inspecting the input.');
  events.push(narration.flush()!);
  events.push({ type: 'tool_call_start', tool_name: 'lookup' });
  narration.append('The lookup confirms the result.');
  events.push(narration.flush()!);

  assert.deepEqual(events, [
    { type: 'info', content: 'Inspecting the input.' },
    { type: 'tool_call_start', tool_name: 'lookup' },
    { type: 'info', content: 'The lookup confirms the result.' },
  ]);
});

test('preserves narration that resembles a plan', () => {
  const narration = new PersistedNarrationBuffer();
  narration.append('Plan: first create a table and execute the query.');

  assert.deepEqual(narration.flush(), {
    type: 'info',
    content: 'Plan: first create a table and execute the query.',
  });
});
