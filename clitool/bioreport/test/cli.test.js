import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, description, resolvePython } from '../src/cli.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function capture() {
  const data = { stdout: '', stderr: '' };
  return {
    data,
    io: {
      stdout: { write: (value) => { data.stdout += value; } },
      stderr: { write: (value) => { data.stderr += value; } },
    },
  };
}

async function run(argv) {
  const stream = capture();
  const code = await main(argv, stream.io);
  return { code, stdout: stream.data.stdout, stderr: stream.data.stderr };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-report-'));
  const results = path.join(root, 'results');
  const figures = path.join(root, 'figures');
  fs.mkdirSync(results);
  fs.mkdirSync(figures);

  const first = path.join(root, 'fastp.json');
  fs.writeFileSync(first, JSON.stringify({
    tool: 'fastp',
    version: '0.23.4',
    command: 'fastp -i raw.fastq -o clean.fastq',
    parameters: { threads: 4, qualified_quality_phred: 20 },
    inputs: [{ path: 'raw.fastq', sha256: SHA_A }],
    outputs: [{ path: 'clean.fastq', sha256: SHA_B }],
  }));

  const second = path.join(root, 'star.json');
  fs.writeFileSync(second, JSON.stringify({ name: 'STAR', parameters: { genome: 'GRCh38' } }));

  fs.writeFileSync(path.join(results, 'counts.csv'), 'gene,log2fc,pvalue\nTP53,2.1,0.001\nBAX,-1.4,0.02\nMDM2,0.8,0.31\n');
  fs.writeFileSync(path.join(figures, 'volcano.png'), PNG_1X1);

  const methods = path.join(root, 'methods.md');
  fs.writeFileSync(methods, '## Library preparation\n\nReads were trimmed with fastp and aligned with STAR.\n');

  return { root, first, second, results, figures, methods };
}

const baseArgv = (data, extra = []) => [
  'build',
  '--manifest', data.first,
  '--manifest', data.second,
  '--results-dir', data.results,
  '--figures-dir', data.figures,
  '--methods', data.methods,
  ...extra,
];

test('describe is a parseable machine registry', async () => {
  const result = await run(['--describe', '--format', 'json']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), description);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout).commands), ['build', 'check']);

  const invalid = await run(['--describe', '--format', 'yaml']);
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'invalid-input');
});

test('help lists commands and the build signature', async () => {
  const top = await run(['--help']);
  assert.equal(top.code, 0);
  assert.match(top.stdout, /^Usage: bio-report <command>/);
  assert.match(top.stdout, /build/);
  assert.match(top.stdout, /check/);

  const build = await run(['build', '--help']);
  assert.equal(build.code, 0);
  assert.match(build.stdout, /--manifest/);
  assert.match(build.stdout, /--pdf/);
  assert.match(build.stdout, /--dry-run/);
});

test('version prints the package version', async () => {
  const result = await run(['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), description.version);
});

test('unknown command is a usage error with an actionable hint', async () => {
  const result = await run(['compile']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, 'unknown-command');
  assert.match(error.hint, /--help/);
});

test('missing input is a usage error', async () => {
  const result = await run(['build']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'missing-input');
});

test('a flag without a value and an unknown flag are usage errors', async () => {
  const missing = await run(['build', '--manifest']);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stderr).error.code, 'missing-value');

  const unknown = await run(['build', '--manifest', 'x.json', '--bogus', 'y']);
  assert.equal(unknown.code, 2);
  assert.equal(JSON.parse(unknown.stderr).error.code, 'unknown-option');

  const format = await run(['build', '--manifest', 'x.json', '--format', 'yaml']);
  assert.equal(format.code, 2);
  assert.equal(JSON.parse(format.stderr).error.code, 'invalid-input');
});

test('a missing manifest path fails before the engine runs', async () => {
  const result = await run(['build', '--manifest', path.join(os.tmpdir(), 'does-not-exist.json')]);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'invalid-input');
  assert.match(JSON.parse(result.stderr).error.message, /--manifest/);
});

test('dry-run reports the plan without writing files', async () => {
  const data = fixture();
  const output = path.join(data.root, 'out', 'report.md');
  const pdf = path.join(data.root, 'out', 'report.pdf');
  const result = await run(baseArgv(data, ['--output', output, '--pdf', pdf, '--dry-run']));
  assert.equal(result.code, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.planned, true);
  assert.equal(plan.outputs.markdown, output);
  assert.equal(plan.outputs.pdf, pdf);
  assert.equal(plan.inputs.manifests.length, 2);
  assert.equal(plan.inputs.results_dirs.length, 1);
  assert.equal(plan.inputs.figures_dirs.length, 1);
  assert.ok(plan.actions.length >= 3);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(pdf), false);
  assert.equal(fs.existsSync(path.dirname(output)), false);
});

test('build writes a report with tools, hashes, tables and figures', async () => {
  const data = fixture();
  const output = path.join(data.root, 'report.md');
  const result = await run(baseArgv(data, ['--output', output, '--title', 'RNA-seq QC']));
  assert.equal(result.code, 0, result.stderr);

  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.outputs.markdown, output);
  assert.deepEqual(response.counts, { manifests: 2, tables: 1, figures: 1 });
  assert.match(result.stderr, /warning:/);

  const report = fs.readFileSync(output, 'utf8');
  assert.match(report, /^# RNA-seq QC/);
  for (const section of ['## Summary', '## Methods', '## Parameters & software versions', '## Results tables', '## Figures', '## Provenance']) {
    assert.ok(report.includes(section), `missing section ${section}`);
  }
  assert.match(report, /fastp/);
  assert.match(report, /0\.23\.4/);
  assert.match(report, new RegExp(SHA_A));
  assert.match(report, new RegExp(SHA_B));
  assert.match(report, /STAR/);
  assert.match(report, /counts\.csv/);
  assert.match(report, /3 rows × 3 columns/);
  assert.match(report, /TP53/);
  assert.match(report, /volcano\.png/);
  assert.match(report, /\n### Library preparation\n/);
  assert.doesNotMatch(report, /^## Library preparation/m);
  assert.match(report, /Reads were trimmed with fastp and aligned with STAR/);
  assert.match(report, /Generated at: `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`/);
});

test('an empty table is reported without collapsing the section spacing', async () => {
  const data = fixture();
  fs.writeFileSync(path.join(data.results, 'empty.csv'), '');
  const output = path.join(data.root, 'report.md');
  const result = await run(baseArgv(data, ['--output', output]));
  assert.equal(result.code, 0, result.stderr);
  const report = fs.readFileSync(output, 'utf8');
  assert.match(report, /### counts\.csv \(3 rows × 3 columns\)/);
  assert.match(report, /### empty\.csv \(0 rows × 0 columns\)/);
  assert.match(report, /_Empty table\._\n\n## Figures/);
  assert.doesNotMatch(report, /\|\n### /);
});

test('a malformed manifest warns but does not abort the run', async () => {
  const data = fixture();
  const broken = path.join(data.root, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  const output = path.join(data.root, 'report.md');
  const result = await run(['build', '--manifest', broken, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.ok(response.warnings.some((message) => message.includes('invalid JSON')));
  assert.equal(fs.existsSync(output), true);
});

test('check reports the interpreter and matplotlib availability', async () => {
  const result = await run(['check']);
  assert.equal(result.stdout.length > 0, true);
  const response = JSON.parse(result.stdout);
  assert.equal(response.schema_version, 1);
  assert.equal(response.ok, true);
  assert.equal(typeof response.interpreter.path, 'string');
  assert.match(response.interpreter.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof response.matplotlib.available, 'boolean');
  assert.equal(typeof response.pdf_ready, 'boolean');
  assert.equal(resolvePython().path.length > 0, true);
});

test('a broken interpreter yields a CheckResult and a clean JSON error, never a Node stack', async (t) => {
  if (process.platform === 'win32') {
    t.skip('shell shim is POSIX only');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-report-broken-'));
  const shim = path.join(root, 'bin');
  fs.mkdirSync(shim);
  const wrapper = path.join(shim, 'python3');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexit 3\n');
  fs.chmodSync(wrapper, 0o755);

  const data = fixture();
  const previousBin = process.env.BIOAGENT_ENV_BIN;
  process.env.BIOAGENT_ENV_BIN = shim;
  try {
    const health = await run(['check']);
    assert.equal(health.code, 1);
    const response = JSON.parse(health.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.pdf_ready, false);
    assert.equal(response.interpreter.source, 'BIOAGENT_ENV_BIN');
    assert.match(response.error.code, /engine-failed|python-unavailable/);
    assert.doesNotMatch(health.stderr, /at .*\.js:\d+/);

    const build = await run(baseArgv(data, ['--output', path.join(root, 'report.md')]));
    assert.equal(build.code, 1);
    assert.equal(build.stdout, '');
    const error = JSON.parse(build.stderr).error;
    assert.match(error.code, /engine-failed|python-unavailable/);
    assert.equal(typeof error.message, 'string');
  } finally {
    if (previousBin === undefined) delete process.env.BIOAGENT_ENV_BIN;
    else process.env.BIOAGENT_ENV_BIN = previousBin;
  }
});

test('a missing matplotlib keeps the Markdown and exits 1 with a hint', async (t) => {
  const probe = spawnSync('python3', ['-V'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python3 is not on PATH');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-report-nompl-'));
  const shim = path.join(root, 'bin');
  const blocker = path.join(root, 'site');
  fs.mkdirSync(shim);
  fs.mkdirSync(blocker);
  const wrapper = path.join(shim, 'python3');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec python3 "$@"\n');
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(path.join(blocker, 'matplotlib.py'), 'raise ImportError("simulated missing matplotlib")\n');

  const data = fixture();
  const output = path.join(root, 'report.md');
  const pdf = path.join(root, 'report.pdf');
  const previousBin = process.env.BIOAGENT_ENV_BIN;
  const previousPath = process.env.PYTHONPATH;
  process.env.BIOAGENT_ENV_BIN = shim;
  process.env.PYTHONPATH = blocker;
  try {
    const result = await run(baseArgv(data, ['--output', output, '--pdf', pdf]));
    assert.equal(result.code, 1);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.outputs.markdown, output);
    assert.equal(fs.existsSync(output), true);
    assert.equal(fs.existsSync(pdf), false);
    assert.match(result.stderr, /error\[pdf-unavailable\]/);
    assert.match(result.stderr, /hint: .*matplotlib/);
    assert.match(fs.readFileSync(output, 'utf8'), /fastp/);
  } finally {
    if (previousBin === undefined) delete process.env.BIOAGENT_ENV_BIN;
    else process.env.BIOAGENT_ENV_BIN = previousBin;
    if (previousPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPath;
  }
});

test('pdf output is a real, reproducible PDF when matplotlib is available', async (t) => {
  const health = await run(['check']);
  let availability;
  try {
    availability = JSON.parse(health.stdout).matplotlib;
  } catch {
    availability = { available: false, error: health.stderr };
  }
  if (!availability.available) {
    t.skip(`matplotlib unavailable: ${availability.error ?? 'unknown reason'}`);
    return;
  }

  const data = fixture();
  const previous = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1767225600';
  try {
    const firstPdf = path.join(data.root, 'first.pdf');
    const first = await run(baseArgv(data, ['--output', path.join(data.root, 'first.md'), '--pdf', firstPdf]));
    assert.equal(first.code, 0, first.stderr);
    const response = JSON.parse(first.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.outputs.pdf, firstPdf);

    const buffer = fs.readFileSync(firstPdf);
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(buffer.toString('latin1'), /CreationDate/);

    const secondPdf = path.join(data.root, 'second.pdf');
    const second = await run(baseArgv(data, ['--output', path.join(data.root, 'second.md'), '--pdf', secondPdf]));
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(fs.readFileSync(secondPdf), buffer, 'PDF bytes must be reproducible when SOURCE_DATE_EPOCH is fixed');
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
});
