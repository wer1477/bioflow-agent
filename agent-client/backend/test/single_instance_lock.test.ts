import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from '../src/single_instance_lock.js';

test('single-instance lock rejects a live owner and recovers a stale lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bioflow-instance-lock-'));
  const lock = path.join(directory, '.bioflow-backend.lock');
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    assert.throws(() => acquireSingleInstanceLock(directory), /already running/);

    await writeFile(lock, JSON.stringify({ pid: 999_999_999 }));
    acquireSingleInstanceLock(directory);
  } finally {
    releaseSingleInstanceLock();
    await rm(directory, { recursive: true, force: true });
  }
});
