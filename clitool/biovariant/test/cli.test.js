import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, description } from '../src/cli.js';
import { createClient } from '../src/client.js';

function io() {
  const data = { stdout: '', stderr: '' };
  return { data, stdout: { write: (value) => { data.stdout += value; } }, stderr: { write: (value) => { data.stderr += value; } } };
}

test('describe is a parseable machine registry', async () => {
  const stream = io();
  assert.equal(await main(['--describe', '--format', 'json'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), description);
});

test('single-coordinate annotation calls VEP and normalizes consequences and clinical evidence', async () => {
  const calls = [];
  const client = createClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify([{
      input: '17 7674220 . C T . . .', seq_region_name: '17', start: 7674220, end: 7674220, strand: 1,
      allele_string: 'C/T', most_severe_consequence: 'missense_variant',
      transcript_consequences: [{ gene_id: 'ENSG00000141510', gene_symbol: 'TP53', transcript_id: 'ENST00000269305', biotype: 'protein_coding', consequence_terms: ['missense_variant'], impact: 'MODERATE', canonical: 1, mane_select: 'ENST00000269305.9', hgvsc: 'ENST00000269305.9:c.215C>T', hgvsp: 'ENSP00000269305.4:p.Pro72Leu' }],
      colocated_variants: [{ id: 'rs1042522', allele_string: 'C/T', clin_sig: ['benign'], phenotype_or_disease: 1, somatic: 0 }],
    }]), { status: 200 });
  } });
  const stream = io();
  assert.equal(await main(['annotate', '--variant', '17:7674220:C:T'], stream, { client }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.query.assembly, 'GRCh38');
  assert.equal(result.annotations[0].transcripts[0].gene_symbol, 'TP53');
  assert.deepEqual(result.annotations[0].clinical_evidence[0].clinical_significance, ['benign']);
  assert.match(calls[0].url, /vep\/homo_sapiens\/region/);
  assert.match(calls[0].url, /canonical=1/);
  assert.match(calls[0].url, /mane=1/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { variants: ['17 7674220 . C T . . .'] });
});

test('dry-run validates a VCF, expands multi-allelic rows, and does not call a provider', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-variant-test-'));
  const fixture = path.join(directory, 'variants.vcf');
  await fs.writeFile(fixture, '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\nchr17\t7674220\t.\tC\tT,G\t.\t.\t.\n');
  try {
    const stream = io();
    const client = { annotate: async () => assert.fail('must not run') };
    assert.equal(await main(['annotate', '--input', fixture, '--dry-run'], stream, { client }), 0);
    const result = JSON.parse(stream.data.stdout);
    assert.deepEqual(result.query.variants, ['17:7674220:C:T', '17:7674220:C:G']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('dry-run validates a single variant without calling a provider', async () => {
  const stream = io();
  const client = { annotate: async () => assert.fail('must not run') };
  assert.equal(await main(['annotate', '--variant', '17:7674220:C:T', '--dry-run'], stream, { client }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, true);
  assert.deepEqual(result.annotations, []);
});

test('invalid variants fail with a usage error and clean stdout', async () => {
  const stream = io();
  assert.equal(await main(['annotate', '--variant', '17:abc:C:T'], stream), 2);
  assert.equal(stream.data.stdout, '');
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'invalid-input');
});

test('GRCh37 uses its dedicated Ensembl REST host and does not request MANE', async () => {
  const calls = [];
  const client = createClient({ fetchImpl: async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify([]), { status: 200 });
  } });
  const stream = io();
  assert.equal(await main(['annotate', '--variant', '17:7674220:C:T', '--assembly', 'GRCh37'], stream, { client }), 0);
  assert.match(calls[0], /^https:\/\/grch37\.rest\.ensembl\.org/);
  assert.doesNotMatch(calls[0], /mane=1/);
});
