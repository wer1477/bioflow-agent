import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { description, main } from '../src/cli.js';

function io() { const data = { stdout: '', stderr: '' }; return { data, stdout: { write: (value) => { data.stdout += value; } }, stderr: { write: (value) => { data.stderr += value; } } }; }
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bio-epiedit-'));
  const guides = path.join(dir, 'guides.tsv'); const evidence = path.join(dir, 'evidence.json'); const links = path.join(dir, 'links.tsv'); const output = path.join(dir, 'ranked.tsv');
  await writeFile(guides, 'guide_id\tsequence\tchrom\tstart\tend\tstrand\tpam\ton_target_score\toff_target_score\ng1\tACGTACGT\tchr1\t100\t108\t+\tNGG\t0.8\t0.9\ng2\tACGTACGT\tchr1\t500\t508\t-\tNGG\t0.95\t0.95\n');
  await writeFile(evidence, JSON.stringify({ evidence: [{ assembly: 'GRCh38', region: 'chr1:101-120' }] }));
  await writeFile(links, 'peak_id\tchrom\tstart\tend\tpeak_score\tgene_id\tgene_name\tlink_type\tdistance_to_tss\np1\tchr1\t100\t150\t1\tENSG1\tTP53\tpromoter_overlap\t0\n');
  await writeFile(`${links}.manifest.json`, JSON.stringify({ assembly: 'GRCh38' }));
  return { guides, evidence, links, output };
}

test('describe and policy are machine-readable', async () => {
  const stream = io(); assert.equal(await main(['--describe', '--format', 'json'], stream), 0); assert.deepEqual(JSON.parse(stream.data.stdout), description);
  const policy = io(); assert.equal(await main(['describe-policy'], policy), 0); assert.equal(JSON.parse(policy.data.stdout).id, 'epiedit-default-v1');
});

test('rank combines explicit scores and matching coordinate artifacts in a manifest', async () => {
  const files = await fixture(); const stream = io();
  assert.equal(await main(['rank', '--guides', files.guides, '--target-gene', 'TP53', '--assembly', 'GRCh38', '--editor', 'crispri', '--regulatory-evidence', files.evidence, '--peak-links', files.links, '--output', files.output], stream), 0);
  const result = JSON.parse(stream.data.stdout); assert.equal(result.candidate_count, 2);
  const records = (await readFile(files.output, 'utf8')).trim().split('\n'); assert.match(records[1], /^g1\t/);
  const manifest = JSON.parse(await readFile(`${files.output}.manifest.json`, 'utf8')); assert.equal(manifest.inputs.guides.path, path.resolve(files.guides)); assert.equal(manifest.policy.id, 'epiedit-default-v1');
});

test('rank rejects an assembly mismatch before writing output', async () => {
  const files = await fixture(); const stream = io();
  assert.equal(await main(['rank', '--guides', files.guides, '--target-gene', 'TP53', '--assembly', 'hg19', '--editor', 'crispri', '--regulatory-evidence', files.evidence, '--output', files.output], stream), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'assembly-mismatch');
});
