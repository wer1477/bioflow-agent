import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bio-align.js');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function tempFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-align-test-'));
  const r1 = path.join(directory, 'R1.fastq.gz');
  const r2 = path.join(directory, 'R2.fastq.gz');
  const reference = path.join(directory, 'genome.fa');
  const output = path.join(directory, 'out');
  fs.writeFileSync(r1, '');
  fs.writeFileSync(r2, '');
  fs.writeFileSync(reference, '>chr1\nACGT\n');
  return { directory, r1, r2, reference, output };
}

test('--describe, --help and --version work', () => {
  const registry = run(['--describe', '--format', 'json']);
  assert.equal(registry.status, 0, registry.stderr);
  const parsed = JSON.parse(registry.stdout);
  assert.equal(parsed.name, 'bio-align');
  assert.deepEqual(parsed.commands.plan.options.aligner.enum, ['star', 'hisat2', 'bwa', 'salmon']);
  assert.match(run(['--help']).stdout, /Usage: bio-align/);
  assert.equal(run(['--version']).stdout.trim(), '0.1.0');
});

test('usage errors exit 2 with JSON errors', () => {
  assert.equal(run(['nope']).status, 2);
  assert.equal(JSON.parse(run(['nope']).stderr.trim()).error.code, 'unknown-command');
  const missing = run(['plan', '--output', os.tmpdir()]);
  assert.equal(missing.status, 2);
  assert.match(JSON.parse(missing.stderr.trim()).error.message, /reads/);
});

test('plan prints steps without touching the output directory', () => {
  const fixture = tempFixture();
  const result = run(['plan', '--reads', `${fixture.r1},${fixture.r2}`, '--reference', fixture.reference, '--annotation', fixture.reference, '--output', fixture.output, '--aligner', 'star']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.planned, true);
  assert.deepEqual(plan.steps.map((step) => step.name), ['trim', 'align', 'index', 'count']);
  assert.deepEqual(plan.steps[1].requires, ['STAR', 'samtools']);
  assert.equal(fs.existsSync(fixture.output), false);
});

test('plan switches aligner and requires the matching tools', () => {
  const fixture = tempFixture();
  const salmon = JSON.parse(run(['plan', '--reads', fixture.r1, '--reference', fixture.reference, '--output', fixture.output, '--aligner', 'salmon']).stdout);
  assert.deepEqual(salmon.steps.map((step) => step.name), ['trim', 'quant']);
  assert.deepEqual(salmon.steps[1].requires, ['salmon']);
});

test('plan adds -p to featureCounts for paired-end input only', () => {
  const fixture = tempFixture();
  const paired = JSON.parse(run(['plan', '--reads', `${fixture.r1},${fixture.r2}`, '--reference', fixture.reference, '--annotation', fixture.reference, '--output', fixture.output, '--aligner', 'bwa']).stdout);
  const count = paired.steps.find((step) => step.name === 'count');
  assert.ok(count.command.includes('-p'), 'paired-end counts need featureCounts -p');
  const single = JSON.parse(run(['plan', '--reads', fixture.r1, '--reference', fixture.reference, '--annotation', fixture.reference, '--output', fixture.output, '--aligner', 'bwa']).stdout);
  const singleCount = single.steps.find((step) => step.name === 'count');
  assert.equal(singleCount.command.includes('-p'), false, 'single-end counts must not pass -p');
});

test('check reports tool availability as JSON', () => {
  const result = run(['check', '--format', 'json']);
  assert.ok(result.status === 0 || result.status === 1);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.available));
  assert.ok(Array.isArray(report.missing));
  assert.equal(typeof report.engines.native, 'boolean');
});

test('run refuses when required tools are missing', (t) => {
  const check = JSON.parse(run(['check', '--format', 'json']).stdout);
  if (check.ok) {
    t.skip('tools are installed; the missing-tools branch cannot be simulated here');
    return;
  }
  const fixture = tempFixture();
  const result = run(['run', '--reads', fixture.r1, '--reference', fixture.reference, '--output', fixture.output, '--aligner', 'salmon']);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr.trim()).error;
  assert.equal(error.code, 'missing-tools');
  assert.match(error.message, /fastp|salmon/);
  assert.equal(fs.existsSync(fixture.output), false);
});
