import { spawn } from 'node:child_process';
import type { CoreToolExecutionContext } from '../core_tools_runtime.js';
import { ensureProjectVenv } from './project_venv.js';
import { CoreToolExecutionAbortedError, clampNumber, resolveShellWorkingDirectory, toolProcessEnvironment } from './shared.js';
import { resolveToolRoot } from './project_paths.js';
import { PROCESS_KILL_GRACE_MS, terminateProcessTree } from './process_tree.js';
import { DEFAULT_OUTPUT_CHARS, MAX_OUTPUT_CHARS, MAX_WAIT_MS, shellTaskManager, type ShellTaskSnapshot } from './shell_tasks.js';

const DEFAULT_COMMAND_OUTPUT_CHARS = 50_000;
interface OutputCapture { value: string; truncated: boolean; }

export async function executeShellCommand(args: Record<string, unknown>, context: CoreToolExecutionContext): Promise<Record<string, unknown>> {
  const command = String(args.cmd || '').trim();
  if (!command) throw new Error('exec_command requires cmd.');
  const projectPath = resolveToolRoot(context);
  const cwd = resolveShellWorkingDirectory(args.workdir, projectPath);
  // A no-op when the feature is off or the venv already exists.
  await ensureProjectVenv(projectPath);
  if (args.run_in_background === true) return startBackgroundTask(command, cwd, projectPath, context);
  return runShellCommand(
    command,
    cwd,
    projectPath,
    clampNumber(args.timeout_ms, 30_000, 1_000, 300_000),
    clampNumber(args.max_output_chars, DEFAULT_COMMAND_OUTPUT_CHARS, 1_000, 200_000),
    context.abortSignal,
  );
}


/**
 * Background shell task entry point. The task intentionally is not attached to
 * the current run (no abort signal): it must survive the run that started it.
 * All process management lives in `shell_tasks.ts`.
 */
async function startBackgroundTask(command: string, cwd: string, projectPath: string, context: CoreToolExecutionContext): Promise<Record<string, unknown>> {
  if (!context.conversationId) {
    return { ok: false, error: { code: 'missing_conversation', message: 'Background shell tasks require a conversation.' } };
  }
  const result = shellTaskManager.start({
    conversationId: context.conversationId,
    ...(context.runInstanceId ? { runInstanceId: context.runInstanceId } : {}),
    command,
    cwd,
    projectPath,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    background: true,
    task_id: result.task.id,
    status: result.task.status,
    cwd: result.task.cwd,
    command: result.task.command,
  };
}


export async function executeShellOutput(args: Record<string, unknown>, context: CoreToolExecutionContext): Promise<Record<string, unknown>> {
  if (!context.conversationId) {
    return { ok: false, error: { code: 'missing_conversation', message: 'shell_output requires a conversation.' } };
  }
  const result = await shellTaskManager.output({
    conversationId: context.conversationId,
    ...(args.task_id === undefined ? {} : { taskId: String(args.task_id) }),
    offset: clampNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    waitMs: clampNumber(args.wait_ms, 0, 0, MAX_WAIT_MS),
    maxChars: clampNumber(args.max_chars, DEFAULT_OUTPUT_CHARS, 1, MAX_OUTPUT_CHARS),
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (result.tasks) return { ok: true, tasks: result.tasks.map(serializeShellTask) };
  return {
    ok: true,
    ...(result.task ? { task: serializeShellTask(result.task) } : {}),
    output: result.output || '',
    next_offset: result.nextOffset || 0,
    truncated: result.truncated === true,
  };
}


export async function executeShellKill(args: Record<string, unknown>, context: CoreToolExecutionContext): Promise<Record<string, unknown>> {
  if (!context.conversationId) {
    return { ok: false, error: { code: 'missing_conversation', message: 'shell_kill requires a conversation.' } };
  }
  const taskId = String(args.task_id || '').trim();
  if (!taskId) return { ok: false, error: { code: 'missing_task_id', message: 'shell_kill requires task_id.' } };
  const signal = args.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
  const result = shellTaskManager.kill({ conversationId: context.conversationId, taskId, signal });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, ...serializeShellTask(result.task) };
}


/** Model-facing result fields follow the snake_case convention of the other core tools. */
function serializeShellTask(task: ShellTaskSnapshot): Record<string, unknown> {
  return {
    task_id: task.id,
    conversation_id: task.conversationId,
    command: task.command,
    cwd: task.cwd,
    status: task.status,
    exit_code: task.exitCode,
    signal: task.signal,
    started_at: task.startedAt,
    ended_at: task.endedAt,
    bytes: task.bytes,
    truncated: task.truncated,
  };
}


function runShellCommand(command: string, cwd: string, projectPath: string, timeoutMs: number, maxOutputChars: number, abortSignal?: AbortSignal): Promise<Record<string, unknown>> {
  const env = shellEnvironment(projectPath);
  return new Promise((resolve, reject) => {
    // A detached POSIX shell is its own process-group leader. That lets
    // cancellation kill a shell and all of its descendants without signalling
    // the backend process group itself.
    const child = process.platform === 'win32'
      ? spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('/bin/sh', ['-lc', command], {
          cwd,
          windowsHide: true,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    const stdout = createOutputCapture(maxOutputChars);
    const stderr = createOutputCapture(maxOutputChars);
    let timedOut = false;
    let settled = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (preserveAbortKillTimer = false) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      if (!preserveAbortKillTimer && abortKillTimer) clearTimeout(abortKillTimer);
      abortSignal?.removeEventListener('abort', abort);
    };
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () => {
      if (settled) return;
      terminateProcessTree(child.pid, 'SIGTERM');
      abortKillTimer = setTimeout(() => terminateProcessTree(child.pid, 'SIGKILL'), PROCESS_KILL_GRACE_MS);
      abortKillTimer.unref?.();
      child.once('close', () => {
        if (abortKillTimer) clearTimeout(abortKillTimer);
      });
      settled = true;
      cleanup(true);
      reject(new CoreToolExecutionAbortedError());
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, 'SIGTERM');
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (timedOut) terminateProcessTree(child.pid, 'SIGKILL');
    }, timeoutMs + PROCESS_KILL_GRACE_MS);

    abortSignal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (chunk) => appendOutput(stdout, String(chunk)));
    child.stderr?.on('data', (chunk) => appendOutput(stderr, String(chunk)));
    child.on('error', (err) => finish({ ok: false, cwd, command, error: err.message, timedOut, stdout: formatOutput(stdout), stderr: formatOutput(stderr) }));
    child.on('close', (exitCode, signal) => finish({
      ok: exitCode === 0 && !timedOut,
      cwd,
      command,
      exit_code: exitCode,
      signal,
      timed_out: timedOut,
      stdout: formatOutput(stdout),
      stderr: formatOutput(stderr),
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
    }));
  });
}


function shellEnvironment(projectPath: string): NodeJS.ProcessEnv {
  return toolProcessEnvironment(projectPath);
}


interface OutputCapture {
  maxChars: number;
  value: string;
  head: string;
  tail: string;
  truncated: boolean;
}


function createOutputCapture(maxChars: number): OutputCapture {
  return { maxChars, value: '', head: '', tail: '', truncated: false };
}


function appendOutput(capture: OutputCapture, chunk: string): void {
  if (!capture.truncated && capture.value.length + chunk.length <= capture.maxChars) {
    capture.value += chunk;
    return;
  }
  if (!capture.truncated) {
    const combined = `${capture.value}${chunk}`;
    const headSize = Math.ceil(capture.maxChars / 2);
    capture.head = combined.slice(0, headSize);
    capture.tail = combined.slice(-Math.floor(capture.maxChars / 2));
    capture.value = '';
    capture.truncated = true;
    return;
  }
  capture.tail = `${capture.tail}${chunk}`.slice(-Math.floor(capture.maxChars / 2));
}


function formatOutput(capture: OutputCapture): string {
  return capture.truncated
    ? `${capture.head}\n\n... output truncated; middle omitted ...\n\n${capture.tail}`
    : capture.value;
}
