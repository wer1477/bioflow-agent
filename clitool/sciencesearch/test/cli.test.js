import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, description } from '../src/cli.js';
import { createHttp } from '../src/http.js';
import { ConnectorRegistry } from '../src/registry.js';
import { CliError, fetchMany, search } from '../src/science.js';

function io() {
  const data = { stdout: '', stderr: '' };
  return { data, stdout: { write: (value) => { data.stdout += value; } }, stderr: { write: (value) => { data.stderr += value; } } };
}

test('describe is a parseable command registry', async () => {
  const stream = io();
  assert.equal(await main(['--describe', '--format', 'json'], stream), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout), description);
  assert.equal(stream.data.stderr, '');
});

test('describe exposes output schemas and connector-specific discovery metadata', async () => {
  assert.equal(description.schemas.SearchPage.properties.issues.type, 'array');
  const semanticScholar = description.connectors.find((connector) => connector.id === 'semantic_scholar');
  assert.equal(semanticScholar.auth, 'optional_api_key');
  assert.deepEqual(semanticScholar.parameters.map((parameter) => parameter.name), ['apiKey']);
});

test('databases returns a stable paged JSON contract', async () => {
  const stream = io();
  assert.equal(await main(['databases', '--domain', 'literature', '--limit', '2', '--format', 'json'], stream), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.schema_version, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.next_cursor, '2');
  assert.equal(stream.data.stderr, '');
});

test('catalog exposes every implemented connector', async () => {
  const stream = io();
  assert.equal(await main(['databases', '--limit', '100', '--format', 'json'], stream), 0);
  const ids = JSON.parse(stream.data.stdout).items.map((entry) => entry.id);
  assert.deepEqual(ids, ['pubmed', 'europepmc', 'biorxiv', 'uniprot', 'ncbi_gene', 'ensembl', 'reactome', 'kegg', 'rcsb_pdb', 'interpro', 'string', 'geo', 'openalex', 'semantic_scholar', 'crossref', 'arxiv', 'clinvar', 'opentargets', 'chembl', 'alphafold', 'cellxgene', 'dbsnp', 'gnomad', 'gtex', 'jaspar']);
});

test('describe exposes the added variant, expression, and motif connectors', async () => {
  const expected = {
    dbsnp: { domain: 'genomics', pagination: 'offset', formats: ['json', 'xml'], parameters: [], auth: 'none', recordId: /rsID/i },
    gnomad: { domain: 'genomics', pagination: 'bounded', formats: ['json'], parameters: ['dataset'], auth: 'none', recordId: /variant id/i },
    gtex: { domain: 'omics', pagination: 'page', formats: ['json'], parameters: ['gencodeVersion'], auth: 'none', recordId: /GENCODE id/i },
    jaspar: { domain: 'biology', pagination: 'page', formats: ['json', 'jaspar', 'pfm'], parameters: ['collection', 'tax_group'], auth: 'none', recordId: /matrix id/i },
  };
  for (const [id, contract] of Object.entries(expected)) {
    const connector = description.connectors.find((entry) => entry.id === id);
    assert.ok(connector, `${id} should be described`);
    assert.equal(connector.domain, contract.domain);
    assert.equal(connector.pagination, contract.pagination);
    assert.deepEqual(connector.download_formats, contract.formats);
    assert.deepEqual(connector.parameters.map((parameter) => parameter.name), contract.parameters);
    assert.equal(connector.auth, contract.auth);
    assert.match(connector.record_id, contract.recordId);
  }
});

test('usage errors are structured JSON on stderr and leave stdout clean', async () => {
  const stream = io();
  assert.equal(await main(['fetch', '--source', 'pubmed'], stream), 2);
  assert.equal(stream.data.stdout, '');
  const error = JSON.parse(stream.data.stderr);
  assert.equal(error.error.code, 'missing-scope');
  assert.match(error.error.message, /exactly one of --id or --ids/);
  assert.equal(error.error.retryable, false);
});

test('fetch validates that exactly one record-id selector is supplied', async () => {
  const stream = io();
  assert.equal(await main(['fetch', '--source', 'pubmed', '--id', '1', '--ids', '2'], stream), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'missing-scope');
});

test('batch fetch preserves order and turns missing fields and failures into structured states', async () => {
  const result = await fetchMany('pubmed', ['one', 'missing', 'bad', 'one'], {
    fields: ['title', 'abstract'],
    fetch: async (_source, id) => {
      if (id === 'missing') return null;
      if (id === 'gone') throw new CliError('not-found', 'HTTP 404');
      if (id === 'bad') throw new Error('temporary outage');
      return { title: 'A paper' };
    },
  });
  const missingByError = await fetchMany('pubmed', ['gone'], { fields: ['title'], fetch: async () => { throw new CliError('not-found', 'HTTP 404'); } });
  assert.deepEqual(result.items, [
    { id: 'one', status: 'ok', record: { title: 'A paper', abstract: null }, field_status: { title: 'available', abstract: 'unavailable' } },
    { id: 'missing', status: 'not_found', record: null, field_status: { title: 'unavailable', abstract: 'unavailable' } },
    { id: 'bad', status: 'error', record: null, field_status: { title: 'unavailable', abstract: 'unavailable' } },
    { id: 'one', status: 'ok', record: { title: 'A paper', abstract: null }, field_status: { title: 'available', abstract: 'unavailable' } },
  ]);
  assert.deepEqual(result.issues, [{ source: 'pubmed', id: 'bad', code: 'internal', message: 'temporary outage', retryable: true }]);
  assert.deepEqual(missingByError, { schema_version: 1, source: 'pubmed', items: [{ id: 'gone', status: 'not_found', record: null, field_status: { title: 'unavailable' } }], issues: [] });
});

test('search requires an explicit source, domain, or all scope', async () => {
  const stream = io();
  assert.equal(await main(['search', '--query', 'TP53'], stream), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'missing-scope');
});

test('download dry-run has no network or filesystem side effects', async () => {
  const stream = io();
  assert.equal(await main(['download', '--source', 'uniprot', '--id', 'P04637', '--output', 'TP53.fasta', '--dry-run'], stream), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.planned, true);
  assert.equal(result.output.endsWith('/TP53.fasta'), true);
  assert.equal(stream.data.stderr, '');
});

test('download dry-run validates the requested connector and artifact format', async () => {
  const stream = io();
  assert.equal(await main(['download', '--source', 'uniprot', '--id', 'P04637', '--format', 'cif', '--output', 'TP53.cif', '--dry-run'], stream), 2);
  assert.equal(stream.data.stdout, '');
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'unsupported-format');
});

test('added connectors are discoverable through their domains', async () => {
  const domainItems = async (domain) => {
    const stream = io();
    assert.equal(await main(['databases', '--domain', domain, '--limit', '100', '--format', 'json'], stream), 0);
    return JSON.parse(stream.data.stdout).items.map((entry) => entry.id);
  };
  const genomics = await domainItems('genomics');
  assert.ok(genomics.includes('dbsnp'));
  assert.ok(genomics.includes('gnomad'));
  assert.ok((await domainItems('omics')).includes('gtex'));
  assert.ok((await domainItems('biology')).includes('jaspar'));
});

test('added connectors plan supported artifacts without network access', async () => {
  const plans = [
    { source: 'dbsnp', id: 'rs7412', format: 'xml', file: 'rs7412.dbsnp.xml' },
    { source: 'dbsnp', id: 'rs7412', format: 'json', file: 'rs7412.dbsnp.json' },
    { source: 'gnomad', id: '17-43057062-T-TG', format: 'json', file: '17-43057062-T-TG.gnomad.json' },
    { source: 'gtex', id: 'ENSG00000141510', format: 'json', file: 'ENSG00000141510.gtex.json' },
    { source: 'jaspar', id: 'MA0106.1', format: 'json', file: 'MA0106.1.jaspar.json' },
    { source: 'jaspar', id: 'MA0106.1', format: 'pfm', file: 'MA0106.1.pfm' },
    { source: 'jaspar', id: 'MA0106.1', format: 'jaspar', file: 'MA0106.1.jaspar' },
  ];
  for (const plan of plans) {
    const stream = io();
    assert.equal(await main(['download', '--source', plan.source, '--id', plan.id, '--format', plan.format, '--output', plan.file, '--dry-run'], stream), 0, `${plan.source} ${plan.format}`);
    assert.equal(JSON.parse(stream.data.stdout).planned, true);
    assert.equal(stream.data.stderr, '');
  }
  for (const [source, format] of [['gnomad', 'fasta'], ['gtex', 'tsv'], ['dbsnp', 'vcf'], ['jaspar', 'bed']]) {
    const stream = io();
    assert.equal(await main(['download', '--source', source, '--id', 'x', '--format', format, '--output', 'artifact.out', '--dry-run'], stream), 2, `${source} ${format}`);
    assert.equal(JSON.parse(stream.data.stderr).error.code, 'unsupported-format');
  }
});

test('added connectors reject unusable inputs before contacting an upstream API', async () => {
  const streams = [
    ['search', '--query', 'TP53', '--source', 'gnomad', '--param', 'dataset=hg19', '--format', 'json'],
    ['fetch', '--source', 'gnomad', '--id', 'not-a-variant', '--format', 'json'],
    ['fetch', '--source', 'dbsnp', '--id', 'not-an-rsid', '--format', 'json'],
  ];
  const expected = [
    { exit: 1, code: 'upstream', message: /dataset/ },
    { exit: 1, code: 'invalid-input', message: /variant id/ },
    { exit: 1, code: 'invalid-input', message: /rsID/ },
  ];
  for (const [index, argv] of streams.entries()) {
    const stream = io();
    assert.equal(await main(argv, stream), expected[index].exit, argv.join(' '));
    assert.equal(stream.data.stdout, '');
    const error = JSON.parse(stream.data.stderr).error;
    assert.equal(error.code, expected[index].code);
    assert.match(error.message, expected[index].message);
  }
});

test('composite cursor preserves probe records and buffered records from every source', async () => {
  const registry = new ConnectorRegistry();
  for (const source of ['left', 'right']) {
    registry.register({
      id: source, name: source, domain: 'literature', downloadFormats: ['json'], pagination: 'offset',
      search: async (query, { cursor }) => {
        const ids = cursor ? [3] : [1, 2];
        return {
          items: ids.map((id) => ({ id: `${source}-${id}`, title: `${source}-${id}`, summary: '', url: `https://example.test/${source}/${id}`, extra: { source } })),
          nextCursor: cursor ? null : '2',
        };
      },
    });
  }
  const first = await search({ query: 'TP53', sources: ['left', 'right'], limit: 2, registry });
  const second = await search({ query: 'TP53', sources: ['left', 'right'], limit: 2, cursor: first.next_cursor, registry });
  const third = await search({ query: 'TP53', sources: ['left', 'right'], limit: 2, cursor: second.next_cursor, registry });
  assert.deepEqual([first, second, third].flatMap((page) => page.items.map((item) => item.id)), ['left-1', 'right-1', 'left-2', 'right-2', 'left-3', 'right-3']);
  assert.equal(third.next_cursor, null);
});

test('shared HTTP retries transient failures and caches successful GET responses', async () => {
  let calls = 0;
  const waits = [];
  const client = createHttp({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('busy', { status: 429, headers: { 'Retry-After': '0' } })
        : new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    sleep: async (ms) => { waits.push(ms); },
    cacheDir: null,
    defaultRateLimit: false,
  });
  assert.deepEqual(await client.json('https://example.test/record'), { ok: true });
  assert.deepEqual(await client.json('https://example.test/record'), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

test('shared HTTP cache survives a new CLI client instance', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'science-search-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{"cached":true}', { status: 200 });
  };
  assert.deepEqual(await createHttp({ fetchImpl, cacheDir, defaultRateLimit: false }).json('https://example.test/cache'), { cached: true });
  assert.deepEqual(await createHttp({ fetchImpl, cacheDir, defaultRateLimit: false }).json('https://example.test/cache'), { cached: true });
  assert.equal(calls, 1);
});
