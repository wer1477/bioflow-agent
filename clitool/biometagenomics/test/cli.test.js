import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bio-metagenomics.js');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-meta-test-'));
  const r1 = path.join(directory, 'R1.fastq.gz');
  const r2 = path.join(directory, 'R2.fastq.gz');
  const database = path.join(directory, 'db');
  const output = path.join(directory, 'out');
  fs.writeFileSync(r1, '');
  fs.writeFileSync(r2, '');
  fs.mkdirSync(database);
  return { directory, r1, r2, database, output };
}

test('--describe, --help and --version work', () => {
  const result = run(['--describe', '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(result.stdout);
  assert.equal(registry.name, 'bio-metagenomics');
  assert.deepEqual(registry.commands.plan.options.classifier.enum, ['kaiju', 'kraken2']);
  assert.match(run(['--help']).stdout, /Usage: bio-metagenomics/);
  assert.equal(run(['--version']).stdout.trim(), '0.1.0');
});

test('usage errors exit 2 with JSON errors', () => {
  assert.equal(run(['nope']).status, 2);
  const missing = run(['plan', '--output', os.tmpdir()]);
  assert.equal(missing.status, 2);
  assert.match(JSON.parse(missing.stderr.trim()).error.message, /reads/);
});

test('plan prints the assembly and classification steps', () => {
  const item = fixture();
  const result = run(['plan', '--reads', `${item.r1},${item.r2}`, '--output', item.output, '--database', item.database]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.planned, true);
  assert.deepEqual(plan.steps.map((step) => step.name), ['trim', 'assemble', 'contig-stats', 'classify', 'standardise']);
  assert.deepEqual(plan.steps[1].requires, ['megahit']);
  assert.deepEqual(plan.steps[3].requires, ['kraken2']);
  assert.equal(plan.steps[4].command[0], 'taxpasta');
  assert.equal(fs.existsSync(item.output), false);
});

test('plan supports kaiju + spades and optional host removal', () => {
  const item = fixture();
  const host = path.join(item.directory, 'host.fa');
  fs.writeFileSync(host, '>chr1\nACGT\n');
  const plan = JSON.parse(run(['plan', '--reads', item.r1, '--output', item.output, '--database', item.database, '--classifier', 'kaiju', '--assembler', 'spades', '--host-reference', host]).stdout);
  assert.deepEqual(plan.steps.map((step) => step.name), ['trim', 'host-align', 'host-filter', 'host-split', 'assemble', 'contig-stats', 'classify', 'standardise']);
  assert.deepEqual(plan.steps[4].requires, ['spades.py']);
  assert.deepEqual(plan.steps[6].requires, ['kaiju']);
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
  const item = fixture();
  const result = run(['run', '--reads', item.r1, '--output', item.output, '--database', item.database]);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr.trim()).error;
  assert.equal(error.code, 'missing-tools');
  assert.match(error.message, /fastp|megahit|kraken2|taxpasta/);
  assert.equal(fs.existsSync(item.output), false);
});
