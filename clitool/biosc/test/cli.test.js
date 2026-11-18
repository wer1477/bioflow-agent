import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bio-sc.js');
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bio-sc-test-'));
}

function pythonAvailable() {
  const probe = spawnSync(testPython(), ['-c', 'import scanpy, anndata, igraph, leidenalg'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function testPython() {
  if (fs.existsSync(PYTHON)) return PYTHON;
  return 'python3';
}

test('--describe prints the machine-readable registry', () => {
  const result = run(['--describe', '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  const registry = json(result);
  assert.equal(registry.name, 'bio-sc');
  assert.ok(registry.commands.check);
  assert.ok(registry.commands.run);
  assert.equal(registry.commands.run.options.input.required, true);
});

test('--help and --version are human entry points', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: bio-sc/);
  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '0.1.0');
});

test('usage errors exit 2 with a JSON error on stderr', () => {
  const unknown = run(['nope']);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stderr.trim()).error.code, 'unknown-command');

  const missing = run(['run', '--output', tempDir()]);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr.trim()).error.code, 'missing-input');

  const absent = run(['run', '--input', '/no/such/file.h5ad', '--output', tempDir()]);
  assert.equal(absent.status, 2);
  assert.match(JSON.parse(absent.stderr.trim()).error.message, /does not exist/);
});

test('run --dry-run validates and prints a plan without writing output', () => {
  const directory = tempDir();
  const input = path.join(directory, 'tiny.h5ad');
  fs.writeFileSync(input, 'not really h5ad');
  const output = path.join(directory, 'out');
  const result = run(['run', '--input', input, '--output', output, '--min-genes', '0', '--n-hvg', '20', '--n-pcs', '5', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const planned = json(result);
  assert.equal(planned.planned, true);
  assert.equal(planned.parameters.min_genes, 0);
  assert.equal(fs.existsSync(output), false);
});

test('run requires --sample-key and --group-key together', () => {
  const directory = tempDir();
  const input = path.join(directory, 'tiny.h5ad');
  fs.writeFileSync(input, 'x');
  const result = run(['run', '--input', input, '--output', path.join(directory, 'out'), '--sample-key', 'sample']);
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stderr.trim()).error.message, /together/);
});

test('check reports the interpreter and the Scanpy stack', () => {
  const result = run(['check', '--format', 'json']);
  assert.ok(result.status === 0 || result.status === 1);
  const report = json(result);
  assert.equal(typeof report.python, 'string');
  if (result.status === 0) {
    assert.equal(report.ok, true);
    assert.equal(report.missing.includes('scanpy'), false);
  } else {
    assert.equal(report.ok, false);
    assert.ok(report.missing.length > 0);
  }
});

test('a tiny h5ad runs end-to-end when Scanpy is installed', (t) => {
  if (!pythonAvailable()) {
    t.skip('scanpy/igraph/leidenalg are not installed for this interpreter');
    return;
  }
  const directory = tempDir();
  const input = path.join(directory, 'tiny.h5ad');
  const output = path.join(directory, 'out');
  const script = [
    'import numpy as np, anndata as ad, scanpy as sc',
    'rng = np.random.default_rng(0)',
    "genes = [f'G{i}' for i in range(40)] + ['MT-CO1']",
    'counts = rng.poisson(3.0, size=(60, len(genes))).astype(np.float32)',
    "obs = {'sample': ['s1']*30 + ['s2']*30, 'condition': ['ctrl']*30 + ['case']*30}",
    "adata = ad.AnnData(X=counts, obs=obs, var={'gene_ids': genes})",
    'adata.var_names = genes',
    'adata.obs_names = [f"cell{i}" for i in range(60)]',
    'adata.write_h5ad(' + JSON.stringify(input) + ')',
  ].join('\n');
  const created = spawnSync(testPython(), ['-c', script], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const result = run(['run', '--input', input, '--output', output, '--min-genes', '0', '--max-pct-mt', '100', '--n-hvg', '20', '--n-pcs', '5', '--resolution', '0.5', '--seed', '0']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = json(result);
  assert.equal(payload.ok, true);
  for (const name of ['out.h5ad', 'qc_metrics.csv', 'clusters.csv', 'de.csv', 'umap.png', 'umap.pdf', 'manifest.json']) {
    assert.equal(fs.existsSync(path.join(output, name)), true, `${name} must exist`);
  }
  assert.ok(payload.summary.cells_after_qc > 0);
  assert.ok(payload.summary.marker_rows > 0);
});
