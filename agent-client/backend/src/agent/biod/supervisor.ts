import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { HttpBiodClient, isBiodHealthReady, type BiodHealth } from './client.js';
import { isBiodRuntimeConfigured, matchesBiodModelVersion, type BiodConfig } from './config.js';
import type { BiodFailureReason } from './types.js';

/**
 * Owns the biod sidecar process.
 *
 * The sidecar is optional infrastructure, so the supervisor has three jobs and refuses a
 * fourth (restarting forever):
 * 1. Adopt a sidecar that is already listening instead of racing it for the port. An
 *    adopted process is never killed by `stop()` — this backend did not start it.
 * 2. When `autoStart` is on and the runtime is fully configured, launch
 *    `python -m biod.serve` offline (no HF network calls) and poll health to readiness.
 * 3. If a process *we* started dies, restart it with 1 s / 2 s / 4 s backoff. After the
 *    third restart is spent the module reports `circuit_open` and stops fighting: a
 *    broken checkpoint must not turn into an endless python spawn loop.
 *
 * `stop()` always goes SIGTERM -> grace -> SIGKILL, and only touches our own child.
 */

export interface BiodSupervisorProbe {
  health(timeoutMs?: number): Promise<BiodHealth>;
}

export type BiodSpawnProcess = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

export interface BiodEnsureRunningResult {
  ok: boolean;
  reason?: BiodFailureReason;
  message?: string;
}

export interface BiodSupervisorOptions {
  config: BiodConfig;
  probe?: BiodSupervisorProbe;
  spawnProcess?: BiodSpawnProcess;
  pollIntervalMs?: number;
  restartDelaysMs?: number[];
  killGraceMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 4_000];
const DEFAULT_KILL_GRACE_MS = 10_000;
const MAX_HEALTH_TIMEOUT_MS = 2_000;

export class BiodProcessSupervisor {
  /** True when health was already serving and this process did not spawn anything. */
  adopted = false;

  private readonly config: BiodConfig;
  private readonly probe: BiodSupervisorProbe;
  private readonly spawnProcess: BiodSpawnProcess;
  private readonly pollIntervalMs: number;
  private readonly restartDelaysMs: number[];
  private readonly killGraceMs: number;
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarts = 0;
  private exhausted = false;
  private stopping = false;
  private lastError: string | undefined;

  constructor(options: BiodSupervisorOptions) {
    this.config = options.config;
    this.probe =
      options.probe ??
      new HttpBiodClient({
        baseUrl: this.config.service.baseUrl,
        requestTimeoutMs: this.config.service.requestTimeoutMs,
        contextTimeoutMs: this.config.service.contextTimeoutMs,
      });
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.pollIntervalMs = positiveMs(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.restartDelaysMs =
      Array.isArray(options.restartDelaysMs) && options.restartDelaysMs.length
        ? options.restartDelaysMs.map((delay) => positiveMs(delay, 1_000))
        : DEFAULT_RESTART_DELAYS_MS;
    this.killGraceMs = positiveMs(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
  }

  async ensureRunning(): Promise<BiodEnsureRunningResult> {
    if (this.exhausted) {
      return {
        ok: false,
        reason: 'circuit_open',
        message: `biod sidecar is not supervised anymore after ${this.restarts} restarts${this.lastError ? ` (${this.lastError})` : ''}`,
      };
    }
    if (this.child) return this.waitForReady(Date.now() + this.startupTimeoutMs, false);

    // Adopt before spawning: an operator-started sidecar must not be duplicated on the port.
    const existing = await this.safeHealth(this.probeTimeoutMs);
    if (existing?.ok) {
      if (isBiodHealthReady(existing)) return this.accept(existing, true);
      return this.waitForReady(Date.now() + this.startupTimeoutMs, true);
    }

    if (!this.config.service.autoStart) {
      // Distinguish "not started yet" from "cannot be started by this deployment": the
      // latter is the `enabled=true` + missing BIOFLOW_BIOD_* case, and reporting
      // not_configured there keeps the status actionable.
      const readiness = this.runtimeReadiness();
      if (!readiness.ok) {
        return { ok: false, reason: 'not_configured', message: `${readiness.message}; autoStart is disabled` };
      }
      return {
        ok: false,
        reason: 'not_ready',
        message: 'biod sidecar is not running and autoStart is disabled (start it manually or enable service.autoStart)',
      };
    }
    const readiness = this.runtimeReadiness();
    if (!readiness.ok) return { ok: false, reason: 'not_configured', message: readiness.message };

    const spawned = this.spawnChild();
    if (!spawned.ok) return spawned;

    const result = await this.waitForReady(Date.now() + this.startupTimeoutMs, false);
    if (!result.ok) await this.stop();
    return result;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.adopted = false;
    try {
      if (child) await this.terminate(child);
    } finally {
      this.stopping = false;
    }
  }

  private get startupTimeoutMs(): number {
    return Math.max(1, this.config.service.startupTimeoutMs);
  }

  private get probeTimeoutMs(): number {
    return Math.max(100, Math.min(MAX_HEALTH_TIMEOUT_MS, this.config.service.requestTimeoutMs || MAX_HEALTH_TIMEOUT_MS));
  }

  private async waitForReady(deadline: number, adoptedCandidate: boolean): Promise<BiodEnsureRunningResult> {
    while (true) {
      if (this.exhausted) {
        return {
          ok: false,
          reason: 'circuit_open',
          message: `biod sidecar keeps exiting and restarting was given up${this.lastError ? ` (${this.lastError})` : ''}`,
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          ok: false,
          reason: 'timeout',
          message: `biod did not become ready within ${this.startupTimeoutMs}ms${this.lastError ? ` (${this.lastError})` : ''}`,
        };
      }
      const health = await this.safeHealth(Math.min(this.probeTimeoutMs, remaining));
      if (health && isBiodHealthReady(health)) return this.accept(health, adoptedCandidate);
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  private accept(health: BiodHealth, adoptedCandidate: boolean): BiodEnsureRunningResult {
    if (!matchesBiodModelVersion(health.modelVersion, this.config.model.expectedVersion)) {
      return {
        ok: false,
        reason: 'model_mismatch',
        message: `biod reports model "${health.modelVersion ?? 'unknown'}", expected "${this.config.model.expectedVersion}"`,
      };
    }
    this.adopted = adoptedCandidate;
    this.lastError = undefined;
    return { ok: true };
  }

  private async safeHealth(timeoutMs: number): Promise<BiodHealth | null> {
    try {
      return await this.probe.health(timeoutMs);
    } catch {
      return null;
    }
  }

  private spawnChild(): BiodEnsureRunningResult {
    const readiness = this.runtimeReadiness();
    if (!readiness.ok) return { ok: false, reason: 'not_configured', message: readiness.message };
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(readiness.python, this.commandArgs(readiness.ckptDir), {
        cwd: readiness.repoRoot,
        env: this.childEnvironment(readiness.repoRoot),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.lastError = `spawn failed: ${describeError(error)}`;
      return { ok: false, reason: 'not_configured', message: this.lastError };
    }

    this.child = child;
    this.attachLogs(child);
    child.on('exit', (code, signal) => {
      this.handleChildGone(child, `exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`);
    });
    child.on('error', (error) => {
      this.handleChildGone(child, `failed to start: ${error.message}`);
    });
    return { ok: true };
  }

  private handleChildGone(child: ChildProcess, detail: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.lastError = detail;
    if (this.stopping) return;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    if (this.restarts >= this.restartDelaysMs.length) {
      this.exhausted = true;
      this.lastError = `${this.lastError ?? 'biod sidecar exited'}; restart budget of ${this.restartDelaysMs.length} exhausted`;
      console.warn(`[biod] ${this.lastError}`);
      return;
    }
    const delayMs = this.restartDelaysMs[this.restarts];
    this.restarts += 1;
    console.warn(`[biod] ${this.lastError ?? 'sidecar exited'}; restarting in ${delayMs}ms (attempt ${this.restarts}/${this.restartDelaysMs.length})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      const result = this.spawnChild();
      if (!result.ok) console.warn(`[biod] restart failed: ${result.message ?? result.reason}`);
    }, delayMs);
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone: nothing left to wait for.
      return;
    }
    if (await waitForExit(child, this.killGraceMs)) return;
    console.warn(`[biod] sidecar ignored SIGTERM for ${this.killGraceMs}ms; sending SIGKILL`);
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
    await waitForExit(child, Math.min(1_000, Math.max(50, this.killGraceMs)));
  }

  private attachLogs(child: ChildProcess): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream || typeof stream.on !== 'function') continue;
      let buffer = '';
      stream.on('data', (chunk: unknown) => {
        buffer += String(chunk);
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.trim()) console.log(`[biod] ${line}`);
          newline = buffer.indexOf('\n');
        }
        if (buffer.length > 8_000) {
          console.log(`[biod] ${buffer}`);
          buffer = '';
        }
      });
    }
  }

  private runtimeReadiness():
    | { ok: true; python: string; repoRoot: string; ckptDir: string }
    | { ok: false; message: string } {
    const runtime = this.config.runtime;
    if (!isBiodRuntimeConfigured(runtime)) {
      const missing = [
        ['python', runtime.python],
        ['repoRoot', runtime.repoRoot],
        ['ckptDir', runtime.ckptDir],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
      return {
        ok: false,
        message: `biod runtime is not configured (missing ${missing.join(', ')}); start a sidecar manually or set the BIOFLOW_BIOD_* variables`,
      };
    }
    if (!isDirectory(runtime.repoRoot)) {
      return { ok: false, message: `biod runtime repoRoot "${runtime.repoRoot}" is not a directory` };
    }
    if (!fs.existsSync(runtime.ckptDir)) {
      return { ok: false, message: `biod checkpoint "${runtime.ckptDir}" does not exist` };
    }
    if (path.isAbsolute(runtime.python) && !fs.existsSync(runtime.python)) {
      return { ok: false, message: `biod python "${runtime.python}" does not exist` };
    }
    return { ok: true, python: runtime.python, repoRoot: runtime.repoRoot, ckptDir: runtime.ckptDir };
  }

  private commandArgs(ckptDir: string): string[] {
    const endpoint = this.endpoint();
    return [
      '-m',
      this.config.runtime.entry || 'biod.serve',
      '--host',
      endpoint.host,
      '--port',
      endpoint.port,
      '--ckpt',
      ckptDir,
      '--device',
      this.config.runtime.device,
      '--dtype',
      this.config.runtime.dtype,
    ];
  }

  private endpoint(): { host: string; port: string } {
    try {
      const url = new URL(this.config.service.baseUrl);
      return { host: url.hostname || '127.0.0.1', port: url.port || (url.protocol === 'https:' ? '443' : '80') };
    } catch {
      return { host: '127.0.0.1', port: '8790' };
    }
  }

  private childEnvironment(repoRoot: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    environment.HF_HOME = this.config.runtime.hfHome || path.join(repoRoot, '.hf_cache');
    environment.HF_HUB_OFFLINE = '1';
    environment.TRANSFORMERS_OFFLINE = '1';
    environment.PYTHONUNBUFFERED = '1';
    return environment;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    child.on('exit', onExit);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function positiveMs(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
