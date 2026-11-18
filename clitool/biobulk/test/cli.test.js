import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bio-bulk.js');
const PYTHON = process.env.BIOAGENT_ENV_BIN
  ? path.join(process.env.BIOAGENT_ENV_BIN, 'python3')
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.bioenv', 'bin', 'python');

function run(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });
}

function json(result) {
  return JSON.parse(result.stdout.trim());
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bio-bulk-test-'));
}

function testPython() {
  return fs.existsSync(PYTHON) ? PYTHON : 'python3';
}

function pydeseq2Available() {
  const probe = spawnSync(testPython(), ['-c', 'import pydeseq2, pandas, numpy, sklearn, matplotlib'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function fixture(directory) {
  const counts = path.join(directory, 'counts.tsv');
  const samples = path.join(directory, 'samples.csv');
  const genes = [];
  for (let index = 0; index < 30; index += 1) {
    const row = [10 + index, 11 + index, 9 + index, 40 + index, 42 + index, 38 + index];
    genes.push(`g${index}\t${row.join('\t')}`);
  }
  fs.writeFileSync(counts, `gene\ts1\ts2\ts3\ts4\ts5\ts6\n${genes.join('\n')}\n`);
  fs.writeFileSync(samples, 'sample,condition\ns1,control\ns2,control\ns3,control\ns4,treated\ns5,treated\ns6,treated\n');
  return { counts, samples };
}

test('--describe prints the registry', () => {
  const result = run(['--describe', '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  const registry = json(result);
  assert.equal(registry.name, 'bio-bulk');
  assert.deepEqual(registry.commands.run.options.engine.enum, ['pydeseq2', 'deseq2-r']);
  assert.equal(registry.commands.run.options.contrast.required, true);
});

test('usage errors exit 2 with JSON errors', () => {
  assert.equal(run(['nope']).status, 2);
  const missing = run(['run', '--counts', '/no/such.tsv', '--samples', '/no/such.csv', '--contrast', 'condition:b:a', '--output', tempDir()]);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr.trim()).error.code, 'missing-input');

  const directory = tempDir();
  const { counts, samples } = fixture(directory);
  const badContrast = run(['run', '--counts', counts, '--samples', samples, '--contrast', 'condition:treated', '--output', path.join(directory, 'out')]);
  assert.equal(badContrast.status, 2);
  assert.match(JSON.parse(badContrast.stderr.trim()).error.message, /variable:target:reference/);

  const badDesign = run(['run', '--counts', counts, '--samples', samples, '--design', 'batch+condition', '--contrast', 'condition:treated:control', '--output', path.join(directory, 'out')]);
  assert.equal(badDesign.status, 2);
  assert.match(JSON.parse(badDesign.stderr.trim()).error.message, /design/);
});

test('dry-run validates the sample sheet and prints the plan', () => {
  const directory = tempDir();
  const { counts, samples } = fixture(directory);
  const output = path.join(directory, 'out');
  const result = run(['run', '--counts', counts, '--samples', samples, '--contrast', 'condition:treated:control', '--output', output, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const planned = json(result);
  assert.equal(planned.planned, true);
  assert.equal(planned.parameters.variable, 'condition');
  assert.equal(fs.existsSync(output), false);
});

test('check reports the engines', () => {
  const result = run(['check', '--format', 'json']);
  assert.ok(result.status === 0 || result.status === 1);
  const report = json(result);
  assert.equal(typeof report.python, 'string');
  assert.equal(typeof report.r.available, 'boolean');
});

test('a tiny count matrix runs end-to-end with pydeseq2', (t) => {
  if (!pydeseq2Available()) {
    t.skip('pydeseq2 is not installed for this interpreter');
    return;
  }
  const directory = tempDir();
  const { counts, samples } = fixture(directory);
  const output = path.join(directory, 'out');
  const result = run(['run', '--counts', counts, '--samples', samples, '--contrast', 'condition:treated:control', '--output', output, '--min-count', '0']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = json(result);
  assert.equal(payload.ok, true);
  for (const name of ['de_results.csv', 'normalized_counts.tsv', 'volcano.png', 'volcano.pdf', 'ma.png', 'ma.pdf', 'pca.png', 'manifest.json']) {
    assert.equal(fs.existsSync(path.join(output, name)), true, `${name} must exist`);
  }
  const header = fs.readFileSync(path.join(output, 'de_results.csv'), 'utf8').split('\n', 1)[0];
  assert.equal(header, 'gene,baseMean,log2FoldChange,lfcSE,stat,pvalue,padj');
  assert.ok(payload.summary.genes_tested > 0);
});
