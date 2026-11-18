import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { description, main } from '../src/cli.js';
import { runInference } from '../src/runner.js';

function io() {
  const data = { stdout: '', stderr: '' };
  return { data, stdout: { write: (value) => { data.stdout += value; } }, stderr: { write: (value) => { data.stderr += value; } } };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bio-grn-'));
  const expression = path.join(dir, 'expression.tsv');
  const tfs = path.join(dir, 'tfs.txt');
  await writeFile(expression, 'TF1\tTARGET1\tTARGET2\n1\t2\t3\n2\t3\t4\n3\t4\t5\n');
  await writeFile(tfs, 'TF1\nNOT_IN_MATRIX\n');
  return { dir, expression, tfs, output: path.join(dir, 'network.tsv') };
}

test('describe is a parseable machine registry', async () => {
  const stream = io();
  assert.equal(await main(['--describe', '--format', 'json'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), description);
});

test('dry-run validates the expression matrix and produces a reproducible plan', async () => {
  const files = await fixture();
  const stream = io();
  assert.equal(await main(['infer', '--expression', files.expression, '--tfs', files.tfs, '--output', files.output, '--seed', '9', '--dry-run'], stream), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, true);
  assert.equal(result.seed, 9);
  assert.equal(result.input.observation_count, 3);
  assert.equal(result.input.gene_count, 3);
  assert.equal(result.input.retained_tf_count, 1);
  assert.equal(result.interpretation, 'candidate_regulatory_associations_not_causal_or_direct_binding_evidence');
});

test('inference delegates a bounded request and returns candidate-edge metadata', async () => {
  const files = await fixture();
  const calls = [];
  const stream = io();
  const infer = async (request) => {
    calls.push(request);
    return { edge_count: 8, retained_edge_count: 2, python: '3.12.0', arboreto: '0.1.6' };
  };
  assert.equal(await main(['infer', '--expression', files.expression, '--tfs', files.tfs, '--output', files.output, '--method', 'genie3', '--max-edges', '2'], stream, { infer }), 0);
  assert.equal(calls[0].method, 'genie3');
  assert.equal(calls[0].max_edges, 2);
  assert.deepEqual(calls[0].tf_names, ['TF1']);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.edge_count, 8);
  assert.equal(result.retained_edge_count, 2);
  assert.equal(result.planned, false);
});

test('invalid matrices and missing TF overlap fail before inference', async () => {
  const files = await fixture();
  await writeFile(files.expression, 'TF1\tTARGET1\n1\tnope\n2\t3\n3\t4\n');
  const stream = io();
  assert.equal(await main(['infer', '--expression', files.expression, '--tfs', files.tfs, '--output', files.output, '--dry-run'], stream), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'invalid-input');

  await writeFile(files.expression, 'TF1\tTARGET1\n1\t2\n2\t3\n3\t4\n');
  await writeFile(files.tfs, 'MISSING\n');
  const noOverlap = io();
  assert.equal(await main(['infer', '--expression', files.expression, '--tfs', files.tfs, '--output', files.output, '--dry-run'], noOverlap), 2);
  assert.equal(JSON.parse(noOverlap.data.stderr).error.code, 'invalid-input');
});

test('inference python child uses the legacy dask dataframe backend', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bio-grn-python-'));
  const interpreter = path.join(dir, 'fake-python');
  await writeFile(interpreter, '#!/bin/sh\ncat > /dev/null\nprintf \'{"edge_count":0,"retained_edge_count":0,"dask":"%s"}\\n\' "$DASK_DATAFRAME__QUERY_PLANNING"\n');
  await chmod(interpreter, 0o755);
  const result = await runInference({
    expression_path: path.join(dir, 'expression.tsv'),
    tf_names: ['TF1'],
    method: 'grnboost2',
    seed: 1,
    max_edges: 10,
    output_path: path.join(dir, 'network.tsv'),
    manifest_path: path.join(dir, 'network.tsv.manifest.json'),
  }, { python: interpreter });
  assert.equal(result.dask, 'false');
});
