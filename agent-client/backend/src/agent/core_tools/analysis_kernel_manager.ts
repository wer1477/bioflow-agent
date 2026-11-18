import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkspaceArtifact, type WorkspaceArtifact } from '../config/workspace_artifact_store.js';
import { writeProjectFileBuffer } from '../config/project_files.js';
import { CoreToolExecutionAbortedError, clampNumber, workspaceCacheEnvironment } from './shared.js';
import { ensureProjectVenv, projectVenvBinPath, projectVenvEnabled, projectVenvEnvironment, projectVenvPythonPath } from './project_venv.js';
import { PROCESS_KILL_GRACE_MS, terminateProcessTree } from './process_tree.js';
import { readImageFilePayload } from './read_media.js';
import { RUNTIME_STATE_ROOT } from '../../paths.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESULT_CHARS = 12_000;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_KERNEL_IMAGES = 4;
const MAX_KERNEL_IMAGE_BYTES = 6 * 1024 * 1024;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
const MAX_EXPIRED_MARKS = 256;
const REGISTRY_PATH = path.join(RUNTIME_STATE_ROOT, 'analysis-kernels.json');

/** A kernel session is closed after this much idle time; cached sessions are LRU-bounded. */
export const ANALYSIS_KERNEL_IDLE_TTL_MS = 30 * 60 * 1000;
export const MAX_CACHED_ANALYSIS_KERNELS = 4;

export interface ExecutePythonInput {
  conversationId: string;
  /** Absolute project directory: the kernel's working directory. */
  projectPath: string;
  runInstanceId: string;
  code: string;
  timeoutMs?: unknown;
  abortSignal?: AbortSignal;
}

export interface KernelImagePayload {
  mimeType: string;
  data: string;
  label?: string;
}

export interface KernelExecutionResult {
  ok: boolean;
  session: 'new' | 'resumed' | 'recreated';
  stdout: string;
  stderr: string;
  resultPreview?: string;
  artifacts: WorkspaceArtifact[];
  images?: KernelImagePayload[];
  error?: { code: string; message: string };
}

type Pending = {
  resolve: (value: KernelExecutionResult) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
  abort?: () => void;
  signal?: AbortSignal;
  session: KernelExecutionResult['session'];
  conversationId: string;
  projectPath: string;
  runInstanceId: string;
  cellId: string;
  tempDir: string;
};

type Session = {
  /** Conversation id: one kernel per conversation, shared by every run in it. */
  key: string;
  conversationId: string;
  projectPath: string;
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  pending: Map<string, Pending>;
  tail: Promise<unknown>;
  state: 'new' | 'recreated';
  token: string;
  lastUsedAt: number;
};

type RegistryEntry = { pid: number; token: string; startedAt: string };

/**
 * Owns persistent Python workers and hides process, queue, timeout and artifact details.
 *
 * Sessions are keyed by conversation, not by run: a run that ends leaves its
 * kernel warm so the next run of the same conversation resumes where the last
 * one stopped. Kernels are still disposable infrastructure: crashes, timeouts
 * and user aborts close them, and the following call reports `recreated`.
 * Idle kernels are closed after 30 minutes and at most four conversations stay
 * cached (LRU) to bound memory and subprocess count.
 */
export class AnalysisKernelManager {
  private readonly sessions = new Map<string, Session>();
  private readonly expiredSessions = new Set<string>();
  private readonly idleTtlMs: number;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: { idleTtlMs?: number } = {}) {
    this.idleTtlMs = options.idleTtlMs && options.idleTtlMs > 0 ? options.idleTtlMs : ANALYSIS_KERNEL_IDLE_TTL_MS;
  }

  async executePython(input: ExecutePythonInput): Promise<KernelExecutionResult> {
    if (!input.conversationId) {
      return this.failure('new', 'missing_conversation', 'execute_python requires a conversation bound to a project directory.');
    }
    if (!input.projectPath) return this.failure('new', 'missing_project', 'execute_python requires a project directory.');
    if (!input.code.trim()) return this.failure('new', 'missing_code', 'execute_python requires code.');
    if (input.abortSignal?.aborted) throw new CoreToolExecutionAbortedError();

    await this.cleanupIdleSessions();
    const conversationId = input.conversationId;
    const projectPath = path.resolve(input.projectPath);
    let existing = this.sessions.get(conversationId);
    if (existing && existing.projectPath !== projectPath) {
      await this.closeSession(existing, 'Python kernel session was closed because the session project directory changed.');
      existing = undefined;
    }
    if (!existing && projectVenvEnabled()) {
      await ensureProjectVenv(projectPath);
      // Another call for the same conversation may have created the session while
      // the venv was being prepared; re-check before starting a second kernel.
      existing = this.sessions.get(conversationId);
      if (existing && existing.projectPath !== projectPath) {
        await this.closeSession(existing, 'Python kernel session was closed because the session project directory changed.');
        existing = undefined;
      }
    }
    const session = existing ?? this.startSession(projectPath, conversationId);
    const state: KernelExecutionResult['session'] = existing ? 'resumed' : session.state;
    session.lastUsedAt = Date.now();
    void this.evictLeastRecentlyUsed(conversationId);
    const operation = session.tail.catch(() => undefined).then(() => this.executeOnSession(session, input, state));
    session.tail = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Compatibility no-op. Kernels survive the run that used them; the runtime no
   * longer calls this. Kept so out-of-tree callers do not break.
   */
  async cleanupRun(_runInstanceId: string): Promise<void> {
    return undefined;
  }

  /** Close the kernel cached for one conversation (project deletion, reset, tests). */
  async cleanupConversation(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (session) await this.closeSession(session, 'Python kernel session was closed for this conversation.');
  }

  /** Close kernels idle for at least `maxIdleMs`; used by the idle sweep timer and tests. */
  async cleanupIdleSessions(maxIdleMs: number = this.idleTtlMs): Promise<void> {
    const now = Date.now();
    const idle = [...this.sessions.values()].filter((session) => session.pending.size === 0 && now - session.lastUsedAt >= maxIdleMs);
    await Promise.all(idle.map((session) => this.closeSession(session, `Python kernel session was closed after ${Math.round(maxIdleMs / 1000)}s of inactivity.`)));
  }

  async cleanupAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.closeSession(session, 'Python kernel session was closed because the backend is stopping.')));
    this.clearIdleTimer();
  }

  async recoverOrphans(): Promise<void> {
    const entries = this.readRegistry().filter((entry) => processHasKernelToken(entry.pid, entry.token));
    for (const entry of entries) terminateProcessTree(entry.pid, 'SIGTERM');
    if (entries.length) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const entry of entries) terminateProcessTree(entry.pid, 'SIGKILL');
    }
    this.writeRegistry([]);
  }

  private startSession(projectPath: string, conversationId: string): Session {
    const workspace = path.resolve(projectPath);
    const token = crypto.randomUUID();
    const child = spawn(resolvePythonExecutable(workspace), ['-u', workerPath()], {
      cwd: workspace,
      env: analysisEnvironment(token, workspace),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state: Session['state'] = this.expiredSessions.delete(conversationId) ? 'recreated' : 'new';
    const session: Session = {
      key: conversationId,
      conversationId,
      projectPath: workspace,
      child,
      buffer: '',
      pending: new Map(),
      tail: Promise.resolve(),
      state,
      token,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(conversationId, session);
    this.addRegistry(child.pid, token);
    child.stdout.on('data', (chunk) => this.consumeOutput(session, String(chunk)));
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => void this.closeSession(session, `Unable to start Python kernel: ${error.message}`));
    child.once('close', () => void this.closeSession(session, 'Python kernel exited unexpectedly.'));
    this.ensureIdleTimer();
    return session;
  }

  private executeOnSession(session: Session, input: ExecutePythonInput, state: KernelExecutionResult['session']): Promise<KernelExecutionResult> {
    if (!this.sessions.has(session.key)) return Promise.resolve(this.failure('recreated', 'session_closed', 'Python kernel session was closed.'));
    const cellId = crypto.randomUUID();
    const tempDir = path.join(path.resolve(input.projectPath), '.bioflow', 'kernel', '.tmp', input.runInstanceId, cellId);
    const timeoutMs = clampNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
    return new Promise<KernelExecutionResult>((resolve, reject) => {
      const finishAbort = () => {
        this.rejectPending(session, cellId, new CoreToolExecutionAbortedError());
        void this.closeSession(session, 'Python kernel execution cancelled.');
      };
      const timeout = setTimeout(() => {
        this.finishPending(session, cellId, this.failure(state, 'timeout', `Python execution timed out after ${timeoutMs / 1000}s.`));
        void this.closeSession(session, `Python execution timed out after ${timeoutMs / 1000}s.`);
      }, timeoutMs);
      const pending: Pending = { resolve, reject, timeout, abort: finishAbort, signal: input.abortSignal, session: state, conversationId: input.conversationId, projectPath: path.resolve(input.projectPath), runInstanceId: input.runInstanceId, cellId, tempDir };
      input.abortSignal?.addEventListener('abort', finishAbort, { once: true });
      session.pending.set(cellId, pending);
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        session.child.stdin.write(`${JSON.stringify({ id: cellId, code: input.code, artifactDir: tempDir })}\n`);
      } catch (error) {
        this.finishPending(session, cellId, this.failure(state, 'send_failed', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  private consumeOutput(session: Session, chunk: string): void {
    session.buffer += chunk;
    let newline = session.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = session.buffer.slice(0, newline);
      session.buffer = session.buffer.slice(newline + 1);
      try {
        const payload = JSON.parse(line) as { id?: string; ok?: boolean; stdout?: string; stderr?: string; value?: string | null; error?: string; figures?: string[] };
        if (payload.id) void this.handleWorkerResult(session, payload.id, payload);
      } catch { /* Ignore malformed worker diagnostics. */ }
      newline = session.buffer.indexOf('\n');
    }
  }

  private async handleWorkerResult(session: Session, cellId: string, payload: { ok?: boolean; stdout?: string; stderr?: string; value?: string | null; error?: string; figures?: string[] }): Promise<void> {
    const pending = session.pending.get(cellId);
    if (!pending) return;
    const figures = payload.figures || [];
    const artifacts = await this.promoteFigures(pending, figures);
    const images = await this.readFigureImages(pending, figures);
    const result: KernelExecutionResult = payload.ok
      ? {
          ok: true,
          session: pending.session,
          stdout: limitText(payload.stdout),
          stderr: limitText(payload.stderr),
          ...(payload.value ? { resultPreview: limitText(payload.value) } : {}),
          artifacts,
          ...(images.length ? { images } : {}),
        }
      : {
          ok: false,
          session: pending.session,
          stdout: limitText(payload.stdout),
          stderr: limitText(payload.stderr),
          artifacts,
          ...(images.length ? { images } : {}),
          error: { code: 'python_error', message: limitText(payload.error) || 'Python execution failed.' },
        };
    this.finishPending(session, cellId, result);
    await fsp.rm(pending.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async promoteFigures(pending: Pending, figures: string[]): Promise<WorkspaceArtifact[]> {
    const artifacts: WorkspaceArtifact[] = [];
    for (const name of figures.filter((item) => /^[a-zA-Z0-9._-]+\.png$/.test(item))) {
      const source = path.join(pending.tempDir, name);
      try {
        const buffer = await fsp.readFile(source);
        if (buffer.length > MAX_ARTIFACT_BYTES) continue;
        const relativePath = `.bioflow/kernel/${pending.runInstanceId}/${pending.cellId}/${name}`;
        const file = writeProjectFileBuffer(pending.projectPath, relativePath, buffer);
        artifacts.push(createWorkspaceArtifact({
          conversationId: pending.conversationId,
          scope: 'execution',
          planId: null,
          executionId: pending.runInstanceId,
          type: 'figure',
          title: name,
          path: relativePath,
          mimeType: file.mimeType,
          summary: 'Generated by execute_python.',
          tags: ['analysis', 'python', 'figure'],
          status: 'ready',
          createdByAgentId: null,
          metadata: {},
        }));
      } catch { /* Missing figures do not invalidate the cell result. */ }
    }
    return artifacts;
  }

  /**
   * Attach generated figures as model-visible images (at most four, ≤6 MiB
   * each). Reading is best-effort: a figure that cannot be decoded still stays
   * available as a workspace artifact.
   */
  private async readFigureImages(pending: Pending, figures: string[]): Promise<KernelImagePayload[]> {
    const images: KernelImagePayload[] = [];
    for (const name of figures.filter((item) => /^[a-zA-Z0-9._-]+\.png$/.test(item))) {
      if (images.length >= MAX_KERNEL_IMAGES) break;
      const source = path.join(pending.tempDir, name);
      try {
        const stat = await fsp.stat(source);
        if (!stat.isFile() || stat.size > MAX_KERNEL_IMAGE_BYTES) continue;
        const image = await readImageFilePayload(source);
        if (!image || typeof image.data !== 'string' || !image.data || typeof image.mimeType !== 'string' || !image.mimeType.startsWith('image/')) continue;
        images.push({ mimeType: image.mimeType, data: image.data, label: name });
      } catch { /* Figure rendering is optional. */ }
    }
    return images;
  }

  private finishPending(session: Session, cellId: string, result: KernelExecutionResult): void {
    const pending = session.pending.get(cellId);
    if (!pending) return;
    session.pending.delete(cellId);
    session.lastUsedAt = Date.now();
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener('abort', pending.abort!);
    pending.resolve(result);
  }

  private rejectPending(session: Session, cellId: string, error: Error): void {
    const pending = session.pending.get(cellId);
    if (!pending) return;
    session.pending.delete(cellId);
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener('abort', pending.abort!);
    pending.reject(error);
  }

  private async closeSession(session: Session, message: string, marksExpired = true): Promise<void> {
    if (this.sessions.get(session.key) !== session) return;
    this.sessions.delete(session.key);
    if (marksExpired) this.markExpired(session.key);
    if (session.child.exitCode === null && session.child.signalCode === null) {
      terminateProcessTree(session.child.pid, 'SIGTERM');
      const kill = setTimeout(() => terminateProcessTree(session.child.pid, 'SIGKILL'), PROCESS_KILL_GRACE_MS);
      kill.unref?.();
      session.child.once('close', () => clearTimeout(kill));
    }
    for (const [cellId, pending] of session.pending) {
      session.pending.delete(cellId);
      clearTimeout(pending.timeout);
      pending.signal?.removeEventListener('abort', pending.abort!);
      pending.resolve(this.failure(pending.session, 'session_closed', message));
    }
    this.removeRegistry(session.child.pid, session.token);
    if (!this.sessions.size) this.clearIdleTimer();
  }

  private async evictLeastRecentlyUsed(keepKey?: string): Promise<void> {
    while (this.sessions.size > MAX_CACHED_ANALYSIS_KERNELS) {
      const victim = [...this.sessions.values()]
        .filter((session) => session.pending.size === 0 && session.key !== keepKey)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!victim) return;
      await this.closeSession(victim, 'Python kernel session was closed to keep the most recently used conversations.');
    }
  }

  private markExpired(key: string): void {
    this.expiredSessions.delete(key);
    this.expiredSessions.add(key);
    if (this.expiredSessions.size > MAX_EXPIRED_MARKS) {
      const oldest = this.expiredSessions.values().next().value;
      if (oldest !== undefined) this.expiredSessions.delete(oldest);
    }
  }

  private ensureIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.cleanupIdleSessions().then(() => this.evictLeastRecentlyUsed()).catch(() => undefined);
    }, IDLE_SWEEP_INTERVAL_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private failure(session: KernelExecutionResult['session'], code: string, message: string): KernelExecutionResult {
    return { ok: false, session, stdout: '', stderr: '', artifacts: [], error: { code, message } };
  }

  private readRegistry(): RegistryEntry[] { try { const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); return Array.isArray(parsed?.sessions) ? parsed.sessions.filter((item: any) => Number.isInteger(item?.pid) && typeof item?.token === 'string') : []; } catch { return []; } }
  private writeRegistry(entries: RegistryEntry[]): void { fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true }); const temp = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temp, `${JSON.stringify({ sessions: entries }, null, 2)}\n`); fs.renameSync(temp, REGISTRY_PATH); }
  private addRegistry(pid: number | undefined, token: string): void { if (!pid) return; const entries = this.readRegistry(); this.writeRegistry([...entries.filter((entry) => entry.pid !== pid), { pid, token, startedAt: new Date().toISOString() }]); }
  private removeRegistry(pid: number | undefined, token: string): void { if (!pid) return; this.writeRegistry(this.readRegistry().filter((entry) => entry.pid !== pid || entry.token !== token)); }
}

function workerPath(): string { return path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'python_kernel_worker.py'); }
function resolvePythonExecutable(projectPath: string): string {
  if (projectVenvEnabled()) {
    const venvPython = projectVenvPythonPath(projectPath);
    if (fs.existsSync(venvPython)) return venvPython;
  }
  const configured = process.env.BIOAGENT_PYTHON;
  if (configured) return configured;
  const bin = process.env.BIOAGENT_ENV_BIN;
  if (bin) {
    const candidate = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}
function analysisEnvironment(token: string, projectPath: string): NodeJS.ProcessEnv {
  const include = ['HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'CONDA_PREFIX', 'VIRTUAL_ENV'];
  const venv = projectVenvEnvironment(projectPath);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, MPLBACKEND: 'Agg', PYTHONUNBUFFERED: '1', BIOAGENT_ANALYSIS_KERNEL_TOKEN: token, ...workspaceCacheEnvironment() };
  for (const key of include) if (process.env[key]) env[key] = process.env[key];
  if (process.env.BIOAGENT_ENV_BIN) env.PATH = [process.env.BIOAGENT_ENV_BIN, env.PATH].filter(Boolean).join(path.delimiter);
  if (venv.VIRTUAL_ENV) {
    env.PATH = [projectVenvBinPath(projectPath), env.PATH].filter(Boolean).join(path.delimiter);
    // The project venv must win over any VIRTUAL_ENV/CONDA_PREFIX inherited from the
    // backend process, otherwise pip would target the wrong interpreter.
    Object.assign(env, venv);
    delete env.CONDA_PREFIX;
  }
  return env;
}
function limitText(value: unknown): string { const text = typeof value === 'string' ? value : ''; return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text; }
function processHasKernelToken(pid: number, token: string): boolean { if (process.platform !== 'linux') return false; try { return fs.readFileSync(`/proc/${pid}/environ`).toString().split('\0').includes(`BIOAGENT_ANALYSIS_KERNEL_TOKEN=${token}`); } catch { return false; } }

export const analysisKernelManager = new AnalysisKernelManager();
