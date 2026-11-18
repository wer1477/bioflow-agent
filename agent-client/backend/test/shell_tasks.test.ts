import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test, { after } from 'node:test';
import {
  MAX_TASKS_PER_CONVERSATION,
  SHELL_TASK_REGISTRY_PATH,
  ShellTaskManager,
  shellTaskManager,
  type ShellTaskSnapshot,
} from '../src/agent/core_tools/shell_tasks.js';
import { executeShellCommand, executeShellKill, executeShellOutput } from '../src/agent/core_tools/shell_executor.js';

after(async () => {
  await shellTaskManager.resetForTest();
});

function conversationId(label: string): string {
  return `conv-${label}-${crypto.randomUUID()}`;
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'bioflow-shell-tasks-'));
}

function outputOf(result: Awaited<ReturnType<ShellTaskManager['output']>>): { output: string; nextOffset: number; truncated: boolean; task: ShellTaskSnapshot } {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error.message);
  assert.ok(result.task, 'expected a task snapshot');
  return { output: result.output || '', nextOffset: result.nextOffset || 0, truncated: result.truncated === true, task: result.task };
}

async function readAll(manager: ShellTaskManager, conversation: string, taskId: string, timeoutMs = 20_000): Promise<string> {
  const chunks: string[] = [];
  let offset = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const read = outputOf(await manager.output({ conversationId: conversation, taskId, offset, waitMs: 500 }));
    if (read.output) chunks.push(read.output);
    offset = read.nextOffset;
    if (read.task.status !== 'running' && offset >= read.task.bytes) break;
  }
  return chunks.join('');
}

async function waitForTerminal(manager: ShellTaskManager, conversation: string, taskId: string, timeoutMs = 20_000): Promise<ShellTaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline) {
    // Advance the offset on every read: reading from 0 would always return the
    // same buffered output and spin without yielding to the process-exit event.
    const read = outputOf(await manager.output({ conversationId: conversation, taskId, offset, waitMs: 500 }));
    offset = read.nextOffset;
    if (read.task.status !== 'running' && offset >= read.task.bytes) return read.task;
  }
  assert.fail(`background task ${taskId} did not finish within ${timeoutMs}ms`);
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
}

function writeRegistry(tasks: unknown[]): void {
  fs.mkdirSync(path.dirname(SHELL_TASK_REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(SHELL_TASK_REGISTRY_PATH, `${JSON.stringify({ tasks })}\n`);
}

function readRegistry(): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SHELL_TASK_REGISTRY_PATH, 'utf8')) as { tasks?: unknown };
    return Array.isArray(parsed.tasks) ? parsed.tasks as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

test('foreground exec_command keeps its existing result shape', async () => {
  const directory = await temporaryDirectory();
  try {
    const result = await executeShellCommand({ cmd: 'printf "hello\\n"' }, { projectPath: directory });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'hello\n');
    assert.equal(result.stderr, '');
    assert.equal(result.exit_code, 0);
    assert.equal(result.cwd, directory);
    assert.equal(result.background, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('starts a background task, keeps running while output is pending, and reports completion', async () => {
  const manager = shellTaskManager;
  const conversation = conversationId('basic');
  const directory = await temporaryDirectory();
  try {
    const started = manager.start({ conversationId: conversation, command: 'printf "first\\n"; sleep 0.15; printf "second\\n"', cwd: directory });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.task.status, 'running');
    assert.equal(started.task.cwd, directory);
    assert.equal(started.task.command, 'printf "first\\n"; sleep 0.15; printf "second\\n"');
    assert.equal(started.task.exitCode, null);
    assert.equal(started.task.endedAt, null);

    const output = await readAll(manager, conversation, started.task.id);
    assert.match(output, /first/);
    assert.match(output, /second/);

    const task = await waitForTerminal(manager, conversation, started.task.id);
    assert.equal(task.status, 'completed');
    assert.equal(task.exitCode, 0);
    assert.ok(task.endedAt);
    assert.ok(task.bytes >= output.length);
    assert.equal(task.truncated, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads new output by byte offset and waits with wait_ms instead of polling', async () => {
  const manager = shellTaskManager;
  const conversation = conversationId('offsets');
  const directory = await temporaryDirectory();
  try {
    const started = manager.start({ conversationId: conversation, command: 'printf "one\\n"; sleep 0.4; printf "two\\n"; sleep 5', cwd: directory });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const first = outputOf(await manager.output({ conversationId: conversation, taskId: started.task.id, waitMs: 2_000 }));
    assert.equal(first.task.status, 'running');
    assert.match(first.output, /one/);
    assert.doesNotMatch(first.output, /two/);
    assert.ok(first.nextOffset > 0);

    const second = outputOf(await manager.output({ conversationId: conversation, taskId: started.task.id, offset: first.nextOffset, waitMs: 5_000 }));
    assert.equal(second.output, 'two\n');
    assert.ok(second.nextOffset > first.nextOffset);

    const empty = outputOf(await manager.output({ conversationId: conversation, taskId: started.task.id, offset: second.nextOffset, waitMs: 0 }));
    assert.equal(empty.output, '');
    assert.equal(empty.nextOffset, second.nextOffset);

    const killed = manager.kill({ conversationId: conversation, taskId: started.task.id });
    assert.equal(killed.ok, true);
    const task = await waitForTerminal(manager, conversation, started.task.id);
    assert.equal(task.status, 'killed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('kill terminates a running task and is idempotent after it ended', async () => {
  const manager = shellTaskManager;
  const conversation = conversationId('kill');
  const directory = await temporaryDirectory();
  try {
    const running = manager.start({ conversationId: conversation, command: 'sleep 60', cwd: directory });
    assert.equal(running.ok, true);
    if (!running.ok) return;
    const killing = manager.kill({ conversationId: conversation, taskId: running.task.id, signal: 'SIGTERM' });
    assert.equal(killing.ok, true);
    const task = await waitForTerminal(manager, conversation, running.task.id);
    assert.equal(task.status, 'killed');
    assert.ok(task.endedAt);

    const again = manager.kill({ conversationId: conversation, taskId: running.task.id });
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.task.status, 'killed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('lists tasks per conversation and rejects task ids from another conversation', async () => {
  const manager = shellTaskManager;
  const first = conversationId('list-a');
  const second = conversationId('list-b');
  const directory = await temporaryDirectory();
  try {
    const started = manager.start({ conversationId: first, command: 'printf "listed\\n"', cwd: directory });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await waitForTerminal(manager, first, started.task.id);

    const listing = await manager.output({ conversationId: first });
    assert.equal(listing.ok, true);
    if (!listing.ok) return;
    assert.equal(listing.tasks?.length, 1);
    assert.equal(listing.tasks?.[0]?.id, started.task.id);
    assert.equal(listing.tasks?.[0]?.conversationId, first);

    const otherListing = await manager.output({ conversationId: second });
    assert.equal(otherListing.ok, true);
    if (otherListing.ok) assert.deepEqual(otherListing.tasks, []);

    const foreign = await manager.output({ conversationId: second, taskId: started.task.id });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.error.code, 'task_not_found');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('caps the log at maxOutputBytes and truncates reads at maxChars', async () => {
  const manager = shellTaskManager;
  const conversation = conversationId('cap');
  const directory = await temporaryDirectory();
  try {
    const started = manager.start({
      conversationId: conversation,
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(5000))"`,
      cwd: directory,
      maxOutputBytes: 1_024,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const task = await waitForTerminal(manager, conversation, started.task.id);
    assert.equal(task.status, 'completed');
    assert.equal(task.bytes, 1_024);
    assert.equal(task.truncated, true);

    const read = outputOf(await manager.output({ conversationId: conversation, taskId: started.task.id, maxChars: 50 }));
    assert.equal(read.output.length, 50);
    assert.equal(read.truncated, true);
    assert.equal(read.nextOffset, 50);

    const tail = outputOf(await manager.output({ conversationId: conversation, taskId: started.task.id, offset: 1_024 }));
    assert.equal(tail.output, '');
    assert.equal(tail.nextOffset, 1_024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid cwd and enforces the per-conversation running task limit', async () => {
  const manager = shellTaskManager;
  const conversation = conversationId('limit');
  const directory = await temporaryDirectory();
  try {
    const missingCwd = manager.start({ conversationId: conversation, command: 'true', cwd: path.join(directory, 'missing') });
    assert.equal(missingCwd.ok, false);
    if (!missingCwd.ok) assert.equal(missingCwd.error.code, 'invalid_cwd');

    const missingConversation = manager.start({ conversationId: '', command: 'true', cwd: directory });
    assert.equal(missingConversation.ok, false);
    if (!missingConversation.ok) assert.equal(missingConversation.error.code, 'missing_conversation');

    const tasks: string[] = [];
    for (let index = 0; index < MAX_TASKS_PER_CONVERSATION; index += 1) {
      const started = manager.start({ conversationId: conversation, command: 'sleep 30', cwd: directory });
      assert.equal(started.ok, true);
      if (started.ok) tasks.push(started.task.id);
    }
    assert.equal(tasks.length, MAX_TASKS_PER_CONVERSATION);
    const rejected = manager.start({ conversationId: conversation, command: 'sleep 30', cwd: directory });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.error.code, 'too_many_tasks');
      assert.match(rejected.error.message, /shell_kill/);
    }

    // Registry mirrors the running tasks so a restarted backend can clean up.
    const registry = readRegistry();
    assert.equal(registry.length, MAX_TASKS_PER_CONVERSATION);
    assert.ok(registry.every((entry) => typeof entry.token === 'string' && typeof entry.pid === 'number' && typeof entry.outputPath === 'string'));

    await manager.cleanupAll();
    for (const taskId of tasks) {
      const task = await waitForTerminal(manager, conversation, taskId, 10_000);
      assert.equal(task.status, 'killed');
    }
    assert.deepEqual(readRegistry(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('background tasks are not tied to the run that started them', async () => {
  const manager = shellTaskManager;
  const conversation = conversationId('cross-run');
  const directory = await temporaryDirectory();
  try {
    const started = manager.start({ conversationId: conversation, runInstanceId: 'run-a', command: 'sleep 0.2; printf "survived\\n"', cwd: directory });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    // The listing and reads only need the conversation; the run instance that
    // started the task is irrelevant (and there is deliberately no cleanupRun).
    const listed = await manager.output({ conversationId: conversation });
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.tasks?.[0]?.id, started.task.id);

    const output = await readAll(manager, conversation, started.task.id);
    assert.equal(output, 'survived\n');
    const task = await waitForTerminal(manager, conversation, started.task.id);
    assert.equal(task.status, 'completed');
    assert.equal('cleanupRun' in manager, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recoverOrphans kills only processes carrying the recorded task token', async () => {
  const manager = shellTaskManager;
  const directory = await temporaryDirectory();
  const orphanToken = crypto.randomUUID();
  const safeToken = crypto.randomUUID();
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BIOAGENT_SHELL_TASK_TOKEN: orphanToken },
  });
  orphan.unref();
  const safe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env } });
  safe.unref();
  try {
    writeRegistry([
      { id: 'orphan', pid: orphan.pid, token: orphanToken, startedAt: new Date().toISOString(), outputPath: path.join(directory, 'orphan.log') },
      { id: 'safe', pid: safe.pid, token: safeToken, startedAt: new Date().toISOString(), outputPath: path.join(directory, 'safe.log') },
    ]);
    await manager.recoverOrphans();
    await waitUntil(() => !isAlive(orphan.pid), 3_000);
    assert.equal(isAlive(orphan.pid), false, 'the recorded orphan process must be terminated');
    assert.equal(isAlive(safe.pid), true, 'a process without the matching token must be left alone');
    assert.deepEqual(readRegistry(), []);
  } finally {
    try {
      if (isAlive(orphan.pid)) process.kill(orphan.pid as number, 'SIGKILL');
    } catch { /* Already gone. */ }
    try {
      if (isAlive(safe.pid)) process.kill(safe.pid as number, 'SIGKILL');
    } catch { /* Already gone. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test('executeShellCommand run_in_background integrates with shell_output and shell_kill', async () => {
  const conversation = conversationId('integration');
  const directory = await temporaryDirectory();
  const context = { conversationId: conversation, projectPath: directory };
  try {
    const missing = await executeShellCommand({ cmd: 'echo hi', run_in_background: true }, { projectPath: directory });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.error, { code: 'missing_conversation', message: 'Background shell tasks require a conversation.' });

    const started = await executeShellCommand({ cmd: 'printf "bg\\n"', run_in_background: true }, context);
    assert.equal(started.ok, true);
    assert.equal(started.background, true);
    assert.equal(started.status, 'running');
    assert.equal(started.cwd, directory);
    assert.equal(typeof started.task_id, 'string');

    const output = await executeShellOutput({ task_id: started.task_id, wait_ms: 10_000, offset: 0 }, context);
    assert.equal(output.ok, true);
    assert.match(String(output.output), /bg/);
    assert.equal(typeof output.next_offset, 'number');
    assert.equal((output.task as Record<string, unknown>).task_id, started.task_id);
    const terminal = await waitForTerminal(shellTaskManager, conversation, String(started.task_id));
    assert.equal(terminal.status, 'completed');

    const listing = await executeShellOutput({}, context);
    assert.equal(listing.ok, true);
    assert.equal((listing.tasks as Array<Record<string, unknown>>).length, 1);
    assert.equal((listing.tasks as Array<Record<string, unknown>>)[0]?.status, 'completed');

    const killed = await executeShellKill({ task_id: started.task_id }, context);
    assert.equal(killed.ok, true);
    assert.equal(killed.task_id, started.task_id);
    assert.equal(killed.status, 'completed');

    const missingTask = await executeShellOutput({ task_id: 'nope' }, context);
    assert.equal(missingTask.ok, false);
    assert.equal((missingTask.error as { code: string }).code, 'task_not_found');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
