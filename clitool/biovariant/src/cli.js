import fs from 'node:fs/promises';
import { createClient } from './client.js';

const VERSION = '0.1.0';
const ASSEMBLIES = ['GRCh38', 'GRCh37'];
const MAX_VARIANTS = 200;

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-variant',
  version: VERSION,
  default_format: 'json',
  exit_codes: { '0': 'success', '1': 'upstream or system failure', '2': 'usage or input error' },
  commands: {
    annotate: {
      description: 'Annotate a small batch of human SNVs and short indels with Ensembl VEP consequences and co-located clinical significance.',
      options: {
        variant: { type: 'string', conflicts_with: ['input'], description: 'One coordinate variant as CHROM:POS:REF:ALT, for example 17:7674220:C:T.' },
        input: { type: 'path', conflicts_with: ['variant'], description: 'VCF file. Header lines are ignored and multi-allelic rows are expanded.' },
        assembly: { type: 'string', enum: ASSEMBLIES, default: 'GRCh38' },
        limit: { type: 'integer', default: 100, min: 1, max: MAX_VARIANTS, description: 'Maximum VCF alleles to annotate.' },
        'dry-run': { type: 'boolean', default: false, description: 'Validate input and print the Ensembl VEP request plan without network access.' },
      },
      output: 'VariantAnnotationResult',
    },
  },
  schemas: {
    VariantAnnotationResult: { type: 'object', required: ['schema_version', 'planned', 'query', 'annotations'], properties: { schema_version: { const: 1 }, planned: { type: 'boolean' }, query: { type: 'object' }, annotations: { type: 'array', items: { $ref: '#/schemas/VariantAnnotation' } } } },
    VariantAnnotation: { type: 'object', required: ['input', 'assembly', 'location', 'allele_string', 'most_severe_consequence', 'transcripts', 'clinical_evidence'], properties: { input: { type: ['string', 'null'] }, assembly: { type: 'string', enum: ASSEMBLIES }, location: { type: ['object', 'null'] }, allele_string: { type: ['string', 'null'] }, most_severe_consequence: { type: ['string', 'null'] }, transcripts: { type: 'array' }, clinical_evidence: { type: 'array' } } },
    Error: { type: 'object', required: ['schema_version', 'error'], properties: { schema_version: { const: 1 }, error: { type: 'object', required: ['code', 'message', 'hint'] } } },
  },
};

function usage(command) {
  if (!command) return 'Usage: bio-variant annotate (--variant CHROM:POS:REF:ALT | --input PATH) [--assembly GRCh38|GRCh37] [--limit 100] [--dry-run] [--format json]\n\nCommands:\n  annotate   Annotate small human variant batches through Ensembl VEP.\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the CLI version\n  -h, --help                 Print help';
  return 'Usage: bio-variant annotate (--variant CHROM:POS:REF:ALT | --input PATH) [--assembly GRCh38|GRCh37] [--limit 100] [--dry-run] [--format json]\n\n--input accepts VCF records. This first release supports SNVs and short sequence indels only; symbolic alleles and breakends are rejected.';
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

function validateFormat(values) {
  if (values.format && values.format !== 'json') throw new CliError('invalid-input', '--format must be json.');
}

function validateAllele(value, label) {
  if (!/^[ACGTN]+$/i.test(value)) throw new CliError('invalid-input', `${label} must contain only A, C, G, T, or N.`);
  return value.toUpperCase();
}

function variantFromParts(chromosome, position, reference, alternate, source) {
  const rawChromosome = chromosome.replace(/^chr/i, '').toUpperCase();
  const chrom = rawChromosome === 'M' ? 'MT' : rawChromosome;
  if (!/^(?:[1-9]|1[0-9]|2[0-2]|X|Y|MT)$/.test(chrom)) throw new CliError('invalid-input', `${source}: chromosome must be 1-22, X, Y, MT, M, or use a chr prefix.`);
  if (!/^\d+$/.test(String(position)) || Number(position) < 1) throw new CliError('invalid-input', `${source}: position must be a positive integer.`);
  const ref = validateAllele(reference, `${source}: reference allele`);
  const alt = validateAllele(alternate, `${source}: alternate allele`);
  if (ref === alt) throw new CliError('invalid-input', `${source}: reference and alternate alleles must differ.`);
  const pos = Number(position);
  return {
    input: `${chrom}:${pos}:${ref}:${alt}`,
    vepInput: `${chrom} ${pos} . ${ref} ${alt} . . .`,
  };
}

function parseVariant(value, source = '--variant') {
  const match = /^([^:]+):(\d+):([^:]+):([^:]+)$/.exec(value.trim());
  if (!match) throw new CliError('invalid-input', `${source} must use CHROM:POS:REF:ALT, for example 17:7674220:C:T.`);
  return variantFromParts(match[1], match[2], match[3], match[4], source);
}

function positiveInteger(value, key, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new CliError('invalid-input', `--${key} must be an integer from 1 to ${max}.`);
  return number;
}

async function vcfVariants(path, limit) {
  let content;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (error) {
    throw new CliError('invalid-input', `Cannot read --input ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const variants = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 5) throw new CliError('invalid-input', `VCF line ${index + 1} must contain at least 5 tab-separated columns.`);
    const [chrom, pos, , ref, alternatives] = fields;
    for (const alt of alternatives.split(',')) {
      variants.push(variantFromParts(chrom, pos, ref, alt, `VCF line ${index + 1}`));
      if (variants.length === limit) return variants;
    }
  }
  if (!variants.length) throw new CliError('invalid-input', 'The VCF contains no variant records.');
  return variants;
}

async function buildRequest(values) {
  if (Boolean(values.variant) === Boolean(values.input)) throw new CliError('missing-input', 'Provide exactly one of --variant or --input.');
  const assembly = values.assembly || 'GRCh38';
  if (!ASSEMBLIES.includes(assembly)) throw new CliError('invalid-input', `--assembly must be one of ${ASSEMBLIES.join(', ')}.`);
  const limit = positiveInteger(values.limit, 'limit', 100, MAX_VARIANTS);
  const variants = values.variant ? [parseVariant(values.variant)] : await vcfVariants(values.input, limit);
  return { assembly, limit, variants };
}

export async function main(argv, io = process, { client = createClient() } = {}) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { allowed(values, ['describe', 'format']); validateFormat(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-variant --help'.`);
    allowed(values, ['variant', 'input', 'assembly', 'limit', 'dry-run', 'format']);
    validateFormat(values);
    const request = await buildRequest(values);
    const query = { assembly: request.assembly, variant_count: request.variants.length, variants: request.variants.map(({ input }) => input) };
    if (values['dry-run']) {
      io.stdout.write(`${JSON.stringify({ schema_version: 1, planned: true, query, annotations: [] })}\n`);
      return 0;
    }
    const annotations = await client.annotate(request);
    io.stdout.write(`${JSON.stringify({ schema_version: 1, planned: false, query, annotations })}\n`);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('upstream', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: "run 'bio-variant --help'" } })}\n`);
    return cliError.exitCode;
  }
}
