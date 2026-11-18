import { access, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bio-peak-'));
  const treatment = path.join(dir, 'treatment.bam');
  const control = path.join(dir, 'control.bam');
  const peaks = path.join(dir, 'peaks.bed');
  const background = path.join(dir, 'background.bed');
  const annotation = path.join(dir, 'annotation.gtf');
  await Promise.all([
    writeFile(treatment, 'not-a-real-bam'), writeFile(control, 'not-a-real-bam'),
    writeFile(peaks, 'chr1\t950\t1050\tpromoter_peak\t10\nchr1\t4900\t4950\tnear_peak\t20\n'),
    writeFile(background, 'chr1\t2000\t2100\n'),
    writeFile(annotation, 'chr1\tfixture\tgene\t1001\t2000\t.\t+\t.\tgene_id "GENE1"; gene_name "One";\nchr1\tfixture\tgene\t10001\t11000\t.\t-\t.\tgene_id "GENE2"; gene_name "Two";\n'),
  ]);
  return { dir, treatment, control, peaks, background, annotation };
}

function runner(calls) {
  return { run: async (command, args) => {
    calls.push({ command, args });
    if (command === 'macs2' && args[0] === 'callpeak') {
      const outdir = args[args.indexOf('--outdir') + 1];
      await mkdir(outdir, { recursive: true });
      await writeFile(path.join(outdir, 'bio-peak_peaks.narrowPeak'), 'chr1\t1\t2\n');
    }
    if (command === 'findMotifsGenome.pl') {
      const outdir = args[2];
      await mkdir(outdir, { recursive: true });
      await writeFile(path.join(outdir, 'knownResults.txt'), 'motif\n');
    }
    return { stdout: `${command} version`, stderr: '' };
  } };
}

test('describe is a parseable machine registry', async () => {
  const stream = io();
  assert.equal(await main(['--describe', '--format', 'json'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), description);
});

test('call dry-run creates an assay-specific MACS2 command plan without running it', async () => {
  const files = await fixture();
  const stream = io(); const calls = [];
  assert.equal(await main(['call', '--treatment', files.treatment, '--assay', 'atac-seq', '--genome-size', 'hs', '--output', path.join(files.dir, 'called'), '--dry-run'], stream, { runner: runner(calls) }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, true);
  assert.deepEqual(result.plan.command.slice(-7), ['--nomodel', '--shift', '-100', '--extsize', '200', '--keep-dup', 'all']);
  assert.equal(calls.length, 0);
});

test('call runs MACS2 through the adapter and writes a manifest with its output', async () => {
  const files = await fixture();
  const stream = io(); const calls = []; const output = path.join(files.dir, 'called');
  assert.equal(await main(['call', '--treatment', files.treatment, '--control', files.control, '--assay', 'chip-seq', '--genome-size', 'hs', '--output', output], stream, { runner: runner(calls) }), 0);
  assert.deepEqual(calls.map((call) => call.command), ['macs2', 'macs2']);
  await access(path.join(output, 'bio-peak_peaks.narrowPeak'));
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.parameters.assay, 'chip-seq');
  assert.equal(manifest.input.control, path.resolve(files.control));
});

test('motif requires explicit background and delegates to HOMER', async () => {
  const files = await fixture();
  const missingBackground = io();
  assert.equal(await main(['motif', '--peaks', files.peaks, '--genome', 'hg38', '--output', path.join(files.dir, 'motifs')], missingBackground), 2);
  assert.equal(JSON.parse(missingBackground.data.stderr).error.code, 'missing-input');

  const stream = io(); const calls = []; const output = path.join(files.dir, 'motifs');
  assert.equal(await main(['motif', '--peaks', files.peaks, '--background', files.background, '--genome', 'hg38', '--lengths', '8,10', '--output', output], stream, { runner: runner(calls) }), 0);
  assert.equal(calls.at(-1).command, 'findMotifsGenome.pl');
  await access(path.join(output, 'manifest.json'));
});

test('link writes deterministic promoter-first and nearest-TSS candidates with manifest', async () => {
  const files = await fixture();
  const stream = io(); const output = path.join(files.dir, 'links.tsv');
  assert.equal(await main(['link', '--peaks', files.peaks, '--annotation', files.annotation, '--assembly', 'GRCh38', '--output', output, '--max-distance', '10000'], stream), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.link_count, 2);
  const rows = (await readFile(output, 'utf8')).trim().split('\n');
  assert.match(rows[1], /promoter_overlap/);
  assert.match(rows[2], /nearest_tss/);
  const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'));
  assert.equal(manifest.assembly, 'GRCh38');
  assert.equal(manifest.output.link_count, 2);
});

test('tools reports unavailable external executables without failing the probe', async () => {
  const stream = io();
  const absent = { run: async (command) => { throw new Error(`Required executable \"${command}\" was not found on PATH.`); } };
  assert.equal(await main(['tools'], stream, { runner: absent }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.tools.every((tool) => !tool.available), true);
});
