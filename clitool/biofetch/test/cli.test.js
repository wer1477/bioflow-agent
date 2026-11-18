import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { description, main } from '../src/cli.js';

const GIB = 1024 ** 3;

function io() {
  const data = { stdout: '', stderr: '' };
  return { data, stdout: { write: (value) => { data.stdout += value; } }, stderr: { write: (value) => { data.stderr += value; } } };
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bio-fetch-test-'));
}

test('describe is a parseable machine registry', async () => {
  const stream = io();
  assert.equal(await main(['--describe', '--format', 'json'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), description);
});

test('genome dry-run validates the package request without invoking datasets or writing files', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'GRCh38.zip');
  const stream = io();
  const runner = { run: async () => assert.fail('dry-run must not invoke a tool') };
  assert.equal(await main(['genome', '--accession', 'GCF_000001405.40', '--output', output, '--dry-run'], stream, { runner }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, true);
  assert.deepEqual(result.include, ['genome', 'gff3', 'protein', 'cds']);
  assert.equal(await fs.stat(output).then(() => true, () => false), false);
  await fs.rm(directory, { recursive: true, force: true });
});

test('genome records its command, checksum, tool version, and adjacent manifest', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'assembly.zip');
  const calls = [];
  const runner = { run: async (command, args) => {
    calls.push([command, args]);
    if (args[0] === '--version') return { stdout: 'datasets version 18.10.0', stderr: '' };
    await fs.writeFile(args[args.indexOf('--filename') + 1], 'archive-bytes');
    return { stdout: '', stderr: '' };
  } };
  const stream = io();
  assert.equal(await main(['genome', '--accession', 'GCF_000001405.40', '--include', 'genome,gff3', '--output', output], stream, { runner }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, false);
  assert.equal(result.bytes_written, 13);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls[1][0], 'datasets');
  const manifest = JSON.parse(await fs.readFile(`${output}.bio-fetch.json`, 'utf8'));
  assert.equal(manifest.tool.version, 'datasets version 18.10.0');
  assert.equal(manifest.artifact.path, output);
  await fs.rm(directory, { recursive: true, force: true });
});

test('sra dry-run describes bounded conversion without invoking SRA Toolkit', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'run');
  const stream = io();
  const runner = { run: async () => assert.fail('dry-run must not invoke a tool') };
  assert.equal(await main(['sra', '--accession', 'SRR11180057', '--output', output, '--threads', '4', '--max-disk-gib', '10', '--dry-run'], stream, { runner }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.threads, 4);
  assert.equal(result.max_disk_gib, 10);
  assert.equal(await fs.stat(output).then(() => true, () => false), false);
  await fs.rm(directory, { recursive: true, force: true });
});

test('sra stages tool output and atomically publishes a manifest with checksummed FASTQ files', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'run');
  const runner = { run: async (command, args) => {
    if (args[0] === '--version') return { stdout: `${command} 3.1.1`, stderr: '' };
    if (command === 'prefetch') {
      const target = path.join(args[args.indexOf('--output-directory') + 1], 'SRR11180057');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'SRR11180057.sra'), 'sra');
    } else {
      const target = args[args.indexOf('--outdir') + 1];
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'SRR11180057_1.fastq'), '@r1\nACGT\n+\n!!!!\n');
      await fs.writeFile(path.join(target, 'SRR11180057_2.fastq'), '@r2\nTGCA\n+\n!!!!\n');
    }
    return { stdout: '', stderr: '' };
  } };
  const stream = io();
  assert.equal(await main(['sra', '--accession', 'SRR11180057', '--output', output, '--max-disk-gib', '1'], stream, { runner, freeSpace: async () => 2 * 1024 ** 3 }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.artifacts.length, 2);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.tools.prefetch, 'prefetch 3.1.1');
  assert.equal(manifest.artifacts.length, 2);
  await fs.rm(directory, { recursive: true, force: true });
});

test('sra rejects an existing output directory before it invokes a command', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'run');
  await fs.mkdir(output);
  const stream = io();
  const runner = { run: async () => assert.fail('existing output must stop before tool invocation') };
  assert.equal(await main(['sra', '--accession', 'SRR11180057', '--output', output, '--max-disk-gib', '1'], stream, { runner, freeSpace: async () => 2 * GIB }), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'output-exists');
  await fs.rm(directory, { recursive: true, force: true });
});
