import test from 'node:test';
import assert from 'node:assert/strict';
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

test('validate parses FASTA and reports alphabet metadata without returning sequence payloads', async () => {
  const stream = io();
  assert.equal(await main(['validate', '--sequence', '>dna\nATGNNN\n>protein\nMKWVTF'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout).records, [
    { id: 'dna', type: 'nucleotide', length: 6, ambiguous_count: 3 },
    { id: 'protein', type: 'protein', length: 6, ambiguous_count: 0 },
  ]);
});

test('translate uses the selected forward frame and represents incomplete ambiguous codons as X', async () => {
  const stream = io();
  assert.equal(await main(['translate', '--sequence', 'AATGNNNTAA', '--frame', '2'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout).records, [{ id: 'sequence_1', input_length: 10, protein: 'MX*' }]);
});

test('blast dry-run validates, infers the default database, and does not submit', async () => {
  const stream = io();
  const client = { submitBlast: async () => assert.fail('must not submit') };
  assert.equal(await main(['blast', '--sequence', 'MKWVTF', '--program', 'blastp', '--email', 'researcher@example.org', '--dry-run'], stream, { client }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, true);
  assert.equal(result.query.database, 'nr');
  assert.equal(result.rid, null);
});

test('blast submits to NCBI and returns a RID with polling guidance', async () => {
  const calls = [];
  const client = createClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('RID = ABCD1234\nRTOE = 42\n', { status: 200 });
  } });
  const stream = io();
  assert.equal(await main(['blast', '--sequence', 'ACGTACGT', '--program', 'blastn', '--database', 'core_nt', '--max-hits', '5', '--email', 'researcher@example.org'], stream, { client }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.rid, 'ABCD1234');
  assert.equal(result.estimated_wait_seconds, 42);
  assert.match(result.next.command, /blast-status --rid ABCD1234/);
  assert.equal(calls[0].options.body.get('PROGRAM'), 'blastn');
  assert.equal(calls[0].options.body.get('DATABASE'), 'core_nt');
});

test('blast status and results use only the supplied RID', async () => {
  const stream = io();
  const client = { blastStatus: async ({ rid }) => ({ rid, status: 'ready', has_hits: true }) };
  assert.equal(await main(['blast-status', '--rid', 'ABCD1234'], stream, { client }), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), { schema_version: 1, rid: 'ABCD1234', status: 'ready', has_hits: true });
  const second = io();
  const resultsClient = { blastResults: async ({ rid }) => ({ BlastOutput2: [{ report: { results: { search: { query_id: rid } } } }] }) };
  assert.equal(await main(['blast-results', '--rid', 'ABCD1234'], second, { client: resultsClient }), 0);
  assert.equal(JSON.parse(second.data.stdout).report.BlastOutput2[0].report.results.search.query_id, 'ABCD1234');
});

test('blast rejects a mismatched sequence type with a clean usage failure', async () => {
  const stream = io();
  assert.equal(await main(['blast', '--sequence', 'MKWVTF', '--program', 'blastn', '--email', 'researcher@example.org'], stream), 2);
  assert.equal(stream.data.stdout, '');
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'invalid-input');
});
