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

test('g:Profiler request and result are normalized', async () => {
  const calls = [];
  const client = createClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ meta: { query_metadata: { queries: { query_1: {} } } }, result: [{ source: 'GO:BP', native: 'GO:0006915', name: 'apoptotic process', p_value: 0.01, term_size: 100, query_size: 2, intersection_size: 2, intersections: ['TP53', 'BAX'] }] }), { status: 200 });
  } });
  const stream = io();
  assert.equal(await main(['enrich', '--genes', 'TP53,BAX,TP53', '--sources', 'GO:BP,REAC', '--background', 'TP53 BAX MDM2'], stream, { client }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.deepEqual(result.query.genes, ['TP53', 'BAX']);
  assert.deepEqual(result.parameters.sources, ['GO:BP', 'REAC']);
  assert.equal(result.results[0].term_id, 'GO:0006915');
  assert.equal(result.results[0].p_value, null);
  assert.equal(result.results[0].adjusted_p_value, 0.01);
  assert.deepEqual(JSON.parse(calls[0].options.body), { organism: 'hsapiens', query: ['TP53', 'BAX'], sources: ['GO:BP', 'REAC'], user_threshold: 0.05, significance_threshold_method: 'g_SCS', domain_scope: 'custom_annotated', no_evidences: false, combined: false, custom_bg: ['TP53', 'BAX', 'MDM2'] });
});

test('Enrichr submits a list then normalizes a selected library', async () => {
  const calls = [];
  const client = createClient({ fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/datasetStatistics')) return new Response(JSON.stringify({ statistics: [{ libraryName: 'GO_Biological_Process_2023', libraryDescription: 'GO', numTerms: 100, categoryId: 7 }] }), { status: 200 });
    if (String(url).endsWith('/addList')) return new Response(JSON.stringify({ userListId: 42, shortId: 'abc' }), { status: 200 });
    return new Response(JSON.stringify({ GO_Biological_Process_2023: [['apoptosis', 0.001, -2, 50, ['TP53', 'BAX'], 0.02]] }), { status: 200 });
  } });
  const stream = io();
  assert.equal(await main(['enrich', '--provider', 'enrichr', '--genes', 'TP53 BAX', '--library', 'GO_Biological_Process_2023'], stream, { client }), 0);
  const result = JSON.parse(stream.data.stdout);
  assert.equal(result.provider_meta.user_list_id, 42);
  assert.deepEqual(result.results[0].intersections, ['TP53', 'BAX']);
  assert.equal(await calls[1].options.body.get('list'), 'TP53\nBAX');
  assert.match(calls[2].url, /backgroundType=GO_Biological_Process_2023/);
});

test('dry-run validates without calling a provider', async () => {
  const stream = io();
  const client = { gprofiler: async () => assert.fail('must not run'), enrichr: async () => assert.fail('must not run') };
  assert.equal(await main(['enrich', '--genes', 'TP53', '--dry-run'], stream, { client }), 0);
  assert.equal(JSON.parse(stream.data.stdout).planned, true);
});

test('Enrichr requires a library and rejects g:Profiler-only settings', async () => {
  const stream = io();
  assert.equal(await main(['enrich', '--provider', 'enrichr', '--genes', 'TP53'], stream), 2);
  assert.equal(JSON.parse(stream.data.stderr).error.code, 'missing-input');
  const second = io();
  assert.equal(await main(['enrich', '--provider', 'enrichr', '--genes', 'TP53', '--library', 'GO', '--background', 'TP53'], second), 2);
  assert.equal(JSON.parse(second.data.stderr).error.code, 'invalid-input');
});

test('libraries returns Enrichr library metadata', async () => {
  const stream = io();
  const client = { enrichrLibraries: async () => [{ name: 'GO_Biological_Process_2023', description: 'GO', gene_count: 123, category_id: 7 }] };
  assert.equal(await main(['libraries'], stream, { client }), 0);
  assert.deepEqual(JSON.parse(stream.data.stdout).items[0].name, 'GO_Biological_Process_2023');
});
