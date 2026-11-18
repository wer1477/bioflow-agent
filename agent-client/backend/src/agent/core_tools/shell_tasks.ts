import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { RUNTIME_STATE_ROOT } from '../../paths.js';
import { toolProcessEnvironment } from './shared.js';
import { PROCESS_KILL_GRACE_MS, terminateProcessTree } from './process_tree.js';

/**
 * Background shell tasks (`exec_command` with `run_in_background: true`).
 *
 * A task is a detached `/bin/sh -lc` process whose merged stdout/stderr is
 * appended to `RUNTIME_STATE_ROOT/shell-tasks/<id>.log`. Tasks are *not* tied
 * to an agent run: they keep running after the run that started them finishes
 * and are only stopped by an explicit `shell_kill`, by conversation/backend
 * cleanup, or by their own exit.
 *
 * The log file is the single source of truth for output: offsets are byte
 * offsets in that file, so reading is safe from any later run. A small JSON
 * registry lets a restarted backend kill task processes it inherited from a
 * previous backend process (pid + token match, so an unrelated recycled pid is
 * never signalled).
 */
export const SHELL_TASKS_DIR = path.join(RUNTIME_STATE_ROOT, 'shell-tasks');
export const SHELL_TASK_REGISTRY_PATH = path.join(RUNTIME_STATE_ROOT, 'shell-tasks.json');
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_OUTPUT_CHARS = 20_000;
export const MAX_OUTPUT_CHARS = 100_000;
export const MAX_WAIT_MS = 30_000;
export const MAX_TASKS_PER_CONVERSATION = 16;
const MAX_TERMINAL_TASKS_PER_CONVERSATION = 32;
const ORPHAN_KILL_GRACE_MS = 50;
const ORPHAN_KILL_WAIT_MS = 1_000;
const SHELL_TASK_TOKEN_ENV = 'BIOAGENT_SHELL_TASK_TOKEN';

export interface ShellTaskSnapshot {
  id: string;
  conversationId: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string | null;
  bytes: number;
  truncated: boolean;
}

export interface ShellTaskOutput {
  task: ShellTaskSnapshot;
  output: string;
  nextOffset: number;
  truncated: boolean;
}

export interface ShellTaskStartInput {
  conversationId: string;
  runInstanceId?: string;
  command: string;
  cwd: string;
  /** Project whose venv should be active for the background process. */
  projectPath?: string;
  maxOutputBytes?: number;
}

export interface ShellTaskOutputInput {
  conversationId: string;
  taskId?: string;
  offset?: number;
  waitMs?: number;
  maxChars?: number;
}

export interface ShellTaskKillInput {
  conversationId: string;
  taskId: string;
  signal?: 'SIGTERM' | 'SIGKILL';
}

export type ShellTaskStartResult = { ok: true; task: ShellTaskSnapshot } | { ok: false; error: { code: string; message: string } };
export type ShellTaskQueryResult =
  | { ok: true; tasks?: ShellTaskSnapshot[]; task?: ShellTaskSnapshot; output?: string; nextOffset?: number; truncated?: boolean }
  | { ok: false; error: { code: string; message: string } };
export type ShellTaskMutationResult = { ok: true; task: ShellTaskSnapshot } | { ok: false; error: { code: string; message: string } };

type TaskStatus = ShellTaskSnapshot['status'];

interface ShellTaskRecord {
  id: string;
  conversationId: string;
  runInstanceId?: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string | null;
  bytes: number;
  truncated: boolean;
  maxOutputBytes: number;
  outputPath: string;
  token: string;
  pid: number | undefined;
  child: ChildProcess | null;
  fd: number | null;
  killRequested: boolean;
  killTimer: NodeJS.Timeout | null;
  waiters: Set<() => void>;
}

interface RegistryEntry {
  id: string;
  pid: number;
  token: string;
  startedAt: string;
  outputPath: string;
}

/** Owns background shell processes and hides spawn, logging, offsets and cleanup. */
export class ShellTaskManager {
  private readonly tasks = new Map<string, ShellTaskRecord>();

  start(input: ShellTaskStartInput): ShellTaskStartResult {
    const conversationId = String(input.conversationId || '').trim();
    if (!conversationId) return failure('missing_conversation', 'Background shell tasks require a conversation.');
    const command = String(input.command || '').trim();
    if (!command) return failure('missing_command', 'exec_command requires cmd.');
    const cwd = String(input.cwd || '').trim();
    if (!cwd) return failure('missing_cwd', 'Background shell tasks require a working directory.');
    try {
      if (!fs.statSync(cwd).isDirectory()) return failure('invalid_cwd', `Working directory is not a directory: ${cwd}`);
    } catch {
      return failure('invalid_cwd', `Working directory does not exist: ${cwd}`);
    }

    const running = this.listRecords(conversationId).filter((record) => record.status === 'running');
    if (running.length >= MAX_TASKS_PER_CONVERSATION) {
      return failure(
        'too_many_tasks',
        `Conversation already has ${MAX_TASKS_PER_CONVERSATION} running background shell tasks. Kill one with shell_kill before starting another.`,
      );
    }
    this.pruneTerminalTasks(conversationId);

    const id = `shell_${crypto.randomUUID()}`;
    const token = crypto.randomUUID();
    const maxOutputBytes = clampInteger(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_MAX_OUTPUT_BYTES);
    let fd: number;
    try {
      fs.mkdirSync(SHELL_TASKS_DIR, { recursive: true });
      fd = fs.openSync(path.join(SHELL_TASKS_DIR, `${id}.log`), 'w');
    } catch (error) {
      return failure('spawn_failed', `Unable to create the background task log: ${errorMessage(error)}`);
    }

    const environment = toolProcessEnvironment(input.projectPath);
    environment[SHELL_TASK_TOKEN_ENV] = token;
    let child: ChildProcess;
    try {
      child = process.platform === 'win32'
        ? spawn(command, { cwd, shell: true, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('/bin/sh', ['-lc', command], { cwd, windowsHide: true, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      closeQuietly(fd);
      removeQuietly(path.join(SHELL_TASKS_DIR, `${id}.log`));
      return failure('spawn_failed', `Unable to start the background shell: ${errorMessage(error)}`);
    }

    const record: ShellTaskRecord = {
      id,
      conversationId,
      ...(input.runInstanceId ? { runInstanceId: input.runInstanceId } : {}),
      command,
      cwd,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      bytes: 0,
      truncated: false,
      maxOutputBytes,
      outputPath: path.join(SHELL_TASKS_DIR, `${id}.log`),
      token,
      pid: child.pid,
      child,
      fd,
      killRequested: false,
      killTimer: null,
      waiters: new Set(),
    };
    this.tasks.set(id, record);
    this.writeRegistry();
    child.stdout?.on('data', (chunk: Buffer | string) => this.appendOutput(record, toBuffer(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => this.appendOutput(record, toBuffer(chunk)));
    child.once('error', (error) => {
      this.appendOutput(record, Buffer.from(`[background shell failed to start: ${error.message}]\n`));
      this.finishTask(record, { exitCode: null, signal: null, failed: true });
    });
    child.once('close', (exitCode, signal) => this.finishTask(record, { exitCode, signal, failed: false }));
    return { ok: true, task: this.snapshot(record) };
  }

  async output(input: ShellTaskOutputInput): Promise<ShellTaskQueryResult> {
    const conversationId = String(input.conversationId || '').trim();
    if (!conversationId) return failure('missing_conversation', 'shell_output requires a conversation.');
    const taskId = String(input.taskId || '').trim();
    if (!taskId) return { ok: true, tasks: this.listRecords(conversationId).map((record) => this.snapshot(record)) };

    const record = this.tasks.get(taskId);
    if (!record || record.conversationId !== conversationId) {
      return failure('task_not_found', `No background shell task ${taskId} belongs to this conversation. Use shell_output without task_id to list tasks.`);
    }
    const offset = Math.max(0, Math.trunc(numberOr(input.offset, 0)));
    const waitMs = clampInteger(input.waitMs, 0, 0, MAX_WAIT_MS);
    const maxChars = clampInteger(input.maxChars, DEFAULT_OUTPUT_CHARS, 1, MAX_OUTPUT_CHARS);

    const deadline = Date.now() + waitMs;
    let chunk = this.readOutput(record, offset, maxChars);
    while (!chunk.output && record.status === 'running' && Date.now() < deadline) {
      await this.waitForChange(record, record.bytes, Math.max(1, deadline - Date.now()));
      chunk = this.readOutput(record, offset, maxChars);
    }
    return {
      ok: true,
      task: this.snapshot(record),
      output: chunk.output,
      nextOffset: chunk.nextOffset,
      truncated: chunk.capped,
    };
  }

  kill(input: ShellTaskKillInput): ShellTaskMutationResult {
    const conversationId = String(input.conversationId || '').trim();
    if (!conversationId) return failure('missing_conversation', 'shell_kill requires a conversation.');
    const taskId = String(input.taskId || '').trim();
    if (!taskId) return failure('missing_task_id', 'shell_kill requires task_id.');
    const record = this.tasks.get(taskId);
    if (!record || record.conversationId !== conversationId) {
      return failure('task_not_found', `No background shell task ${taskId} belongs to this conversation.`);
    }
    if (record.status === 'running') this.requestKill(record, input.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    return { ok: true, task: this.snapshot(record) };
  }

  /** Backend shutdown: give every task a chance to exit, then kill what is left. */
  async cleanupAll(): Promise<void> {
    const running = [...this.tasks.values()].filter((record) => record.status === 'running');
    if (!running.length) {
      this.writeRegistry();
      return;
    }
    for (const record of running) {
      record.killRequested = true;
      terminateProcessTree(record.pid, 'SIGTERM');
    }
    await waitUntil(() => running.every((record) => record.status !== 'running'), PROCESS_KILL_GRACE_MS + 500);
    const survivors = running.filter((record) => record.status === 'running');
    for (const record of survivors) terminateProcessTree(record.pid, 'SIGKILL');
    if (survivors.length) await waitUntil(() => survivors.every((record) => record.status !== 'running'), 1_000);
    for (const record of [...this.tasks.values()]) {
      if (record.status === 'running') this.finishTask(record, { exitCode: null, signal: 'SIGKILL', failed: true });
    }
    this.writeRegistry();
  }

  /**
   * Startup: kill task processes inherited from a previous backend process.
   * Only processes whose environment carries the recorded token are signalled,
   * so a recycled pid from an unrelated program is left alone.
   */
  async recoverOrphans(): Promise<void> {
    const entries = this.readRegistry();
    const orphans = entries.filter((entry) => processHasTaskToken(entry.pid, entry.token));
    if (orphans.length) {
      for (const entry of orphans) terminateProcessTree(entry.pid, 'SIGTERM');
      await waitUntil(() => orphans.every((entry) => !processIsAlive(entry.pid)), ORPHAN_KILL_WAIT_MS);
      for (const entry of orphans) {
        if (processIsAlive(entry.pid)) terminateProcessTree(entry.pid, 'SIGKILL');
      }
      await delay(ORPHAN_KILL_GRACE_MS);
    }
    this.writeRegistry();
    // Logs of the previous backend's tasks cannot be queried any more: task
    // snapshots live in memory only. Drop them so restarts do not accumulate
    // orphaned output files.
    this.removeStaleLogs();
  }

  /** Test hook: stop everything and drop logs/registry so each test starts clean. */
  async resetForTest(): Promise<void> {
    await this.cleanupAll();
    for (const record of [...this.tasks.values()]) this.releaseRecord(record);
    this.tasks.clear();
    removeQuietly(SHELL_TASK_REGISTRY_PATH);
    try {
      fs.rmSync(SHELL_TASKS_DIR, { recursive: true, force: true });
    } catch { /* Another test process may own the directory. */ }
  }

  private listRecords(conversationId: string): ShellTaskRecord[] {
    return [...this.tasks.values()]
      .filter((record) => record.conversationId === conversationId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  private readOutput(record: ShellTaskRecord, offset: number, maxChars: number): { output: string; nextOffset: number; capped: boolean } {
    const total = record.bytes;
    if (offset >= total) return { output: '', nextOffset: total, capped: false };
    const length = Math.min(maxChars, total - offset);
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    let fd: number | null = null;
    try {
      fd = fs.openSync(record.outputPath, 'r');
      while (filled < length) {
        const read = fs.readSync(fd, buffer, filled, length - filled, offset + filled);
        if (read <= 0) break;
        filled += read;
      }
    } catch {
      return { output: '', nextOffset: offset, capped: false };
    } finally {
      if (fd !== null) closeQuietly(fd);
    }
    if (filled <= 0) return { output: '', nextOffset: offset, capped: false };
    const view = buffer.subarray(0, filled);
    const validLength = validUtf8Length(view);
    const output = view.subarray(0, validLength).toString('utf8');
    const nextOffset = offset + validLength;
    return { output, nextOffset, capped: validLength < total - offset };
  }

  private waitForChange(record: ShellTaskRecord, seenBytes: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(finish);
        resolve();
      };
      // Not unref'd: the caller is awaiting this wait, so the timer must keep
      // the event loop alive until new output arrives or the timeout fires.
      const timer = setTimeout(finish, timeoutMs);
      record.waiters.add(finish);
      if (record.bytes !== seenBytes || record.status !== 'running') finish();
    });
  }

  private notify(record: ShellTaskRecord): void {
    for (const waiter of [...record.waiters]) waiter();
  }

  private appendOutput(record: ShellTaskRecord, chunk: Buffer): void {
    if (record.status !== 'running' || record.fd === null || !chunk.length) return;
    if (record.truncated) return;
    const remaining = record.maxOutputBytes - record.bytes;
    if (remaining <= 0) {
      record.truncated = true;
      this.notify(record);
      return;
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    try {
      fs.writeSync(record.fd, slice);
      record.bytes += slice.length;
    } catch { /* A write failure must not crash the backend; the task still exits normally. */ }
    if (chunk.length > remaining) record.truncated = true;
    this.notify(record);
  }

  private finishTask(record: ShellTaskRecord, outcome: { exitCode: number | null; signal: string | null; failed: boolean }): void {
    if (record.status !== 'running') return;
    if (record.killTimer) {
      clearTimeout(record.killTimer);
      record.killTimer = null;
    }
    record.exitCode = outcome.exitCode;
    record.signal = outcome.signal;
    record.endedAt = new Date().toISOString();
    record.status = record.killRequested
      ? 'killed'
      : outcome.failed || outcome.exitCode !== 0
        ? 'failed'
        : 'completed';
    if (record.fd !== null) {
      closeQuietly(record.fd);
      record.fd = null;
    }
    record.child = null;
    this.writeRegistry();
    this.notify(record);
  }

  private requestKill(record: ShellTaskRecord, signal: 'SIGTERM' | 'SIGKILL'): void {
    record.killRequested = true;
    terminateProcessTree(record.pid, signal);
    if (signal === 'SIGTERM' && !record.killTimer) {
      record.killTimer = setTimeout(() => {
        record.killTimer = null;
        if (record.status === 'running') terminateProcessTree(record.pid, 'SIGKILL');
      }, PROCESS_KILL_GRACE_MS);
      record.killTimer.unref?.();
    }
  }

  private releaseRecord(record: ShellTaskRecord): void {
    if (record.killTimer) {
      clearTimeout(record.killTimer);
      record.killTimer = null;
    }
    if (record.fd !== null) closeQuietly(record.fd);
    record.fd = null;
    record.child = null;
    record.waiters.clear();
  }

  private removeStaleLogs(): void {
    let names: string[];
    try {
      names = fs.readdirSync(SHELL_TASKS_DIR);
    } catch {
      return;
    }
    const live = new Set([...this.tasks.values()].map((record) => path.basename(record.outputPath)));
    for (const name of names) {
      if (!live.has(name)) removeQuietly(path.join(SHELL_TASKS_DIR, name));
    }
  }

  private pruneTerminalTasks(conversationId: string): void {
    const terminal = [...this.tasks.values()]
      .filter((record) => record.conversationId === conversationId && record.status !== 'running')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const excess = terminal.length - MAX_TERMINAL_TASKS_PER_CONVERSATION;
    for (const record of terminal.slice(0, Math.max(0, excess))) {
      this.tasks.delete(record.id);
      this.releaseRecord(record);
      removeQuietly(record.outputPath);
    }
  }

  private snapshot(record: ShellTaskRecord): ShellTaskSnapshot {
    return {
      id: record.id,
      conversationId: record.conversationId,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      bytes: record.bytes,
      truncated: record.truncated,
    };
  }

  private readRegistry(): RegistryEntry[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(SHELL_TASK_REGISTRY_PATH, 'utf8')) as { tasks?: unknown };
      if (!Array.isArray(parsed?.tasks)) return [];
      return parsed.tasks.filter((item): item is RegistryEntry => Boolean(item)
        && typeof (item as RegistryEntry).id === 'string'
        && Number.isInteger((item as RegistryEntry).pid)
        && typeof (item as RegistryEntry).token === 'string'
        && typeof (item as RegistryEntry).outputPath === 'string');
    } catch {
      return [];
    }
  }

  private writeRegistry(): void {
    const entries: RegistryEntry[] = [...this.tasks.values()]
      .filter((record) => record.status === 'running' && record.pid)
      .map((record) => ({
        id: record.id,
        pid: record.pid as number,
        token: record.token,
        startedAt: record.startedAt,
        outputPath: record.outputPath,
      }));
    try {
      fs.mkdirSync(path.dirname(SHELL_TASK_REGISTRY_PATH), { recursive: true });
      const temp = `${SHELL_TASK_REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ tasks: entries }, null, 2)}\n`);
      fs.renameSync(temp, SHELL_TASK_REGISTRY_PATH);
    } catch { /* Registry is best-effort: losing it only skips orphan cleanup. */ }
  }
}

export const shellTaskManager = new ShellTaskManager();

function failure(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch { /* Already closed. */ }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch { /* Missing or locked files are harmless. */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(20);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processHasTaskToken(pid: number, token: string): boolean {
  if (!processIsAlive(pid) || process.platform !== 'linux') return false;
  try {
    const environment = fs.readFileSync(`/proc/${pid}/environ`).toString();
    return environment.split('\0').includes(`${SHELL_TASK_TOKEN_ENV}=${token}`);
  } catch {
    return false;
  }
}

/**
 * Length of the longest prefix that ends on a UTF-8 code-point boundary.
 * Chunked stdout can split a multi-byte character across writes; trimming the
 * tail keeps offsets byte-accurate so the next read picks the character up
 * instead of rendering a replacement character.
 */
function validUtf8Length(buffer: Buffer): number {
  let end = buffer.length;
  let index = end - 1;
  let continuations = 0;
  while (index >= 0 && (buffer[index] & 0xc0) === 0x80) {
    continuations += 1;
    index -= 1;
  }
  if (index < 0) return 0;
  const leading = buffer[index];
  const expected = leading >= 0xf0 ? 4 : leading >= 0xe0 ? 3 : leading >= 0xc0 ? 2 : 1;
  if (expected === 1) return end;
  return 1 + continuations < expected ? index : end;
}
