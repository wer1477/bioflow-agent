import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { BiodService, biodService, type BiodSupervisorLike } from '../src/agent/biod/service.js';
import type {
  BiodCandidate,
  BiodEnsureRunningResult,
  BiodFailure,
  BiodGroupScores,
  BiodHealth,
  BiodKbDecision,
  BiodResult,
  BiodToolDecision,
} from '../src/agent/biod/index.js';
import type { BiodClient } from '../src/agent/biod/client.js';
import type { BiodConfig } from '../src/agent/biod/config.js';

/**
 * Service-level contract: fail closed on purpose, fail open on infrastructure.
 * A fake client/supervisor keeps the tests off port 8790; the decision log goes to a
 * throwaway file so append behaviour is asserted directly.
 */

const tempDirectories: string[] = [];
after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function decisionsFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-service-'));
  tempDirectories.push(directory);
  return path.join(directory, 'biod-decisions.jsonl');
}

const READY_HEALTH: BiodHealth = { ok: true, status: 'ready', modelVersion: 'biod-v0-final' };

const CANDIDATES: BiodCandidate[] = [
  { id: 'skill:exec', name: 'exec', description: 'run a command', kind: 'skill' },
  { id: 'kb:alpine', name: 'alpine', description: 'dataset', kind: 'kb' },
];

const TOOL_DECISION: BiodToolDecision = {
  ok: true,
  decisionId: 'tool-1',
  chosen: ['skill:exec'],
  scores: [{ id: 'skill:exec', p: 0.9 }],
  confidence: 0.9,
  noToolProb: 0.01,
  latencyMs: 42,
  modelVersion: 'biod-v0-final',
  candidateCount: 2,
};

const KB_DECISION: BiodKbDecision = {
  ok: true,
  decisionId: 'kb-1',
  chosen: ['kb:alpine'],
  scores: [{ id: 'kb:alpine', p: 0.8 }],
  confidence: 0.8,
  latencyMs: 12,
  modelVersion: 'biod-v0-final',
  candidateCount: 2,
};

function testConfig(options: {
  enabled?: boolean;
  toolMode?: 'off' | 'select';
  kbMode?: 'off' | 'select';
  contextMode?: 'off' | 'select';
  maxGroups?: number;
  expectedVersion?: string;
} = {}): BiodConfig {
  return {
    enabled: options.enabled ?? true,
    service: {
      baseUrl: 'http://127.0.0.1:8790',
      autoStart: false,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 200,
      contextTimeoutMs: 200,
    },
    runtime: { device: 'cpu', dtype: 'float32' },
    model: { expectedVersion: options.expectedVersion ?? 'biod-v0-final' },
    decisionPoints: {
      tool_select: { mode: options.toolMode ?? 'select', tau: 0.5 },
      kb_select: { mode: options.kbMode ?? 'select', tau: 0.5, topK: 3 },
      context_retention: { mode: options.contextMode ?? 'select', maxGroups: options.maxGroups ?? 32 },
    },
    state: { maxChars: 2_000 },
    warnings: [],
  };
}

interface ClientCalls {
  health: number;
  tool: number;
  kb: number;
  groups: number;
  lastGroups: Array<{ id: string; name: string; description: string }>;
}

interface FakeClientHooks {
  health?: () => Promise<BiodHealth>;
  decideTool?: () => Promise<BiodResult<BiodToolDecision>>;
  decideKb?: () => Promise<BiodResult<BiodKbDecision>>;
  scoreGroups?: () => Promise<BiodResult<BiodGroupScores>>;
}

function fakeClient(hooks: FakeClientHooks = {}): { client: BiodClient; calls: ClientCalls } {
  const calls: ClientCalls = { health: 0, tool: 0, kb: 0, groups: 0, lastGroups: [] };
  const client: BiodClient = {
    async health() {
      calls.health += 1;
      return hooks.health ? hooks.health() : READY_HEALTH;
    },
    async version() {
      return { ok: true, modelVersion: READY_HEALTH.modelVersion };
    },
    async decideTool() {
      calls.tool += 1;
      return hooks.decideTool ? hooks.decideTool() : TOOL_DECISION;
    },
    async decideKb() {
      calls.kb += 1;
      return hooks.decideKb ? hooks.decideKb() : KB_DECISION;
    },
    async scoreGroups(_state, groups) {
      calls.groups += 1;
      calls.lastGroups = groups;
      if (hooks.scoreGroups) return hooks.scoreGroups();
      return { ok: true, scores: groups.map((group) => ({ id: group.id, score: 0.5 })), latencyMs: 5 };
    },
  };
  return { client, calls };
}

function fakeSupervisor(result: BiodEnsureRunningResult = { ok: true }): {
  supervisor: BiodSupervisorLike;
  state: { ensureCalls: number; stopCalls: number };
} {
  const state = { ensureCalls: 0, stopCalls: 0 };
  const supervisor: BiodSupervisorLike = {
    async ensureRunning() {
      state.ensureCalls += 1;
      return result;
    },
    async stop() {
      state.stopCalls += 1;
    },
  };
  return { supervisor, state };
}

function readDecisions(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertFailure<T>(result: BiodResult<T>): asserts result is BiodFailure {
  const failure = result as { ok?: unknown };
  if (failure.ok !== false) assert.fail('expected the decision call to fail');
}

function assertSuccess<T extends { ok: true }>(result: BiodResult<T>): asserts result is T {
  if (result.ok !== true) assert.fail(`expected the decision call to succeed, got ${String((result as BiodFailure).reason)}`);
}

test('start marks the service ready and a successful decision is appended to the log', async () => {
  const file = decisionsFile();
  const { client, calls } = fakeClient();
  const { supervisor, state } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: file, environment: {} });

  assert.equal(service.getStatus().ready, false);
  await service.start();
  assert.deepEqual(service.getStatus(), { enabled: true, ready: true, modelVersion: 'biod-v0-final' });
  assert.equal(state.ensureCalls, 1);
  assert.equal(calls.health, 1);

  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertSuccess(result);
  assert.deepEqual(result.chosen, ['skill:exec']);

  const lines = readDecisions(file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'tool');
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].decisionId, 'tool-1');
  assert.deepEqual(lines[0].chosen, ['skill:exec']);
  assert.equal(lines[0].confidence, 0.9);
  assert.equal(lines[0].candidateCount, 2);
  assert.equal(lines[0].stateChars, 'find the failing test'.length);
  assert.equal(typeof lines[0].ts, 'string');
});

test('the decision log appends across calls rather than being rewritten', async () => {
  const file = decisionsFile();
  const { client } = fakeClient();
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: file, environment: {} });
  await service.start();
  await service.decideTool({ state: 'first', candidates: CANDIDATES });
  await service.decideKnowledge({ state: 'second', candidates: CANDIDATES });
  const lines = readDecisions(file);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'tool');
  assert.equal(lines[1].kind, 'kb');
});

test('a decision point in mode off reports disabled and never calls the sidecar', async () => {
  const file = decisionsFile();
  const { client, calls } = fakeClient();
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({ config: testConfig({ toolMode: 'off' }), client, supervisor, decisionsFile: file, environment: {} });
  await service.start();

  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'disabled');
  assert.equal(calls.tool, 0);
  assert.equal(readDecisions(file)[0].reason, 'disabled');
});

test('BIOFLOW_BIOD_DISABLED disables the service even when the config enables it', async () => {
  const { client, calls } = fakeClient();
  const { supervisor, state } = fakeSupervisor();
  const service = new BiodService({
    config: testConfig(),
    client,
    supervisor,
    decisionsFile: decisionsFile(),
    environment: { BIOFLOW_BIOD_DISABLED: '1' },
  });

  await service.start();
  assert.deepEqual(service.getStatus(), { enabled: false, ready: false, reason: 'disabled' });
  assert.equal(state.ensureCalls, 0, 'a disabled service must not touch the supervisor');

  const result = await service.decideKnowledge({ state: 'find the dataset', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'disabled');
  assert.equal(calls.kb, 0);
});

test('a model version mismatch leaves the service not-ready and fails decisions with model_mismatch', async () => {
  const file = decisionsFile();
  const { client, calls } = fakeClient({ health: async () => ({ ok: true, status: 'ready', modelVersion: 'biod-v9' }) });
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: file, environment: {} });
  await service.start();

  assert.deepEqual(service.getStatus(), { enabled: true, ready: false, reason: 'model_mismatch', modelVersion: 'biod-v9' });
  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'model_mismatch');
  assert.equal(calls.tool, 0);
});

test('an empty state text is not_ready and is logged as a failure', async () => {
  const file = decisionsFile();
  const { client, calls } = fakeClient();
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: file, environment: {} });
  await service.start();

  const result = await service.decideTool({ state: '   ', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'not_ready');
  assert.equal(calls.tool, 0);
  const lines = readDecisions(file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].reason, 'not_ready');
});

test('a decision before start() is not_ready rather than disabled', async () => {
  const { client, calls } = fakeClient();
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: decisionsFile(), environment: {} });
  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'not_ready');
  assert.equal(calls.tool, 0);
});

test('sidecar failures are passed through with their reason and logged', async () => {
  const file = decisionsFile();
  const { client } = fakeClient({ decideTool: async () => ({ ok: false, reason: 'timeout', message: 'took too long' }) });
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: file, environment: {} });
  await service.start();

  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'timeout');
  const lines = readDecisions(file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].reason, 'timeout');
});

test('a client that throws is converted to bad_response instead of escaping', async () => {
  const { client } = fakeClient({
    decideTool: async () => {
      throw new Error('socket exploded');
    },
  });
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: decisionsFile(), environment: {} });
  await service.start();
  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'bad_response');
  assert.match(result.message ?? '', /socket exploded/);
});

test('start is idempotent and stop delegates to the supervisor', async () => {
  const { client } = fakeClient();
  const { supervisor, state } = fakeSupervisor();
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: decisionsFile(), environment: {} });
  await Promise.all([service.start(), service.start()]);
  await service.start();
  assert.equal(state.ensureCalls, 1);
  assert.equal(service.getStatus().ready, true);

  await service.stop();
  assert.equal(state.stopCalls, 1);
  assert.equal(service.getStatus().ready, false);
});

test('an unwritable decision log does not fail the decision', async () => {
  const { client } = fakeClient();
  const { supervisor } = fakeSupervisor();
  const service = new BiodService({
    config: testConfig(),
    client,
    supervisor,
    decisionsFile: path.join('/dev/null', 'biod-decisions.jsonl'),
    environment: {},
  });
  await service.start();
  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertSuccess(result);
});

test('scoreGroups honours context_retention mode and maxGroups', async () => {
  const { client, calls } = fakeClient();
  const { supervisor } = fakeSupervisor();
  const offService = new BiodService({
    config: testConfig({ contextMode: 'off' }),
    client,
    supervisor,
    decisionsFile: decisionsFile(),
    environment: {},
  });
  await offService.start();
  const disabled = await offService.scoreGroups({ state: 'task', groups: [{ id: '1', name: 'a', description: 'x' }] });
  assertFailure(disabled);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(calls.groups, 0);

  const limitedService = new BiodService({
    config: testConfig({ maxGroups: 2 }),
    client,
    supervisor,
    decisionsFile: decisionsFile(),
    environment: {},
  });
  await limitedService.start();
  const groups = [1, 2, 3].map((index) => ({ id: String(index), name: `tool:${index}`, description: 'x' }));
  const result = await limitedService.scoreGroups({ state: 'task', groups });
  assertSuccess(result);
  assert.equal(calls.lastGroups.length, 2);
  assert.deepEqual(result.scores.map((score) => score.id), ['1', '2']);
});

test('a failing supervisor start leaves the service not-ready with that reason', async () => {
  const { client } = fakeClient();
  const { supervisor } = fakeSupervisor({ ok: false, reason: 'not_configured', message: 'runtime missing' });
  const service = new BiodService({ config: testConfig(), client, supervisor, decisionsFile: decisionsFile(), environment: {} });
  await service.start();
  assert.deepEqual(service.getStatus(), { enabled: true, ready: false, reason: 'not_configured' });
  const result = await service.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'not_configured');
});

test('the process singleton honours the test environment kill switch without touching the sidecar', async () => {
  // setup-test-workspace.mjs sets BIOFLOW_BIOD_DISABLED=1 for every test process. The
  // singleton must therefore start disabled, and this test would hang or hit 8790 if the
  // switch were ignored.
  assert.deepEqual(biodService.getStatus(), { enabled: false, ready: false, reason: 'disabled' });
  await biodService.start();
  assert.deepEqual(biodService.getStatus(), { enabled: false, ready: false, reason: 'disabled' });
  const result = await biodService.decideTool({ state: 'find the failing test', candidates: CANDIDATES });
  assertFailure(result);
  assert.equal(result.reason, 'disabled');
  await biodService.stop();
});
