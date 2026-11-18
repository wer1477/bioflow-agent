import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { RuntimeToolDispatcher } from '../src/agent/runtime_tool_dispatcher.js';
import { KNOWLEDGEBASE_TOOL_NAME, TOOLLIBRARY_TOOL_NAME } from '../src/agent/core_tools/ids.js';
import type { BiodKbDecision, BiodToolDecision } from '../src/agent/biod/types.js';
import { buildBiodColdZoneScorer } from '../src/agent/biod/context_scorer.js';
import type { ColdZoneGroup } from '../src/agent/context/cold_zone.js';

const skill = {
  id: 'bio-seq',
  name: 'bio-seq',
  description: 'Sequence validation tools.',
  instructions: 'Use bio-seq for sequence work.',
  resources: [],
  directory: '',
};

function toolDecision(overrides: Partial<BiodToolDecision> = {}): BiodToolDecision {
  return {
    ok: true,
    decisionId: 'dec_tool_1',
    chosen: ['bio-seq'],
    scores: [{ id: 'bio-seq', p: 0.91 }],
    confidence: 0.91,
    noToolProb: 0.02,
    latencyMs: 410,
    modelVersion: 'biod-v0-final',
    candidateCount: 53,
    ...overrides,
  };
}

function kbDecision(overrides: Partial<BiodKbDecision> = {}): BiodKbDecision {
  return {
    ok: true,
    decisionId: 'dec_kb_1',
    chosen: ['Bioinformatics/anndata'],
    scores: [{ id: 'Bioinformatics/anndata', p: 0.88 }],
    confidence: 0.88,
    latencyMs: 240,
    modelVersion: 'biod-v0-final',
    candidateCount: 32,
    ...overrides,
  };
}

function createDispatcher(biod: {
  decideTool: (input: { state: string; candidates: unknown[] }) => Promise<unknown>;
  decideKnowledge: (input: { state: string; candidates: unknown[] }) => Promise<unknown>;
}, mainAgent?: { id: string; coreToolIds: string[] }): RuntimeToolDispatcher {
  return new RuntimeToolDispatcher({
    request: {
      llm: { baseUrl: 'http://example.test/v1', apiKey: 'unused', model: 'test' },
      messages: [],
      userMessage: 'Use scanpy to cluster the single-cell matrix.',
      mcpServers: [],
      skills: [skill] as never,
      mainAgent,
    },
    manager: {} as never,
    mcpToolsByName: new Map<string, ChatCompletionTool>(),
    mcpServers: [],
    addTools: () => [],
    runInstanceId: 'test-run',
    biod: biod as never,
  });
}

test('toollibrary defaults to biod selection and loads the chosen skill', async () => {
  const dispatcher = createDispatcher({
    async decideTool() { return toolDecision(); },
    async decideKnowledge() { throw new Error('not used'); },
  });

  const parsed = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {})).result);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'select');
  assert.equal(parsed.selected.id, 'bio-seq');
  assert.equal(parsed.load.action, 'skill');
  assert.match(parsed.load.content, /## Skill: bio-seq/);
  assert.equal(parsed.decision.decisionId, 'dec_tool_1');
  assert.equal(parsed.decision.candidateCount, 53);
});

test('toollibrary falls back to the runtime index when the decision layer fails', async () => {
  const dispatcher = createDispatcher({
    async decideTool() { return { ok: false, reason: 'timeout', message: 'sidecar slow' }; },
    async decideKnowledge() { throw new Error('not used'); },
  });

  const parsed = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {})).result);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'index');
  assert.equal(parsed.biod.status, 'deferred');
  assert.equal(parsed.biod.reason, 'timeout');
  assert.ok(Array.isArray(parsed.domains));
});

test('NO_TOOL and low confidence defer without loading anything', async () => {
  const noTool = createDispatcher({
    async decideTool() { return toolDecision({ chosen: ['NO_TOOL'], confidence: 0.8, noToolProb: 0.8 }); },
    async decideKnowledge() { throw new Error('not used'); },
  });
  const noToolParsed = JSON.parse((await noTool.execute(TOOLLIBRARY_TOOL_NAME, {})).result);
  assert.equal(noToolParsed.action, 'index');
  assert.equal(noToolParsed.biod.reason, 'no_tool');
  assert.equal(noToolParsed.biod.decision.decisionId, 'dec_tool_1');

  const low = createDispatcher({
    async decideTool() { return toolDecision({ confidence: 0.05 }); },
    async decideKnowledge() { throw new Error('not used'); },
  });
  const lowParsed = JSON.parse((await low.execute(TOOLLIBRARY_TOOL_NAME, {})).result);
  assert.equal(lowParsed.action, 'index');
  assert.equal(lowParsed.biod.reason, 'low_confidence');
});

test('explicit catalog browsing never calls the decision layer', async () => {
  let calls = 0;
  const dispatcher = createDispatcher({
    async decideTool() { calls += 1; return toolDecision(); },
    async decideKnowledge() { throw new Error('not used'); },
  });

  const parsed = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, { action: 'catalog', domain: 'General Bioinformatics Workflows and Toolchains' })).result);

  assert.equal(calls, 0);
  assert.equal(parsed.action, 'catalog');
});

test('knowledgebase select returns only the chosen entry bodies', async () => {
  const dispatcher = createDispatcher({
    async decideTool() { throw new Error('not used'); },
    async decideKnowledge() { return kbDecision(); },
  });

  const parsed = JSON.parse((await dispatcher.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'select' })).result);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'select');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].id, 'Bioinformatics/anndata');
  assert.ok(String(parsed.entries[0].content).length > 0);
  assert.equal(parsed.decision.decisionId, 'dec_kb_1');
});

test('knowledgebase select falls back to the index on failure or empty selection', async () => {
  const failed = createDispatcher({
    async decideTool() { throw new Error('not used'); },
    async decideKnowledge() { return { ok: false, reason: 'network' }; },
  });
  const failedParsed = JSON.parse((await failed.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'select' })).result);
  assert.equal(failedParsed.action, 'index');
  assert.equal(failedParsed.biod.reason, 'network');

  const empty = createDispatcher({
    async decideTool() { throw new Error('not used'); },
    async decideKnowledge() { return kbDecision({ chosen: [], confidence: 0 }); },
  });
  const emptyParsed = JSON.parse((await empty.execute(KNOWLEDGEBASE_TOOL_NAME, { action: 'select' })).result);
  assert.equal(emptyParsed.action, 'index');
  assert.equal(emptyParsed.biod.reason, 'no_selection');
});

test('cold-zone scorer uses biod scores and falls back to the deterministic prior', async () => {
  delete process.env.BIOFLOW_BIOD_DISABLED;
  const groups: ColdZoneGroup<string>[] = [
    { seq: 0, kind: 'tool-orphan', messages: ['a'], toolNames: ['read_file'], argsPreview: 'x', outcome: 'ok', producedFiles: [], blobRefs: [], text: 'read a file', summaryText: 'read a file', sizeTokens: 10, evidenceLines: [], fidelity: 0.1, score: 0 },
    { seq: 1, kind: 'assistant', messages: ['b'], toolNames: [], argsPreview: '', outcome: 'ok', producedFiles: [], blobRefs: [], text: 'summary', summaryText: 'summary', sizeTokens: 10, evidenceLines: [], fidelity: 0.1, score: 0 },
    { seq: 2, kind: 'user', messages: ['c'], toolNames: [], argsPreview: '', outcome: 'ok', producedFiles: [], blobRefs: [], text: 'instruction', summaryText: 'instruction', sizeTokens: 10, evidenceLines: [], fidelity: 0, score: 0 },
  ];
  const calls: Array<{ state: string; groups: Array<{ id: string }> }> = [];
  const scorer = await buildBiodColdZoneScorer(groups, 'cluster the matrix', {
    async scoreGroups(input) {
      calls.push({ state: input.state, groups: input.groups });
      return { ok: true, scores: [{ id: '0', score: 0.95 }], latencyMs: 12 };
    },
  });

  assert.ok(scorer);
  assert.equal(calls.length, 1);
  // User prompts are never scored.
  assert.deepEqual(calls[0].groups.map((group) => group.id), ['0', '1']);
  assert.equal(scorer(groups[0]), 0.95);
  const fallback = scorer(groups[1]);
  assert.ok(fallback > 0 && fallback <= 1);
});

test('cold-zone scorer is absent when disabled, empty, or the service fails', async () => {
  const groups: ColdZoneGroup<string>[] = [
    { seq: 0, kind: 'tool-orphan', messages: ['a'], toolNames: [], argsPreview: '', outcome: 'ok', producedFiles: [], blobRefs: [], text: 'x', summaryText: 'x', sizeTokens: 1, evidenceLines: [], fidelity: 0, score: 0 },
  ];
  const failing = { async scoreGroups() { return { ok: false as const, reason: 'timeout' as const }; } };
  assert.equal(await buildBiodColdZoneScorer(groups, 'task', failing), null);
  assert.equal(await buildBiodColdZoneScorer(groups, '', failing), null);
  process.env.BIOFLOW_BIOD_DISABLED = '1';
  assert.equal(await buildBiodColdZoneScorer(groups, 'task', failing), null);
});

test('a role that does not bind toollibrary never calls the decision layer', async () => {
  let called = false;
  const dispatcher = createDispatcher({
    async decideTool() { called = true; return toolDecision(); },
    async decideKnowledge() { throw new Error('not used'); },
  }, { id: 'researcher', coreToolIds: ['shell', 'execute_python', 'file'] });

  const parsed = JSON.parse((await dispatcher.execute(TOOLLIBRARY_TOOL_NAME, {})).result);

  assert.equal(called, false, 'llm mode must not consult biod');
  assert.equal(parsed.action, 'index');
  assert.equal(parsed.biod.status, 'off');
  assert.equal(parsed.biod.reason, 'not_configured');
});
