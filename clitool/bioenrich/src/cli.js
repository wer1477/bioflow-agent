import fs from 'node:fs/promises';
import { createClient, UpstreamError } from './client.js';

const VERSION = '0.1.0';
const PROVIDERS = ['gprofiler', 'enrichr'];

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-enrich',
  version: VERSION,
  default_format: 'json',
  exit_codes: { '0': 'success', '1': 'upstream or system failure', '2': 'usage or input error' },
  commands: {
    enrich: {
      description: 'Run over-representation analysis for a gene list through g:Profiler or Enrichr.',
      options: {
        provider: { type: 'string', enum: PROVIDERS, default: 'gprofiler' },
        genes: { type: 'string', conflicts_with: ['input'], description: 'Comma, whitespace, or newline-separated gene identifiers.' },
        input: { type: 'path', conflicts_with: ['genes'], description: 'Text file containing comma, whitespace, or newline-separated identifiers.' },
        organism: { type: 'string', default: 'hsapiens', description: 'g:Profiler organism identifier.' },
        sources: { type: 'string[]', description: 'Optional comma-separated g:Profiler source ids, for example GO:BP,REAC.' },
        background: { type: 'string', description: 'Optional comma, whitespace, or newline-separated g:Profiler custom background.' },
        'user-threshold': { type: 'number', default: 0.05, min_exclusive: 0, max: 1 },
        library: { type: 'string', description: 'Required Enrichr library name; discover names with libraries.' },
        'dry-run': { type: 'boolean', default: false, description: 'Validate inputs and print the request plan without contacting a provider.' },
      },
      output: 'EnrichmentResult',
    },
    libraries: { description: 'List the live Enrichr gene-set libraries.', options: {}, output: 'LibraryPage' },
  },
  schemas: {
    EnrichmentResult: { type: 'object', required: ['schema_version', 'planned', 'provider', 'query', 'parameters', 'results'], properties: { schema_version: { const: 1 }, planned: { type: 'boolean' }, provider: { type: 'string', enum: PROVIDERS }, query: { type: 'object' }, parameters: { type: 'object' }, provider_meta: { type: 'object' }, results: { type: 'array', items: { $ref: '#/schemas/EnrichmentTerm' } } } },
    EnrichmentTerm: { type: 'object', required: ['source', 'term_id', 'term_name', 'p_value', 'adjusted_p_value', 'term_size', 'query_size', 'intersection_size', 'intersections'], properties: { source: { type: ['string', 'null'] }, term_id: { type: ['string', 'null'] }, term_name: { type: ['string', 'null'] }, p_value: { type: ['number', 'null'] }, adjusted_p_value: { type: ['number', 'null'] }, term_size: { type: ['integer', 'null'] }, query_size: { type: ['integer', 'null'] }, intersection_size: { type: ['integer', 'null'] }, intersections: { type: 'array', items: { type: 'string' } }, z_score: { type: ['number', 'null'] }, combined_score: { type: ['number', 'null'] } } },
    LibraryPage: { type: 'object', required: ['schema_version', 'provider', 'items'], properties: { schema_version: { const: 1 }, provider: { const: 'enrichr' }, items: { type: 'array', items: { type: 'object' } } } },
    Error: { type: 'object', required: ['schema_version', 'error'], properties: { schema_version: { const: 1 }, error: { type: 'object', required: ['code', 'message', 'hint'], properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } } } } },
  },
};

function usage(command) {
  if (!command) return 'Usage: bio-enrich <command> [options]\n\n  enrich      Run gene-list enrichment through g:Profiler or Enrichr.\n  libraries   List live Enrichr gene-set libraries.\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the CLI version\n  -h, --help                 Print help';
  if (command === 'enrich') return 'Usage: bio-enrich enrich (--genes LIST | --input PATH) [--provider gprofiler|enrichr] [--organism hsapiens] [--sources GO:BP,REAC] [--background LIST] [--user-threshold 0.05] [--library NAME] [--dry-run] [--format json]\n\nUse --library with --provider enrichr; find names with bio-enrich libraries.';
  return 'Usage: bio-enrich libraries [--format json]';
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
    if (['help', 'describe', 'version', 'dry-run'].includes(key)) {
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

function list(value) {
  return [...new Set(String(value || '').split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

async function genes(values) {
  if (Boolean(values.genes) === Boolean(values.input)) throw new CliError('missing-input', 'Provide exactly one of --genes or --input.');
  let content = values.genes;
  if (values.input) {
    try {
      content = await fs.readFile(values.input, 'utf8');
    } catch (error) {
      throw new CliError('invalid-input', `Cannot read --input ${values.input}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const result = list(content);
  if (!result.length) throw new CliError('invalid-input', 'The gene list is empty.');
  if (result.length > 20_000) throw new CliError('invalid-input', 'The gene list exceeds the 20,000 identifier safety limit.');
  return result;
}

function number(values, key, fallback) {
  const value = values[key] === undefined ? fallback : Number(values[key]);
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new CliError('invalid-input', `--${key} must be a number greater than 0 and at most 1.`);
  return value;
}

function plan(values, geneList) {
  const provider = values.provider || 'gprofiler';
  if (!PROVIDERS.includes(provider)) throw new CliError('invalid-input', `--provider must be one of ${PROVIDERS.join(', ')}.`);
  const parameters = provider === 'gprofiler'
    ? { organism: values.organism || 'hsapiens', sources: list(values.sources), background_size: list(values.background).length || null, user_threshold: number(values, 'user-threshold', 0.05) }
    : { library: values.library || null };
  if (provider === 'enrichr' && !values.library) throw new CliError('missing-input', '--library is required when --provider enrichr. Run bio-enrich libraries first.');
  if (provider === 'enrichr' && (values.organism || values.sources || values.background || values['user-threshold'])) throw new CliError('invalid-input', '--organism, --sources, --background, and --user-threshold are supported only by gprofiler.');
  return { provider, query: { gene_count: geneList.length, genes: geneList }, parameters };
}

export async function main(argv, io = process, { client = createClient() } = {}) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { allowed(values, ['describe', 'format']); validateFormat(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-enrich --help'.`);
    if (command === 'libraries') {
      allowed(values, ['format']); validateFormat(values);
      io.stdout.write(`${JSON.stringify({ schema_version: 1, provider: 'enrichr', items: await client.enrichrLibraries() })}\n`);
      return 0;
    }
    allowed(values, ['provider', 'genes', 'input', 'organism', 'sources', 'background', 'user-threshold', 'library', 'dry-run', 'format']); validateFormat(values);
    const geneList = await genes(values);
    const request = plan(values, geneList);
    if (values['dry-run']) {
      io.stdout.write(`${JSON.stringify({ schema_version: 1, planned: true, ...request, results: [] })}\n`);
      return 0;
    }
    const output = request.provider === 'gprofiler'
      ? await client.gprofiler({ genes: geneList, organism: request.parameters.organism, sources: request.parameters.sources, userThreshold: request.parameters.user_threshold, background: list(values.background) })
      : await client.enrichr({ genes: geneList, library: request.parameters.library });
    io.stdout.write(`${JSON.stringify({ schema_version: 1, planned: false, ...request, provider_meta: output.meta, results: output.results })}\n`);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('upstream', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: "run 'bio-enrich --help'" } })}\n`);
    return cliError.exitCode;
  }
}

function validateFormat(values) {
  if (values.format && values.format !== 'json') throw new CliError('invalid-input', '--format must be json.');
}

export { UpstreamError };
