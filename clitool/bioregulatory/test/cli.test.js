import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { description, main } from '../src/cli.js';

function io() {
  const data = { stdout: '', stderr: '' };
  return { data, stdout: { write: (value) => { data.stdout += value; } }, stderr: { write: (value) => { data.stderr += value; } } };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bio-regulatory-'));
  const input = path.join(root, 'cpgIslandExt.txt');
  const dataDir = path.join(root, 'reference');
  await writeFile(input, '585\tchr1\t100\t200\tCpG:_100\t100\t12\t34\t12.0\t34.0\t0.8\n');
  return { root, input, dataDir, output: path.join(root, 'evidence.json') };
}

test('describe and sources expose a parseable machine contract', async () => {
  const stream = io();
  assert.equal(await main(['--describe', '--format', 'json'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), description);
  const listed = io();
  assert.equal(await main(['sources', '--format', 'json'], listed), 0);
  assert.ok(JSON.parse(listed.data.stdout).sources.some((source) => source.id === 'cpg-island'));
});

test('prepare copies a versioned local dataset into the catalog and query writes evidence plus manifest', async () => {
  const files = await fixture();
  const prepared = io();
  assert.equal(await main(['prepare', '--source', 'cpg-island', '--assembly', 'GRCh38', '--version', 'test-1', '--data-dir', files.dataDir, '--input', files.input, '--format', 'json'], prepared), 0);
  const prepareResult = JSON.parse(prepared.data.stdout);
  assert.equal(prepareResult.planned, false);
  assert.match(prepareResult.dataset.sha256, /^[a-f0-9]{64}$/);
  const catalog = JSON.parse(await readFile(path.join(files.dataDir, 'catalog.json'), 'utf8'));
  assert.equal(catalog.datasets[0].source, 'cpg-island');
  assert.ok(!catalog.datasets[0].file_path.startsWith('..'));

  const queried = io();
  assert.equal(await main(['query', '--region', 'chr1:151-170', '--assembly', 'GRCh38', '--data-dir', files.dataDir, '--output', files.output, '--format', 'json'], queried), 0);
  const queryResult = JSON.parse(queried.data.stdout);
  assert.equal(queryResult.evidence_count, 1);
  const evidence = JSON.parse(await readFile(files.output, 'utf8'));
  assert.equal(evidence.evidence[0].evidence_type, 'cpg_island');
  assert.equal(evidence.evidence[0].region, 'chr1:101-200');
  const manifest = JSON.parse(await readFile(`${files.output}.manifest.json`, 'utf8'));
  assert.equal(manifest.datasets[0].version, 'test-1');
  assert.match(manifest.output_sha256, /^[a-f0-9]{64}$/);
});

test('dry-run validates an explicit source plan without writing reference state', async () => {
  const files = await fixture();
  const stream = io();
  assert.equal(await main(['prepare', '--source', 'encode-peak', '--assembly', 'GRCh38', '--version', 'ENCFFTEST', '--data-dir', files.dataDir, '--input', files.input, '--biosample', 'HepG2', '--assay', 'ATAC-seq', '--dry-run'], stream), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, true);
  await assert.rejects(readFile(path.join(files.dataDir, 'catalog.json')));
});

test('query rejects assembly mismatches and gene resolution is captured in the manifest', async () => {
  const files = await fixture();
  const prepared = io();
  await main(['prepare', '--source', 'cpg-island', '--assembly', 'GRCh38', '--version', 'test-1', '--data-dir', files.dataDir, '--input', files.input], prepared);
  const mismatch = io();
  assert.equal(await main(['query', '--region', 'chr1:151-170', '--assembly', 'GRCh37', '--data-dir', files.dataDir, '--output', files.output], mismatch), 2);
  assert.equal(JSON.parse(mismatch.data.stderr).error.code, 'no-compatible-dataset');

  const resolvedOutput = path.join(files.root, 'gene-evidence.json');
  const stream = io();
  const resolveGene = async () => ({ region: { chromosome: 'chr1', start: 151, end: 170, bed_start: 150, bed_end: 170, display: 'chr1:151-170' }, resolver: { source: 'test-resolver', record: { id: 'TEST1' } } });
  assert.equal(await main(['query', '--gene', 'TEST1', '--assembly', 'GRCh38', '--data-dir', files.dataDir, '--output', resolvedOutput], stream, { resolveGene }), 0);
  const manifest = JSON.parse(await readFile(`${resolvedOutput}.manifest.json`, 'utf8'));
  assert.equal(manifest.query.resolver.source, 'test-resolver');
});
