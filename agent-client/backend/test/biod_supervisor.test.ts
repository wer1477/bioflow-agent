import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { BiodHealth } from '../src/agent/biod/client.js';
import type { BiodConfig } from '../src/agent/biod/config.js';
import { BiodProcessSupervisor, type BiodSpawnProcess } from '../src/agent/biod/supervisor.js';

/**
 * Supervisor behaviour without touching a real python: the health probe and the spawn
 * function are injected. What is asserted here is the decision logic operators care about:
 * adopt vs spawn, when not to spawn, the timeout/kill path and the bounded restart policy.
 */

const tempDirectories: string[] = [];
after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biod-supervisor-'));
  tempDirectories.push(directory);
  return directory;
}

const READY_HEALTH: BiodHealth = { ok: true, status: 'ready', modelVersion: 'biod-v0-final' };

function testConfig(
  options: {
    autoStart?: boolean;
    startupTimeoutMs?: number;
    runtime?: Partial<BiodConfig['runtime']>;
    expectedVersion?: string;
    baseUrl?: string;
  } = {},
): BiodConfig {
  return {
    enabled: true,
    service: {
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:8790',
      autoStart: options.autoStart ?? false,
      startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
      requestTimeoutMs: 100,
      contextTimeoutMs: 200,
    },
    runtime: { device: 'cuda', dtype: 'bfloat16', ...options.runtime },
    model: { expectedVersion: options.expectedVersion ?? 'biod-v0-final' },
    decisionPoints: {
      tool_select: { mode: 'select', tau: 0.5 },
      kb_select: { mode: 'select', tau: 0.5, topK: 3 },
      context_retention: { mode: 'select', maxGroups: 32 },
    },
    state: { maxChars: 2_000 },
    warnings: [],
  };
}

function completeRuntime(): Partial<BiodConfig['runtime']> {
  return { python: process.execPath, repoRoot: tempDirectory(), ckptDir: tempDirectory() };
}

/** Minimal stand-in for `spawn()`'s result: streams, exit events and a signal recorder. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    this.exit(0, signal ?? 'SIGTERM');
    return true;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface SpawnRecord {
  command: string;
  args: string[];
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] };
}

function recorder(): { spawnProcess: BiodSpawnProcess; records: SpawnRecord[]; children: FakeChild[] } {
  const records: SpawnRecord[] = [];
  const children: FakeChild[] = [];
  const spawnProcess: BiodSpawnProcess = (command, args, options) => {
    records.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawnProcess, records, children };
}

function sequenceProbe(responses: Array<BiodHealth | 'throw' | 'refused'>): { health: () => Promise<BiodHealth>; calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    health: async () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response === 'throw') throw new Error('probe exploded');
      if (response === 'refused') return { ok: false, error: 'connect ECONNREFUSED' };
      return response;
    },
  };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('autoStart=false and no running sidecar reports not_ready without spawning', async () => {
  const probe = sequenceProbe(['refused']);
  const { spawnProcess, records } = recorder();
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ runtime: completeRuntime() }),
    probe,
    spawnProcess,
    pollIntervalMs: 5,
  });

  const result = await supervisor.ensureRunning();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_ready');
  assert.equal(records.length, 0);
  assert.equal(supervisor.adopted, false);
});

test('an enabled config with incomplete runtime paths is not_configured even with autoStart off', async () => {
  const probe = sequenceProbe(['refused']);
  const { spawnProcess, records } = recorder();
  const supervisor = new BiodProcessSupervisor({ config: testConfig(), probe, spawnProcess, pollIntervalMs: 5 });

  const result = await supervisor.ensureRunning();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
  assert.match(result.message ?? '', /autoStart is disabled/);
  assert.equal(records.length, 0);
});

test('an existing healthy sidecar is adopted and stop() leaves it alone', async () => {
  const probe = sequenceProbe([READY_HEALTH]);
  const { spawnProcess, records } = recorder();
  const supervisor = new BiodProcessSupervisor({ config: testConfig(), probe, spawnProcess, pollIntervalMs: 5 });

  assert.deepEqual(await supervisor.ensureRunning(), { ok: true });
  assert.equal(supervisor.adopted, true);
  assert.equal(records.length, 0);

  await supervisor.stop();
  assert.equal(records.length, 0, 'an adopted process is not ours to kill');
  assert.equal(supervisor.adopted, false);
});

test('an adopted sidecar with the wrong model version is model_mismatch', async () => {
  const probe = sequenceProbe([{ ok: true, status: 'ready', modelVersion: 'biod-v9' }]);
  const { spawnProcess, records } = recorder();
  const supervisor = new BiodProcessSupervisor({ config: testConfig(), probe, spawnProcess, pollIntervalMs: 5 });

  const result = await supervisor.ensureRunning();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model_mismatch');
  assert.equal(supervisor.adopted, false);
  assert.equal(records.length, 0);
});

test('a loading sidecar is adopted once it becomes ready', async () => {
  const probe = sequenceProbe([{ ok: true, status: 'loading' }, { ok: true, status: 'ready', modelVersion: 'biod-v0-final' }]);
  const { spawnProcess, records } = recorder();
  const supervisor = new BiodProcessSupervisor({ config: testConfig(), probe, spawnProcess, pollIntervalMs: 5 });

  assert.deepEqual(await supervisor.ensureRunning(), { ok: true });
  assert.equal(supervisor.adopted, true);
  assert.equal(records.length, 0);
});

test('autoStart with an incomplete runtime reports not_configured and spawns nothing', async () => {
  const probe = sequenceProbe(['refused']);
  const { spawnProcess, records } = recorder();
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ autoStart: true }),
    probe,
    spawnProcess,
    pollIntervalMs: 5,
  });

  const result = await supervisor.ensureRunning();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
  assert.match(result.message ?? '', /python|repoRoot|ckptDir/);
  assert.equal(records.length, 0);
});

test('autoStart spawns python -m biod.serve with the offline environment', async () => {
  const runtime = completeRuntime();
  const probe = sequenceProbe(['refused', READY_HEALTH, READY_HEALTH, READY_HEALTH]);
  const { spawnProcess, records, children } = recorder();
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ autoStart: true, runtime }),
    probe,
    spawnProcess,
    pollIntervalMs: 5,
  });

  assert.deepEqual(await supervisor.ensureRunning(), { ok: true });
  assert.equal(supervisor.adopted, false);
  assert.equal(records.length, 1);
  const [spawned] = records;
  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.args, [
    '-m',
    'biod.serve',
    '--host',
    '127.0.0.1',
    '--port',
    '8790',
    '--ckpt',
    runtime.ckptDir,
    '--device',
    'cuda',
    '--dtype',
    'bfloat16',
  ]);
  assert.equal(spawned.options.cwd, runtime.repoRoot);
  assert.equal(spawned.options.env.HF_HOME, path.join(runtime.repoRoot!, '.hf_cache'));
  assert.equal(spawned.options.env.HF_HUB_OFFLINE, '1');
  assert.equal(spawned.options.env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(spawned.options.env.PYTHONUNBUFFERED, '1');

  await supervisor.stop();
  assert.deepEqual(children[0].kills, ['SIGTERM']);
});

test('a sidecar that never becomes ready times out and is killed', async () => {
  const probe = sequenceProbe(['refused']);
  const { spawnProcess, records, children } = recorder();
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ autoStart: true, runtime: completeRuntime(), startupTimeoutMs: 120 }),
    probe,
    spawnProcess,
    pollIntervalMs: 10,
  });

  const result = await supervisor.ensureRunning();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(records.length, 1);
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  assert.equal(supervisor.adopted, false);
});

test('crashes restart with backoff at most three times, then circuit_open', async () => {
  const probe = sequenceProbe(['refused', READY_HEALTH, READY_HEALTH, READY_HEALTH, READY_HEALTH]);
  const { spawnProcess, records, children } = recorder();
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ autoStart: true, runtime: completeRuntime() }),
    probe,
    spawnProcess,
    pollIntervalMs: 5,
    restartDelaysMs: [5, 5, 5],
  });

  assert.deepEqual(await supervisor.ensureRunning(), { ok: true });
  assert.equal(records.length, 1);

  for (let restart = 1; restart <= 3; restart += 1) {
    children[restart - 1].exit(1);
    await waitFor(() => records.length === restart + 1, `restart ${restart}`);
  }

  // The fourth death spends the last restart slot, so supervision stops synchronously.
  children[3].exit(1);

  const exhausted = await supervisor.ensureRunning();
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, 'circuit_open');
  assert.equal(records.length, 4);
});

test('a successful restart is usable again through ensureRunning', async () => {
  const probe = sequenceProbe(['refused', READY_HEALTH, READY_HEALTH, READY_HEALTH]);
  const { spawnProcess, records, children } = recorder();
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ autoStart: true, runtime: completeRuntime() }),
    probe,
    spawnProcess,
    pollIntervalMs: 5,
    restartDelaysMs: [5, 5, 5],
  });

  await supervisor.ensureRunning();
  children[0].exit(1);
  await waitFor(() => records.length === 2, 'the restart');
  assert.deepEqual(await supervisor.ensureRunning(), { ok: true });
  assert.equal(supervisor.adopted, false);
  await supervisor.stop();
});

test('sidecar stdout and stderr are forwarded with the [biod] prefix', async () => {
  const probe = sequenceProbe(['refused', READY_HEALTH]);
  const { spawnProcess, children } = recorder();
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ autoStart: true, runtime: completeRuntime() }),
    probe,
    spawnProcess,
    pollIntervalMs: 5,
  });

  const messages: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    messages.push(args.map((value) => String(value)).join(' '));
  };
  try {
    await supervisor.ensureRunning();
    children[0].stdout.write('loading weights\n');
    children[0].stderr.write('warmup failed\n');
    await waitFor(() => messages.some((line) => line.includes('loading weights')) && messages.some((line) => line.includes('warmup failed')), 'forwarded logs');
    assert.ok(messages.every((line) => line.startsWith('[biod] ')));
  } finally {
    console.log = originalLog;
    await supervisor.stop();
  }
});

test('a synchronous spawn failure is reported as not_configured', async () => {
  const probe = sequenceProbe(['refused']);
  const spawnProcess: BiodSpawnProcess = () => {
    throw new Error('spawn ENOENT');
  };
  const supervisor = new BiodProcessSupervisor({
    config: testConfig({ autoStart: true, runtime: completeRuntime() }),
    probe,
    spawnProcess,
    pollIntervalMs: 5,
  });
  const result = await supervisor.ensureRunning();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
  assert.match(result.message ?? '', /ENOENT/);
});
