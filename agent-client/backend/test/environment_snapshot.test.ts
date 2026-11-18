import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureEnvironmentSnapshot,
  resetEnvironmentSnapshotCache,
  type CommandResult,
  type CommandRunner,
} from '../src/agent/provenance/environment_snapshot.js';

function tempBin(files: string[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bioflow-env-bin-'));
  for (const name of files) {
    fs.writeFileSync(path.join(directory, name), '#!/bin/sh\nexit 0\n', 'utf8');
  }
  return directory;
}

function fakeRunner(handler: (file: string, args: string[]) => CommandResult): CommandRunner {
  return async (file, args) => handler(file, args);
}

const PYTHON_PROBE = JSON.stringify({ version: '3.12.15', packages: { numpy: '2.3.5', scanpy: '1.12.3' } });

test('captures git, python and R metadata from the probe commands', async () => {
  resetEnvironmentSnapshotCache();
  const envBin = tempBin(['python', 'Rscript']);
  const runner = fakeRunner((file, args) => {
    if (file === 'git' && args.includes('--abbrev-ref')) {
      return { ok: true, stdout: 'main\n', stderr: '' };
    }
    if (file === 'git' && args.includes('rev-parse') && args.includes('HEAD')) {
      return { ok: true, stdout: 'abc1234\n', stderr: '' };
    }
    if (file === 'git' && args.includes('status')) {
      return { ok: true, stdout: '', stderr: '' };
    }
    if (file.endsWith('python')) {
      return { ok: true, stdout: `${PYTHON_PROBE}\n`, stderr: '' };
    }
    if (file.endsWith('Rscript')) {
      return { ok: true, stdout: 'version\t4.4.3\npackage\tDESeq2\t1.46.0\n', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected command' };
  });

  const snapshot = await captureEnvironmentSnapshot({ envBin, runner, fresh: true });
  assert.equal(snapshot.code.available, true);
  assert.equal(snapshot.code.commit, 'abc1234');
  assert.equal(snapshot.code.branch, 'main');
  assert.equal(snapshot.code.dirty, false);
  assert.equal(snapshot.python?.version, '3.12.15');
  assert.equal(snapshot.python?.packages.numpy, '2.3.5');
  assert.equal(snapshot.r?.version, '4.4.3');
  assert.equal(snapshot.r?.packages.DESeq2, '1.46.0');
  assert.deepEqual(snapshot.warnings, []);
});

test('degrades to nulls and warnings instead of failing', async () => {
  resetEnvironmentSnapshotCache();
  const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bioflow-no-git-'));
  const envBin = tempBin([]);
  const runner = fakeRunner((file) => {
    if (file === 'git') return { ok: false, stdout: '', stderr: 'not a repository' };
    return { ok: false, stdout: '', stderr: 'missing' };
  });

  const snapshot = await captureEnvironmentSnapshot({
    envBin,
    runner,
    repositoryRoot: emptyDirectory,
    fresh: true,
  });
  assert.equal(snapshot.code.available, false);
  assert.equal(snapshot.code.commit, null);
  assert.equal(snapshot.python, null);
  assert.equal(snapshot.r, null);
  assert.ok(snapshot.warnings.some((warning) => warning.includes('not a git checkout')));
  assert.ok(snapshot.warnings.some((warning) => warning.includes('python environment not found')));
  assert.ok(snapshot.warnings.some((warning) => warning.includes('R environment not found')));
});

test('reuses the cached snapshot until it is invalidated', async () => {
  resetEnvironmentSnapshotCache();
  const envBin = tempBin(['python', 'Rscript']);
  let calls = 0;
  const runner = fakeRunner((file, args) => {
    calls += 1;
    if (file === 'git') {
      return { ok: true, stdout: args.includes('--abbrev-ref') ? 'main\n' : 'abc1234\n', stderr: '' };
    }
    if (file.endsWith('python')) return { ok: true, stdout: `${PYTHON_PROBE}\n`, stderr: '' };
    return { ok: true, stdout: 'version\t4.4.3\n', stderr: '' };
  });

  const first = await captureEnvironmentSnapshot({ envBin, runner });
  const callsAfterFirst = calls;
  const second = await captureEnvironmentSnapshot({ envBin, runner });
  assert.equal(second, first);
  assert.equal(calls, callsAfterFirst, 'the cached snapshot must not re-run the probes');
  resetEnvironmentSnapshotCache();
});
