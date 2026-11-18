import fs from 'node:fs/promises';
import path from 'node:path';
import { catalogPath, datasetId, loadCatalog, upsertDataset, writeJsonAtomic } from './catalog.js';
import { pathFromInputOrUrl, sha256 } from './io.js';
import { parseRegion, queryDataset, resolveGene } from './query.js';
import { SOURCE_IDS, SOURCES } from './sources.js';

const VERSION = '0.1.0';

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const description = {
  schema_version: 1, name: 'bio-regulatory', version: VERSION, default_format: 'json',
  exit_codes: { '0': 'success', '1': 'upstream or system failure', '2': 'usage or input error' },
  commands: {
    sources: { description: 'List supported regulatory-evidence source adapters and their preparation requirements.', options: {}, output: 'SourceList' },
    prepare: { description: 'Download or register one explicit versioned regulatory dataset, verify its SHA-256, and add it to a local catalog. Does not query data.', options: { source: { type: 'string', enum: SOURCE_IDS, required: true }, assembly: { type: 'string', required: true }, version: { type: 'string', required: true }, 'data-dir': { type: 'path', required: true }, url: { type: 'url' }, input: { type: 'path', conflicts_with: ['url'] }, 'checksum-sha256': { type: 'string' }, biosample: { type: 'string' }, assay: { type: 'string' }, epigenome: { type: 'string' }, force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } }, output: 'PreparedDataset' },
    query: { description: 'Query prepared datasets by one gene symbol or one genomic region and write evidence JSON plus an adjacent provenance manifest.', options: { gene: { type: 'string', conflicts_with: ['region'] }, region: { type: 'string', conflicts_with: ['gene'] }, assembly: { type: 'string', required: true }, 'data-dir': { type: 'path', required: true }, source: { type: 'string[]', enum: SOURCE_IDS }, biosample: { type: 'string' }, assays: { type: 'string[]' }, output: { type: 'path', required: true }, force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } }, output: 'EvidenceQueryResult' },
  },
  schemas: {
    SourceList: { type: 'object', required: ['schema_version', 'sources'] },
    PreparedDataset: { type: 'object', required: ['schema_version', 'planned', 'dataset', 'catalog_path'] },
    EvidenceQueryResult: { type: 'object', required: ['schema_version', 'planned', 'query', 'evidence_count', 'output'] },
    Error: { type: 'object', required: ['schema_version', 'error'] },
  },
};

function usage(command) {
  if (!command) return 'Usage: bio-regulatory <sources|prepare|query> [options]\n\n  sources   List supported evidence sources\n  prepare   Download/register a versioned source dataset\n  query     Query prepared evidence by gene or genomic region\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the CLI version\n  -h, --help                 Print help';
  if (command === 'sources') return 'Usage: bio-regulatory sources [--format json]';
  if (command === 'prepare') return 'Usage: bio-regulatory prepare --source SOURCE --assembly ASSEMBLY --version VERSION --data-dir DIR [--url URL | --input PATH] [--checksum-sha256 SHA256] [--biosample NAME] [--assay NAME] [--epigenome ID] [--dry-run] [--format json]';
  return 'Usage: bio-regulatory query (--gene SYMBOL | --region chr:start-end) --assembly ASSEMBLY --data-dir DIR --output EVIDENCE.json [--source LIST] [--biosample NAME] [--assays LIST] [--dry-run] [--format json]';
}

function parse(argv) {
  const command = argv[0]?.startsWith('-') ? undefined : argv[0];
  const raw = command ? argv.slice(1) : argv;
  const values = { _: [] };
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === '-h') { values.help = true; continue; }
    if (!token.startsWith('--')) { values._.push(token); continue; }
    const [key, inline] = token.slice(2).split('=', 2);
    if (['help', 'describe', 'dry-run', 'force'].includes(key) || (key === 'version' && !command)) {
      if (inline !== undefined) throw new CliError('invalid-input', `--${key} does not take a value.`);
      values[key] = true;
      continue;
    }
    const value = inline ?? raw[++index];
    if (!value || value.startsWith('--')) throw new CliError('missing-value', `--${key} requires a value.`);
    if (values[key] !== undefined) throw new CliError('duplicate-option', `--${key} may be provided only once.`);
    values[key] = value;
  }
  return { command, values };
}

function allowed(values, keys) {
  for (const key of Object.keys(values)) if (key !== '_' && !keys.includes(key)) throw new CliError('unknown-option', `--${key} is not supported by this command.`);
  if (values._.length) throw new CliError('unexpected-argument', `Unexpected argument: ${values._[0]}.`);
}

function validateFormat(values) {
  if (values.format && values.format !== 'json') throw new CliError('invalid-input', '--format must be json.');
}

function list(value) {
  return [...new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function requireValues(values, keys) {
  for (const key of keys) if (!values[key]) throw new CliError('missing-input', `--${key} is required.`);
}

function validAssembly(value) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new CliError('invalid-input', '--assembly must be a non-empty assembly identifier such as GRCh38.');
  return value;
}

function validDigest(value) {
  if (value && !/^[a-f0-9]{64}$/i.test(value)) throw new CliError('invalid-input', '--checksum-sha256 must be a 64-character hexadecimal digest.');
  return value?.toLowerCase() || null;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function sourceUrl(values, source, assembly) {
  if (values.input) return null;
  if (values.url) return values.url;
  return SOURCES[source].default_urls?.[assembly] || null;
}

function publicDataset(dataset) {
  const { file_path, ...rest } = dataset;
  return rest;
}

async function prepare(values, dependencies) {
  const source = values.source;
  if (!SOURCES[source]) throw new CliError('invalid-input', `--source must be one of ${SOURCE_IDS.join(', ')}.`);
  requireValues(values, ['source', 'assembly', 'version', 'data-dir']);
  const assembly = validAssembly(values.assembly);
  const url = sourceUrl(values, source, assembly);
  if (Boolean(values.input) === Boolean(url)) throw new CliError('missing-input', '--prepare requires exactly one of --input or --url; cpg-island supplies an official GRCh38 URL by default.');
  if (source === 'chromhmm' && !values.epigenome) throw new CliError('missing-input', '--epigenome is required for chromhmm.');
  if (source === 'encode-peak' && (!values.biosample || !values.assay)) throw new CliError('missing-input', '--biosample and --assay are required for encode-peak.');
  const id = datasetId({ source, assembly, version: values.version });
  const dataDir = path.resolve(values['data-dir']);
  const destinationDir = path.join(dataDir, 'sources', source, id);
  const catalog = await dependencies.loadCatalog(dataDir);
  const alreadyPrepared = catalog.datasets.some((item) => item.id === id);
  if (alreadyPrepared && !values.force) throw new CliError('output-exists', `Dataset ${id} already exists; provide --force after reviewing it.`);
  const plan = { id, source, assembly, version: values.version, url: url || null, input: values.input ? path.resolve(values.input) : null, data_dir: dataDir, catalog_path: catalogPath(dataDir), biosample: values.biosample || null, assay: values.assay || null, epigenome: values.epigenome || null };
  if (values['dry-run']) return { schema_version: 1, planned: true, dataset: plan, catalog_path: plan.catalog_path };
  const filePath = await dependencies.pathFromInputOrUrl({ input: values.input, url, destinationDir, fetchImpl: dependencies.fetchImpl });
  const digest = await dependencies.sha256(filePath);
  const expected = validDigest(values['checksum-sha256']);
  if (expected && digest !== expected) throw new CliError('checksum-mismatch', `SHA-256 mismatch for ${filePath}: expected ${expected}, received ${digest}.`, 1);
  const dataset = {
    schema_version: 1, id, source, evidence_type: SOURCES[source].evidence_type, assembly, version: values.version,
    origin_url: url || null, input_path: values.input ? path.resolve(values.input) : null,
    file_path: path.relative(dataDir, filePath), sha256: digest, prepared_at: new Date().toISOString(),
    biosample: values.biosample || null, assay: values.assay || null, epigenome: values.epigenome || null,
  };
  await dependencies.upsertDataset(dataDir, dataset, { force: values.force });
  return { schema_version: 1, planned: false, dataset: publicDataset(dataset), catalog_path: catalogPath(dataDir) };
}

async function query(values, dependencies) {
  requireValues(values, ['assembly', 'data-dir', 'output']);
  if (Boolean(values.gene) === Boolean(values.region)) throw new CliError('missing-input', 'Provide exactly one of --gene or --region.');
  const assembly = validAssembly(values.assembly);
  const dataDir = path.resolve(values['data-dir']);
  const output = path.resolve(values.output);
  if (path.extname(output).toLowerCase() !== '.json') throw new CliError('invalid-input', '--output must end in .json.');
  const manifest = `${output}.manifest.json`;
  if (!values.force && (await exists(output) || await exists(manifest))) throw new CliError('output-exists', `Refusing to replace ${output} or its manifest; provide --force after reviewing them.`);
  const catalog = await dependencies.loadCatalog(dataDir);
  const requestedSources = list(values.source);
  const requestedAssays = list(values.assays).map((item) => item.toLowerCase());
  if (requestedSources.some((source) => !SOURCES[source])) throw new CliError('invalid-input', `--source accepts only ${SOURCE_IDS.join(', ')}.`);
  const datasets = catalog.datasets.filter((dataset) => dataset.assembly === assembly)
    .filter((dataset) => !requestedSources.length || requestedSources.includes(dataset.source))
    .filter((dataset) => !values.biosample || dataset.biosample === values.biosample)
    .filter((dataset) => !requestedAssays.length || (dataset.assay && requestedAssays.includes(dataset.assay.toLowerCase())));
  if (!datasets.length) throw new CliError('no-compatible-dataset', `No prepared datasets match assembly ${assembly} and the selected filters.`);
  let region;
  let resolver = null;
  if (values.region) region = parseRegion(values.region);
  else {
    const resolved = await dependencies.resolveGene(values.gene, assembly, { fetchImpl: dependencies.fetchImpl });
    region = resolved.region;
    resolver = resolved.resolver;
  }
  const queryInfo = { gene: values.gene || null, region: region.display, assembly, resolver };
  if (values['dry-run']) return { schema_version: 1, planned: true, query: queryInfo, evidence_count: 0, output: { evidence: output, manifest } };
  const evidence = (await Promise.all(datasets.map((dataset) => dependencies.queryDataset(dataset, dataDir, region)))).flat();
  evidence.sort((left, right) => `${left.source}\u0000${left.region}\u0000${left.dataset_id}`.localeCompare(`${right.source}\u0000${right.region}\u0000${right.dataset_id}`));
  const result = { schema_version: 1, query: queryInfo, interpretation: 'overlap_evidence_not_proof_of_functional_regulation', evidence };
  const queryManifest = { schema_version: 1, tool: { name: 'bio-regulatory', version: VERSION }, query: queryInfo, catalog_path: catalogPath(dataDir), datasets: datasets.map((dataset) => ({ id: dataset.id, source: dataset.source, version: dataset.version, assembly: dataset.assembly, sha256: dataset.sha256, origin_url: dataset.origin_url, prepared_at: dataset.prepared_at })), output_sha256: null };
  await dependencies.writeJsonAtomic(output, result);
  queryManifest.output_sha256 = await dependencies.sha256(output);
  await dependencies.writeJsonAtomic(manifest, queryManifest);
  return { schema_version: 1, planned: false, query: queryInfo, evidence_count: evidence.length, output: { evidence: output, manifest } };
}

export async function main(argv, io = process, injected = {}) {
  const dependencies = {
    fetchImpl: injected.fetchImpl || fetch,
    loadCatalog: injected.loadCatalog || loadCatalog,
    upsertDataset: injected.upsertDataset || upsertDataset,
    pathFromInputOrUrl: injected.pathFromInputOrUrl || pathFromInputOrUrl,
    sha256: injected.sha256 || sha256,
    queryDataset: injected.queryDataset || queryDataset,
    resolveGene: injected.resolveGene || resolveGene,
    writeJsonAtomic: injected.writeJsonAtomic || writeJsonAtomic,
  };
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { allowed(values, ['describe', 'format']); validateFormat(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-regulatory --help'.`);
    if (command === 'sources') {
      allowed(values, ['format']); validateFormat(values);
      io.stdout.write(`${JSON.stringify({ schema_version: 1, sources: Object.entries(SOURCES).map(([id, source]) => ({ id, ...source })) })}\n`);
      return 0;
    }
    if (command === 'prepare') {
      allowed(values, ['source', 'assembly', 'version', 'data-dir', 'url', 'input', 'checksum-sha256', 'biosample', 'assay', 'epigenome', 'force', 'dry-run', 'format']); validateFormat(values);
      io.stdout.write(`${JSON.stringify(await prepare(values, dependencies))}\n`);
      return 0;
    }
    allowed(values, ['gene', 'region', 'assembly', 'data-dir', 'source', 'biosample', 'assays', 'output', 'force', 'dry-run', 'format']); validateFormat(values);
    io.stdout.write(`${JSON.stringify(await query(values, dependencies))}\n`);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('system', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: "run 'bio-regulatory --help'" } })}\n`);
    return cliError.exitCode;
  }
}
