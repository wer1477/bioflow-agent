import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, description, resolvePython } from '../src/cli.js';

const READ_PATTERNS = ['ACGT', 'TGCA', 'GGCC', 'NTAC'];

function io() {
  const data = { stdout: '', stderr: '' };
  return {
    data,
    stdout: { write: (value) => { data.stdout += value; } },
    stderr: { write: (value) => { data.stderr += value; } },
  };
}

async function run(argv) {
  const stream = io();
  const code = await main(argv, stream);
  return { code, stdout: stream.data.stdout, stderr: stream.data.stderr };
}

function parseJson(text) {
  assert.ok(text.trim(), 'expected JSON on stdout');
  return JSON.parse(text);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-qc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fastqText(count = 40) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const sequence = READ_PATTERNS[index % READ_PATTERNS.length];
    lines.push(`@read${index}`, sequence, '+', 'I'.repeat(sequence.length));
  }
  return `${lines.join('\n')}\n`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

let cachedCheck = null;
async function checkReport() {
  if (!cachedCheck) {
    const result = await run(['check', '--format', 'json']);
    cachedCheck = { code: result.code, report: parseJson(result.stdout), stderr: result.stderr };
  }
  return cachedCheck;
}

test('describe is a stable machine-readable registry', async () => {
  const result = await run(['--describe', '--format', 'json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const registry = parseJson(result.stdout);
  assert.deepEqual(registry, description);
  assert.equal(registry.schema_version, 1);
  assert.equal(registry.name, 'bio-qc');
  assert.equal(registry.default_format, 'json');
  assert.deepEqual(Object.keys(registry.commands), ['check', 'fastq', 'bam', 'matrix']);
  for (const name of ['check', 'fastq', 'bam', 'matrix']) {
    assert.ok(registry.schemas[registry.commands[name].output], `missing schema for ${name}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.name, 'bio-qc');
  assert.equal(packageJson.bin['bio-qc'], './bin/bio-qc.js');
  assert.equal(packageJson.version, description.version);
});

test('help and version are discoverable', async () => {
  const bare = await run([]);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /Usage: bio-qc <command>/);
  for (const command of ['check', 'fastq', 'bam', 'matrix']) assert.match(bare.stdout, new RegExp(`\\b${command}\\b`));

  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), description.version);

  const help = await run(['fastq', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--input2/);
  assert.match(help.stdout, /Examples:/);
  assert.match(help.stdout, /--dry-run/);

  const commandHelp = await run(['matrix', '--help']);
  assert.equal(commandHelp.code, 0);
  assert.match(commandHelp.stdout, /\.h5ad/);
});

test('usage and input errors exit 2 with a JSON error envelope and empty stdout', async () => {
  const cases = [
    { argv: ['nope'], code: 'unknown-command' },
    { argv: ['fastq', '--input', 'x.fastq'], code: 'missing-input' },
    { argv: ['fastq', '--output', 'out'], code: 'missing-input' },
    { argv: ['fastq', '--input', 'x.fastq', '--output', 'out', '--format', 'yaml'], code: 'invalid-input' },
    { argv: ['fastq', '--input', 'x.fastq', '--output', 'out', '--input2'], code: 'missing-value' },
    { argv: ['bam', '--input', 'x.bam', '--output', 'out', '--input2', 'y.bam'], code: 'unknown-option' },
    { argv: ['matrix', '--input', 'x.csv', '--output', 'out', '--bogus', '1'], code: 'unknown-option' },
    { argv: ['fastq', 'unexpected-positional.fastq'], code: 'unexpected-argument' },
    { argv: ['--describe', '--format', 'yaml'], code: 'invalid-input' },
  ];
  for (const entry of cases) {
    const result = await run(entry.argv);
    assert.equal(result.code, 2, `expected exit 2 for ${entry.argv.join(' ')}`);
    assert.equal(result.stdout, '', `stdout must stay empty for ${entry.argv.join(' ')}`);
    const error = parseJson(result.stderr);
    assert.equal(error.schema_version, 1);
    assert.equal(error.error.code, entry.code);
    assert.equal(typeof error.error.message, 'string');
    assert.equal(typeof error.error.hint, 'string');
  }
});

test('missing input files are rejected before Python runs', async (t) => {
  const dir = tempDir(t);
  const result = await run(['fastq', '--input', path.join(dir, 'nope.fastq'), '--output', path.join(dir, 'out')]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(parseJson(result.stderr).error.code, 'invalid-input');
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);

  const matrix = path.join(dir, 'matrix.bin');
  fs.writeFileSync(matrix, 'not a matrix');
  const unsupported = await run(['matrix', '--input', matrix, '--output', path.join(dir, 'out2')]);
  assert.equal(unsupported.code, 2);
  assert.equal(parseJson(unsupported.stderr).error.code, 'invalid-input');
});

test('check reports the selected interpreter and dependency capabilities', async () => {
  const result = await run(['check', '--format', 'json']);
  const report = parseJson(result.stdout);
  assert.equal(report.schema_version, 1);
  assert.equal(report.command, 'check');
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(result.code, report.ok ? 0 : 1);
  assert.equal(typeof report.python, 'object');
  assert.equal(typeof report.python.ok, 'boolean');
  assert.ok(Array.isArray(report.python.candidates));
  assert.equal(typeof report.modules, 'object');
  assert.equal(typeof report.tools, 'object');
  for (const tool of ['fastp', 'fastqc', 'samtools']) {
    assert.equal(typeof report.tools[tool].available, 'boolean');
  }
  assert.ok(Array.isArray(report.missing));
  assert.ok(Array.isArray(report.optional_missing));
  assert.ok(Array.isArray(report.hints));
  assert.equal(typeof report.capabilities.fastq, 'boolean');
  assert.equal(typeof report.capabilities.bam, 'boolean');
  assert.equal(typeof report.capabilities.matrix_csv, 'boolean');
  assert.equal(typeof report.capabilities.matrix_h5ad, 'boolean');
  assert.equal(typeof report.capabilities.matrix_mtx, 'boolean');
  const repoPython = fileURLToPath(new URL('../../../.bioenv/bin/python', import.meta.url));
  if (fs.existsSync(repoPython) && !process.env.BIOAGENT_ENV_BIN) {
    assert.equal(report.python.command, repoPython);
  }
});

test('fastq streams reads, computes deterministic metrics, and writes artifacts', async (t) => {
  const resolved = resolvePython();
  if (!resolved.python) {
    t.skip('No working Python interpreter is available for fastq QC.');
    return;
  }
  const dir = tempDir(t);
  const read1 = path.join(dir, 'R1.fastq');
  const read2 = path.join(dir, 'R2.fastq');
  fs.writeFileSync(read1, fastqText(40));
  fs.writeFileSync(read2, fastqText(40));
  const output = path.join(dir, 'out');

  const result = await run(['fastq', '--input', read1, '--input2', read2, '--output', output, '--format', 'json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = parseJson(result.stdout);
  assert.equal(payload.planned, false);
  assert.equal(payload.summary.reads, 80);
  assert.equal(payload.summary.bases, 320);
  assert.equal(payload.summary.read_pairs, 40);
  assert.equal(payload.summary.q20_ratio, 1);
  assert.equal(payload.summary.q30_ratio, 1);
  assert.ok(Math.abs(payload.summary.gc_pct - 56.25) < 1e-9);
  assert.ok(Math.abs(payload.summary.n_pct - 6.25) < 1e-9);
  assert.equal(payload.summary.mean_length, 4);
  assert.equal(payload.summary.min_length, 4);
  assert.equal(payload.summary.max_length, 4);

  const qc = JSON.parse(fs.readFileSync(path.join(output, 'qc.json'), 'utf8'));
  assert.equal(qc.command, 'fastq');
  assert.equal(qc.files.length, 2);
  assert.equal(qc.combined.reads, 80);
  assert.deepEqual(qc.combined.length_distribution, [{ length: 4, count: 80 }]);
  assert.deepEqual(qc.combined.length_bins, [{ start: 4, end: 4, count: 80 }]);
  assert.equal(qc.files[0].sha256, sha256(fs.readFileSync(read1)));

  const tsv = fs.readFileSync(path.join(output, 'qc.tsv'), 'utf8').trim().split('\n');
  assert.equal(tsv.length, 4);
  assert.match(tsv[0], /^file\treads\tbases\tq20_ratio/);
  assert.match(tsv[3], /^combined\t80\t320\t/);

  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.tool.name, 'bio-qc');
  assert.equal(manifest.tool.version, description.version);
  assert.equal(manifest.command_name, 'fastq');
  assert.deepEqual(manifest.command.slice(0, 2), ['bio-qc', 'fastq']);
  assert.equal(manifest.inputs.length, 2);
  assert.equal(manifest.inputs[0].role, 'r1');
  assert.equal(manifest.inputs[0].sha256, sha256(fs.readFileSync(read1)));
  assert.equal(manifest.inputs[1].sha256, sha256(fs.readFileSync(read2)));
  assert.equal(manifest.outputs.length, 2);
  for (const entry of manifest.outputs) {
    assert.equal(entry.sha256, sha256(fs.readFileSync(entry.path)));
    assert.equal(entry.bytes, fs.statSync(entry.path).size);
  }
});

test('fastq detects gzip by magic bytes rather than file extension', async (t) => {
  const resolved = resolvePython();
  if (!resolved.python) {
    t.skip('No working Python interpreter is available for fastq QC.');
    return;
  }
  const dir = tempDir(t);
  const compressed = path.join(dir, 'reads.fastq');
  fs.writeFileSync(compressed, zlib.gzipSync(Buffer.from(fastqText(40))));
  const output = path.join(dir, 'out');
  const result = await run(['fastq', '--input', compressed, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.summary.reads, 40);
  assert.equal(payload.input.read1.compression, 'gzip');
  assert.equal(payload.input.read1.sha256, sha256(fs.readFileSync(compressed)));
  const qc = JSON.parse(fs.readFileSync(path.join(output, 'qc.json'), 'utf8'));
  assert.equal(qc.files[0].compression, 'gzip');
  assert.equal(qc.combined.reads, 40);
});

test('fastq dry-run validates inputs without writing files', async (t) => {
  const dir = tempDir(t);
  const read1 = path.join(dir, 'R1.fastq');
  fs.writeFileSync(read1, fastqText(4));
  const output = path.join(dir, 'dry-run-out');
  const result = await run(['fastq', '--input', read1, '--output', output, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.planned, true);
  assert.equal(payload.note, 'No files were written; the real run will create qc.json, qc.tsv, and manifest.json in --output.');
  assert.equal(payload.planned_files.length, 3);
  for (const file of payload.planned_files) assert.equal(file.startsWith(output), true);
  assert.equal(fs.existsSync(output), false);
});

test('bam summarizes alignments, duplicates, pairing, insert size, and coverage', async (t) => {
  const resolved = resolvePython();
  if (!resolved.python) {
    t.skip('No working Python interpreter is available for BAM QC.');
    return;
  }
  const check = await checkReport();
  if (!check.report.modules?.pysam?.available) {
    t.skip('pysam is not available in the selected Python interpreter.');
    return;
  }
  const dir = tempDir(t);
  const sam = path.join(dir, 'sample.sam');
  fs.writeFileSync(sam, [
    '@HD\tVN:1.6\tSO:coordinate',
    '@SQ\tSN:chr1\tLN:1000',
    'p1\t99\tchr1\t1\t60\t4M\t=\t101\t104\tACGT\tIIII',
    'p1\t147\tchr1\t101\t60\t4M\t=\t1\t-104\tTGCA\tIIII',
    'p2\t99\tchr1\t201\t60\t4M\t=\t301\t104\tACGT\tIIII',
    'p2\t147\tchr1\t301\t60\t4M\t=\t201\t-104\tTGCA\tIIII',
    's1\t0\tchr1\t401\t60\t4M\t*\t0\t0\tACGT\tIIII',
    's2\t1024\tchr1\t501\t60\t4M\t*\t0\t0\tACGT\tIIII',
    's3\t0\tchr1\t601\t60\t4M\t*\t0\t0\tACGT\tIIII',
    's4\t0\tchr1\t701\t60\t4M\t*\t0\t0\tACGT\tIIII',
    'u1\t4\t*\t0\t0\t*\t*\t0\t0\tNNNN\tIIII',
    'u2\t4\t*\t0\t0\t*\t*\t0\t0\tNNNN\tIIII',
    '',
  ].join('\n'));
  const bam = path.join(dir, 'sample.bam');
  const script = [
    'import pysam, sys',
    'source, target = sys.argv[1], sys.argv[2]',
    'with pysam.AlignmentFile(source, "r") as src, pysam.AlignmentFile(target, "wb", template=src) as dst:',
    '    for read in src:',
    '        dst.write(read)',
  ].join('\n');
  const conversion = spawnSync(resolved.python.command, ['-c', script, sam, bam], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONWARNINGS: 'ignore' },
  });
  assert.equal(conversion.status, 0, conversion.stderr);

  const output = path.join(dir, 'out');
  const result = await run(['bam', '--input', bam, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.summary.total_reads, 10);
  assert.equal(payload.summary.mapped_reads, 8);
  assert.ok(Math.abs(payload.summary.mapped_ratio - 0.8) < 1e-9);
  assert.ok(Math.abs(payload.summary.duplicate_ratio - 0.125) < 1e-9);
  assert.ok(Math.abs(payload.summary.properly_paired_ratio - 0.5) < 1e-9);
  assert.ok(Math.abs(payload.summary.average_insert_size - 104) < 1e-9);
  assert.equal(payload.summary.reference_count, 1);
  assert.equal(payload.summary.mean_coverage, 0.032);
  assert.equal(payload.summary.genome_coverage, 0.032);
  assert.equal(payload.input.sha256, sha256(fs.readFileSync(bam)));

  const qc = JSON.parse(fs.readFileSync(path.join(output, 'qc.json'), 'utf8'));
  assert.equal(qc.metrics.total_reads, 10);
  assert.equal(qc.metrics.top_references[0].aligned_bases, 32);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.inputs[0].sha256, sha256(fs.readFileSync(bam)));
});

test('matrix reads a dense CSV and computes per-cell and mitochondrial QC', async (t) => {
  const resolved = resolvePython();
  if (!resolved.python) {
    t.skip('No working Python interpreter is available for matrix QC.');
    return;
  }
  const dir = tempDir(t);
  const csv = path.join(dir, 'matrix.csv');
  fs.writeFileSync(csv, ',MT-CO1,ACTB,GAPDH\nc1,10,20,30\nc2,0,5,5\nc3,2,0,0\n');
  const output = path.join(dir, 'out');
  const result = await run(['matrix', '--input', csv, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.summary.cells, 3);
  assert.equal(payload.summary.genes, 3);
  assert.equal(payload.summary.total_counts, 72);
  assert.equal(payload.summary.median_counts_per_cell, 10);
  assert.equal(payload.summary.median_genes_detected, 2);
  assert.equal(payload.summary.mito_gene_count, 1);
  assert.equal(payload.summary.cells_over_20pct_mito, 1);
  assert.ok(Math.abs(payload.summary.pct_mito_median - 16.666667) < 1e-6);

  const qc = JSON.parse(fs.readFileSync(path.join(output, 'qc.json'), 'utf8'));
  assert.equal(qc.metrics.matrix.count_values_look_raw, true);
  assert.equal(qc.metrics.pct_mito.prefix, 'MT-');
  assert.equal(qc.metrics.counts_per_cell.max, 60);
  const tsv = fs.readFileSync(path.join(output, 'qc.tsv'), 'utf8');
  assert.match(tsv, /^section\tmetric\tvalue/m);
  assert.match(tsv, /matrix\.cells\t3/);
  assert.match(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'), /"command_name": "matrix"/);

  const dryOutput = path.join(dir, 'dry');
  const dry = await run(['matrix', '--input', csv, '--output', dryOutput, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(parseJson(dry.stdout).planned, true);
  assert.equal(fs.existsSync(dryOutput), false);
});

test('matrix reads a 10x Matrix Market directory when scipy is available', async (t) => {
  const resolved = resolvePython();
  if (!resolved.python) {
    t.skip('No working Python interpreter is available for matrix QC.');
    return;
  }
  const check = await checkReport();
  if (!check.report.modules?.scipy?.available) {
    t.skip('scipy is not available in the selected Python interpreter.');
    return;
  }
  const dir = tempDir(t);
  const mtxDir = path.join(dir, 'filtered_feature_bc_matrix');
  fs.mkdirSync(mtxDir);
  fs.writeFileSync(path.join(mtxDir, 'matrix.mtx'), [
    '%%MatrixMarket matrix coordinate integer general',
    '%',
    '3 3 6',
    '1 1 10',
    '2 1 20',
    '3 1 30',
    '2 2 5',
    '3 2 5',
    '1 3 2',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(mtxDir, 'features.tsv'), [
    'MT-CO1\tMT-CO1\tGene Expression',
    'ACTB\tACTB\tGene Expression',
    'GAPDH\tGAPDH\tGene Expression',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(mtxDir, 'barcodes.tsv'), 'c1\nc2\nc3\n');
  const output = path.join(dir, 'out');
  const result = await run(['matrix', '--input', mtxDir, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.input.type, 'mtx-dir');
  assert.equal(payload.summary.cells, 3);
  assert.equal(payload.summary.genes, 3);
  assert.equal(payload.summary.total_counts, 72);
  assert.equal(payload.summary.cells_over_20pct_mito, 1);
  assert.equal(payload.warnings.length, 0);
});

test('matrix reads .h5ad through anndata when available', async (t) => {
  const resolved = resolvePython();
  if (!resolved.python) {
    t.skip('No working Python interpreter is available for matrix QC.');
    return;
  }
  const check = await checkReport();
  if (!check.report.modules?.anndata?.available || !check.report.modules?.h5py?.available) {
    t.skip('anndata or h5py is not available in the selected Python interpreter.');
    return;
  }
  const dir = tempDir(t);
  const h5ad = path.join(dir, 'matrix.h5ad');
  const script = [
    'import anndata, numpy as np, pandas as pd, sys',
    'matrix = np.array([[10, 20, 30], [0, 5, 5], [2, 0, 0]], dtype=np.float32)',
    'adata = anndata.AnnData(X=matrix, obs=pd.DataFrame(index=["c1", "c2", "c3"]), var=pd.DataFrame(index=["MT-CO1", "ACTB", "GAPDH"]))',
    'adata.write_h5ad(sys.argv[1])',
  ].join('\n');
  const creation = spawnSync(resolved.python.command, ['-c', script, h5ad], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONWARNINGS: 'ignore' },
  });
  assert.equal(creation.status, 0, creation.stderr);
  const output = path.join(dir, 'out');
  const result = await run(['matrix', '--input', h5ad, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.input.type, 'h5ad');
  assert.equal(payload.summary.cells, 3);
  assert.equal(payload.summary.genes, 3);
  assert.equal(payload.summary.total_counts, 72);
  assert.equal(payload.summary.cells_over_20pct_mito, 1);
});

test('bam dry-run does not require pysam and writes nothing', async (t) => {
  const dir = tempDir(t);
  const input = path.join(dir, 'placeholder.bam');
  fs.writeFileSync(input, 'not a real bam');
  const output = path.join(dir, 'dry');
  const result = await run(['bam', '--input', input, '--output', output, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.planned, true);
  assert.equal(fs.existsSync(output), false);
});
