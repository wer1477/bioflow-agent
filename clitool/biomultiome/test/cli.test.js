import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { description, main } from '../src/cli.js';

function io() { const data = { stdout: '', stderr: '' }; return { data, stdout: { write: (value) => { data.stdout += value; } }, stderr: { write: (value) => { data.stderr += value; } } }; }
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bio-multiome-'));
  const rna = path.join(dir, 'rna.tsv'); const atac = path.join(dir, 'atac.tsv'); const metadata = path.join(dir, 'metadata.tsv'); const links = path.join(dir, 'links.tsv'); const grn = path.join(dir, 'grn.tsv');
  await writeFile(rna, 'cell_id\tTP53\nc1\t1\nc2\t2\nc3\t3\n');
  await writeFile(atac, 'cell_id\tp1\nc1\t1\nc2\t2\nc3\t3\n');
  await writeFile(metadata, 'cell_id\tcell_type\tdonor\nc1\tA\td1\nc2\tA\td1\nc3\tA\td2\n');
  await writeFile(links, 'peak_id\tchrom\tstart\tend\tpeak_score\tgene_id\tgene_name\tlink_type\tdistance_to_tss\np1\tchr1\t1\t2\t1\tENSG1\tTP53\tpromoter_overlap\t0\n');
  await writeFile(`${links}.manifest.json`, JSON.stringify({ assembly: 'GRCh38' }));
  await writeFile(grn, 'TF\ttarget\timportance\nTF1\tTP53\t0.8\n');
  return { dir, rna, atac, metadata, links, grn };
}

test('describe is a machine registry and validate reports shared cells', async () => {
  const stream = io(); assert.equal(await main(['--describe', '--format', 'json'], stream), 0); assert.deepEqual(JSON.parse(stream.data.stdout), description);
  const files = await fixture(); const check = io();
  assert.equal(await main(['validate', '--rna', files.rna, '--atac', files.atac, '--metadata', files.metadata, '--assembly', 'GRCh38', '--group-by', 'cell_type', '--output', path.join(files.dir, 'check.json')], check), 0);
  assert.equal(JSON.parse(check.data.stdout).shared_cell_count, 3);
});

test('link produces separate RNA/ATAC and GRN evidence columns', async () => {
  const files = await fixture(); const output = path.join(files.dir, 'edges.tsv'); const stream = io();
  assert.equal(await main(['link', '--rna', files.rna, '--atac', files.atac, '--metadata', files.metadata, '--peak-links', files.links, '--grn', files.grn, '--assembly', 'GRCh38', '--group-by', 'cell_type', '--min-cells', '3', '--output', output], stream), 0);
  const result = JSON.parse(stream.data.stdout); assert.equal(result.edge_count, 1);
  const rows = (await readFile(output, 'utf8')).trim().split('\n'); assert.match(rows[1], /peak_gene_link_rna_atac_association_grn_target_support/);
  const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')); assert.equal(manifest.batch_handling, 'no_batch_key_supplied');
});

test('link rejects a peak-link assembly mismatch', async () => {
  const files = await fixture(); await writeFile(`${files.links}.manifest.json`, JSON.stringify({ assembly: 'hg19' })); const stream = io();
  assert.equal(await main(['link', '--rna', files.rna, '--atac', files.atac, '--metadata', files.metadata, '--peak-links', files.links, '--assembly', 'GRCh38', '--group-by', 'cell_type', '--min-cells', '3', '--output', path.join(files.dir, 'edges.tsv')], stream), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'assembly-mismatch');
});
