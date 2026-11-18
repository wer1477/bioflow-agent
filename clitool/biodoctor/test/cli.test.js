import test from 'node:test';
import assert from 'node:assert/strict';
import { description, main } from '../src/cli.js';

function io() {
  const data = { stdout: '', stderr: '' };
  return {
    data,
    stdout: { write: (value) => { data.stdout += value; } },
    stderr: { write: (value) => { data.stderr += value; } },
  };
}

test('describe exposes the machine-readable diagnostic contract', async () => {
  const stream = io();

  assert.equal(await main(['--describe', '--format', 'json'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), description);
});

test('profiles lists the declared capability profiles without probing the environment', async () => {
  const stream = io();

  assert.equal(await main(['profiles', '--format', 'json'], stream), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.deepEqual(result.items.map((item) => item.id), ['bioagent-r-core', 'bioagent-local-cli', 'bioagent-ngs']);
  assert.equal(result.items[2].location, 'lab-server');
});

test('check reports command and R-package availability as structured, non-mutating facts', async () => {
  const stream = io();
  const checker = {
    command: (name) => name === 'Rscript'
      ? { status: 'available', path: '/bioenv/bin/Rscript', version: 'Rscript (R) version 4.4.3' }
      : { status: 'missing', path: null, version: null },
    rPackages: () => ({ edgeR: '4.4.0', limma: '3.62.1', DESeq2: '1.46.0', 'data.table': null }),
  };

  assert.equal(await main(['check', '--profile', 'bioagent-r-core', '--format', 'json'], stream, { checker }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.status, 'partial');
  assert.equal(result.checks.find((item) => item.id === 'command:Rscript').status, 'available');
  assert.equal(result.checks.find((item) => item.id === 'r-package:data.table').status, 'missing');
  assert.deepEqual(result.provides, []);
});

test('check identifies a server-only profile without treating absent local commands as installation failures', async () => {
  const stream = io();
  const checker = {
    command: () => assert.fail('must not probe local commands for a server-only profile'),
    rPackages: () => assert.fail('must not probe local R packages for a server-only profile'),
  };

  assert.equal(await main(['check', '--profile', 'bioagent-ngs', '--format', 'json'], stream, { checker }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.status, 'server_required');
  assert.ok(result.checks.every((item) => item.status === 'server_required'));
});

test('check rejects an unknown profile before probing', async () => {
  const stream = io();

  assert.equal(await main(['check', '--profile', 'unknown', '--format', 'json'], stream), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'unknown-profile');
});
