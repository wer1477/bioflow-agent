import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import {
  APPLY_PATCH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  executeCoreTool,
} from '../src/agent/core_tools_runtime.js';
import {
  atomicWriteFile,
  invalidateFileObservation,
  recordFileObservation,
  resetFileObservationsForTest,
  statSnapshot,
  verifyFileObservation,
  withFileMutationQueue,
} from '../src/agent/core_tools/file_state.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bioflow-file-safety-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  resetFileObservationsForTest();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function callFileTool(
  toolName: string,
  args: Record<string, unknown>,
  projectPath: string,
  conversationId?: string,
): Promise<Record<string, unknown>> {
  const context = conversationId === undefined ? { projectPath } : { projectPath, conversationId };
  return JSON.parse(await executeCoreTool(toolName, args, context)) as Record<string, unknown>;
}

function toolError(result: Record<string, unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected the tool call to fail');
  const error = result.error as { code?: unknown; message?: unknown } | undefined;
  assert.ok(error && typeof error === 'object', `expected a structured error, got ${JSON.stringify(result.error)}`);
  return { code: String(error.code), message: String(error.message) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('write_file rejects overwriting a file the conversation has not read', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'notes.txt');
  await fs.promises.writeFile(file, 'original\n');

  const result = await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'changed\n' }, directory, 'conv-unread');

  const error = toolError(result);
  assert.equal(error.code, 'FS_NOT_OBSERVED');
  assert.ok(error.message.includes(file), 'message should name the target path');
  assert.match(error.message, /read_file/);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'original\n', 'the file must not be modified');
});

test('read_file followed by write_file in the same conversation succeeds', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'notes.txt');
  await fs.promises.writeFile(file, 'original\n');

  const read = await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-read-write');
  assert.equal(read.ok, true);

  const write = await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'changed\n' }, directory, 'conv-read-write');

  assert.equal(write.ok, true);
  assert.equal(write.size, Buffer.byteLength('changed\n'));
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'changed\n');
});

test('creating a new file does not require a prior read', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'nested', 'created.txt');

  const result = await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'fresh\n' }, directory, 'conv-create');

  assert.equal(result.ok, true);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'fresh\n');
});

test('a missing file after a read is treated as a creation', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'removed.txt');
  await fs.promises.writeFile(file, 'temporary\n');

  await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-recreate');
  await fs.promises.rm(file);

  const result = await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'recreated\n' }, directory, 'conv-recreate');

  assert.equal(result.ok, true);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'recreated\n');
});

test('writes without a conversation id are not constrained by read-before-write', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'plain.txt');
  await fs.promises.writeFile(file, 'original\n');

  const result = await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'changed\n' }, directory);

  assert.equal(result.ok, true);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'changed\n');
});

test('write_file rejects a file that changed after it was read', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'stale.txt');
  await fs.promises.writeFile(file, 'original\n');

  await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-stale');
  await fs.promises.writeFile(file, 'changed out of band, longer\n');

  const result = await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'overwritten\n' }, directory, 'conv-stale');

  const error = toolError(result);
  assert.equal(error.code, 'FS_STALE_VERSION');
  assert.ok(error.message.includes(file));
  assert.match(error.message, /read_file/);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'changed out of band, longer\n');

  // Re-reading refreshes the observation and unblocks the write.
  assert.equal((await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-stale')).ok, true);
  assert.equal((await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'overwritten\n' }, directory, 'conv-stale')).ok, true);
});

test('invalidateFileObservation forces a fresh read before the next write', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'invalidated.txt');
  await fs.promises.writeFile(file, 'original\n');

  await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-invalidate');
  invalidateFileObservation('conv-invalidate', file);

  const error = toolError(await callFileTool(WRITE_FILE_TOOL_NAME, { file_path: file, content: 'changed\n' }, directory, 'conv-invalidate'));
  assert.equal(error.code, 'FS_NOT_OBSERVED');
});

test('file_state helpers no-op without a conversation and report missing files as writable', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'helpers.txt');
  await fs.promises.writeFile(file, 'original\n');

  recordFileObservation(undefined, file);
  assert.equal(verifyFileObservation(undefined, file), null);
  assert.equal(verifyFileObservation('conv-helper', file)?.error.code, 'FS_NOT_OBSERVED');
  assert.equal(verifyFileObservation('conv-helper', path.join(directory, 'missing.txt')), null);

  const snapshot = statSnapshot(file);
  assert.ok(snapshot);
  assert.equal(snapshot.path, file);
  assert.equal(snapshot.size, Buffer.byteLength('original\n'));
  assert.equal(statSnapshot(path.join(directory, 'missing.txt')), null);

  await fs.promises.rm(file);
  recordFileObservation('conv-helper', file);
  assert.equal(verifyFileObservation('conv-helper', file), null);
});

test('edit_file requires a prior read and supports an edits array with a diff', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'multi.txt');
  await fs.promises.writeFile(file, 'alpha\nbeta\ngamma\n');

  const blocked = toolError(await callFileTool(EDIT_FILE_TOOL_NAME, { file_path: file, old_string: 'beta', new_string: 'BETA' }, directory, 'conv-edit'));
  assert.equal(blocked.code, 'FS_NOT_OBSERVED');

  assert.equal((await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-edit')).ok, true);

  const result = await callFileTool(EDIT_FILE_TOOL_NAME, {
    file_path: file,
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'gamma', new_string: 'GAMMA' },
    ],
  }, directory, 'conv-edit');

  assert.equal(result.ok, true);
  assert.equal(result.replacements, 2);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'ALPHA\nbeta\nGAMMA\n');
  assert.match(String(result.diff), /^-alpha$/m);
  assert.match(String(result.diff), /^\+ALPHA$/m);

  // The successful write records a new observation, so another edit needs no read.
  const again = await callFileTool(EDIT_FILE_TOOL_NAME, { file_path: file, old_string: 'beta', new_string: 'BETA' }, directory, 'conv-edit');
  assert.equal(again.ok, true);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'ALPHA\nBETA\nGAMMA\n');
});

test('edit_file preserves CRLF line endings and keeps legacy arguments working', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'crlf.txt');
  await fs.promises.writeFile(file, 'alpha\r\nbeta\r\n');

  await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-crlf');
  const result = await callFileTool(EDIT_FILE_TOOL_NAME, {
    file_path: file,
    old_string: 'alpha\nbeta',
    new_string: 'alpha\ngamma',
  }, directory, 'conv-crlf');

  assert.equal(result.ok, true);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'alpha\r\ngamma\r\n');
});

test('edit_file returns structured edit failures', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'no-match.txt');
  await fs.promises.writeFile(file, 'alpha\n');

  await callFileTool(READ_FILE_TOOL_NAME, { file_path: file }, directory, 'conv-edit-failure');
  const result = await callFileTool(EDIT_FILE_TOOL_NAME, { file_path: file, old_string: 'zeta', new_string: 'omega' }, directory, 'conv-edit-failure');

  const error = toolError(result);
  assert.equal(error.code, 'FS_EDIT_NOT_FOUND');
  assert.match(error.message, /old_string was not found \(exact or fuzzy\)/);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'alpha\n');
});

test('atomicWriteFile replaces content atomically, preserves mode and creates directories', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'atomic.txt');
  await fs.promises.writeFile(file, 'old');
  await fs.promises.chmod(file, 0o640);

  await atomicWriteFile(file, 'new content');

  assert.equal(await fs.promises.readFile(file, 'utf8'), 'new content');
  assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o640);
  assert.deepEqual((await fs.promises.readdir(directory)).sort(), ['atomic.txt'], 'no temp files should remain');

  const nested = path.join(directory, 'deep', 'nested', 'file.txt');
  await atomicWriteFile(nested, 'nested');
  assert.equal(await fs.promises.readFile(nested, 'utf8'), 'nested');
});

test('withFileMutationQueue serializes mutations of the same path', async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, 'queue.txt');
  const order: string[] = [];

  const first = withFileMutationQueue([target], async () => {
    order.push('first-start');
    await delay(20);
    order.push('first-end');
    return 'first';
  });
  const second = withFileMutationQueue([target], async () => {
    order.push('second-start');
    order.push('second-end');
    return 'second';
  });

  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('withFileMutationQueue does not deadlock on reversed multi-path requests', async () => {
  const directory = await temporaryDirectory();
  const first = path.join(directory, 'a.txt');
  const second = path.join(directory, 'b.txt');
  const order: string[] = [];

  const lockAll = withFileMutationQueue([first, second], async () => {
    order.push('lock-start');
    await delay(10);
    order.push('lock-end');
  });
  const reversed = withFileMutationQueue([second, first], async () => {
    order.push('reversed');
  });

  await Promise.all([lockAll, reversed]);
  assert.deepEqual(order, ['lock-start', 'lock-end', 'reversed']);
});

test('apply_patch validates every hunk before writing any file', async () => {
  const directory = await temporaryDirectory();
  const first = path.join(directory, 'first.txt');
  const second = path.join(directory, 'second.txt');
  await fs.promises.writeFile(first, 'one\n');
  await fs.promises.writeFile(second, 'two\n');

  const patch = [
    '--- a/first.txt',
    '+++ b/first.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '--- a/second.txt',
    '+++ b/second.txt',
    '@@ -1 +1 @@',
    '-missing',
    '+TWO',
  ].join('\n');

  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory);

  const error = toolError(result);
  assert.equal(error.code, 'FS_PATCH_INVALID');
  assert.ok(error.message.includes(second), 'message should name the failing target path');
  assert.match(error.message, /"missing"/, 'message should include the line that did not match');
  assert.equal(await fs.promises.readFile(first, 'utf8'), 'one\n', 'the first file must stay untouched');
  assert.equal(await fs.promises.readFile(second, 'utf8'), 'two\n');
});

test('apply_patch rejects stale targets before writing anything', async () => {
  const directory = await temporaryDirectory();
  const first = path.join(directory, 'first.txt');
  const second = path.join(directory, 'second.txt');
  await fs.promises.writeFile(first, 'one\n');
  await fs.promises.writeFile(second, 'two\n');
  await callFileTool(READ_FILE_TOOL_NAME, { file_path: first }, directory, 'conv-patch-stale');
  await callFileTool(READ_FILE_TOOL_NAME, { file_path: second }, directory, 'conv-patch-stale');
  await fs.promises.writeFile(second, 'two changed out of band\n');

  const patch = [
    '--- a/first.txt',
    '+++ b/first.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '--- a/second.txt',
    '+++ b/second.txt',
    '@@ -1 +1 @@',
    '-two changed out of band',
    '+TWO',
  ].join('\n');

  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory, 'conv-patch-stale');

  assert.equal(toolError(result).code, 'FS_STALE_VERSION');
  assert.equal(await fs.promises.readFile(first, 'utf8'), 'one\n');
  assert.equal(await fs.promises.readFile(second, 'utf8'), 'two changed out of band\n');
});

test('apply_patch requires existing targets to have been read in the conversation', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'unread.txt');
  await fs.promises.writeFile(file, 'old\n');

  const patch = ['--- a/unread.txt', '+++ b/unread.txt', '@@ -1 +1 @@', '-old', '+new'].join('\n');
  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory, 'conv-patch-unread');

  assert.equal(toolError(result).code, 'FS_NOT_OBSERVED');
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'old\n');
});

test('apply_patch writes multiple files after they were read and refreshes observations', async () => {
  const directory = await temporaryDirectory();
  const first = path.join(directory, 'first.txt');
  const second = path.join(directory, 'second.txt');
  await fs.promises.writeFile(first, 'one\n');
  await fs.promises.writeFile(second, 'two\n');
  const conversationId = 'conv-patch-ok';
  await callFileTool(READ_FILE_TOOL_NAME, { file_path: first }, directory, conversationId);
  await callFileTool(READ_FILE_TOOL_NAME, { file_path: second }, directory, conversationId);

  const patch = [
    '--- a/first.txt',
    '+++ b/first.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '--- a/second.txt',
    '+++ b/second.txt',
    '@@ -1 +1 @@',
    '-two',
    '+TWO',
  ].join('\n');

  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory, conversationId);

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal((result.files as unknown[]).length, 2);
  assert.equal(await fs.promises.readFile(first, 'utf8'), 'ONE\n');
  assert.equal(await fs.promises.readFile(second, 'utf8'), 'TWO\n');

  // The successful write records the new version; a second patch needs no re-read.
  const secondPatch = ['--- a/first.txt', '+++ b/first.txt', '@@ -1 +1 @@', '-ONE', '+FIRST'].join('\n');
  assert.equal((await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch: secondPatch }, directory, conversationId)).ok, true);
  assert.equal(await fs.promises.readFile(first, 'utf8'), 'FIRST\n');
});

test('apply_patch creates a new file without a prior read', async () => {
  const directory = await temporaryDirectory();
  const created = path.join(directory, 'created-by-patch.txt');
  const patch = ['--- /dev/null', '+++ b/created-by-patch.txt', '@@ -0,0 +1,2 @@', '+hello', '+world'].join('\n');

  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory, 'conv-patch-create');

  assert.equal(result.ok, true);
  assert.equal(await fs.promises.readFile(created, 'utf8'), 'hello\nworld');
});

test('apply_patch honors the no-newline-at-end-of-file marker', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'no-newline.txt');
  await fs.promises.writeFile(file, 'a\nb\n');

  const patch = [
    '--- a/no-newline.txt',
    '+++ b/no-newline.txt',
    '@@ -2 +2 @@',
    '-b',
    '+b',
    '\\ No newline at end of file',
  ].join('\n');

  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory);

  assert.equal(result.ok, true);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'a\nb');
});

test('apply_patch deletes files and rejects deleting a missing file', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'deleted.txt');
  await fs.promises.writeFile(file, 'gone\n');

  const deletion = ['--- a/deleted.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n');
  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch: deletion }, directory);
  assert.equal(result.ok, true);
  await assert.rejects(fs.promises.stat(file));

  const missing = ['--- a/missing.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-missing'].join('\n');
  const error = toolError(await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch: missing }, directory));
  assert.equal(error.code, 'FS_PATCH_INVALID');
  assert.match(error.message, /does not exist/);
});

test('apply_patch reports ambiguous context and leaves the file unchanged', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'ambiguous.txt');
  await fs.promises.writeFile(file, 'same\nkeep\nsame\nkeep\n');

  const patch = ['--- a/ambiguous.txt', '+++ b/ambiguous.txt', '@@ -99,2 +99,2 @@', ' same', '-keep', '+changed'].join('\n');
  const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory);

  const error = toolError(result);
  assert.equal(error.code, 'FS_PATCH_INVALID');
  assert.match(error.message, /ambiguous/i);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'same\nkeep\nsame\nkeep\n');
});

test('apply_patch returns partial results when a write fails midway', async () => {
  const directory = await temporaryDirectory();
  const first = path.join(directory, 'first.txt');
  const lockedDirectory = path.join(directory, 'locked');
  await fs.promises.writeFile(first, 'one\n');
  await fs.promises.mkdir(lockedDirectory);
  await fs.promises.chmod(lockedDirectory, 0o555);

  const patch = [
    '--- a/first.txt',
    '+++ b/first.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '--- /dev/null',
    '+++ b/locked/blocked.txt',
    '@@ -0,0 +1,1 @@',
    '+blocked',
  ].join('\n');

  try {
    const result = await callFileTool(APPLY_PATCH_TOOL_NAME, { workdir: directory, patch }, directory);

    const error = toolError(result);
    assert.equal(error.code, 'FS_PATCH_WRITE_FAILED');
    assert.equal((result.completed as unknown[]).length, 1);
    assert.equal(await fs.promises.readFile(first, 'utf8'), 'ONE\n');
    assert.equal(fs.existsSync(path.join(lockedDirectory, 'blocked.txt')), false);
  } finally {
    await fs.promises.chmod(lockedDirectory, 0o755);
  }
});
