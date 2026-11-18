import fs from 'node:fs/promises';
import path from 'node:path';
import { InferenceError, runInference } from './runner.js';

const VERSION = '0.1.0';
const METHODS = ['grnboost2', 'genie3'];
const MAX_GENES = 20_000;
const MAX_OBSERVATIONS = 1_000_000;

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-grn',
  version: VERSION,
  default_format: 'json',
  exit_codes: { '0': 'success', '1': 'inference or system failure', '2': 'usage or input error' },
  commands: {
    infer: {
      description: 'Infer candidate transcription-factor to target-gene associations from a tab-separated expression matrix using Arboreto GRNBoost2 or GENIE3. Results are not causal or direct-binding evidence.',
      options: {
        expression: { type: 'path', required: true, description: 'TSV matrix with one observation per row, a header row, and gene symbols as columns.' },
        tfs: { type: 'path', required: true, description: 'Text file with one candidate transcription-factor gene symbol per line.' },
        method: { type: 'string', enum: METHODS, default: 'grnboost2' },
        seed: { type: 'integer', default: 777, min: 0 },
        output: { type: 'path', required: true, description: 'New TSV edge-table path.' },
        'max-edges': { type: 'integer', default: 50000, min: 1, max: 1000000, description: 'Keep this many highest-importance candidate edges.' },
        force: { type: 'boolean', default: false, description: 'Allow replacing an existing output TSV and manifest.' },
        'dry-run': { type: 'boolean', default: false, description: 'Validate inputs and print the inference plan without running Python or writing files.' },
      },
      output: 'GrnInferenceResult',
    },
  },
  schemas: {
    GrnInferenceResult: {
      type: 'object', required: ['schema_version', 'planned', 'interpretation', 'method', 'seed', 'input', 'output'],
      properties: {
        schema_version: { const: 1 }, planned: { type: 'boolean' }, interpretation: { const: 'candidate_regulatory_associations_not_causal_or_direct_binding_evidence' },
        method: { type: 'string', enum: METHODS }, seed: { type: 'integer' }, input: { type: 'object' }, output: { type: 'object' },
      },
    },
    Error: { type: 'object', required: ['schema_version', 'error'], properties: { schema_version: { const: 1 }, error: { type: 'object', required: ['code', 'message', 'hint'] } } },
  },
};

function usage(command) {
  if (!command) return 'Usage: bio-grn infer --expression MATRIX.tsv --tfs TFs.txt --output NETWORK.tsv [--method grnboost2|genie3] [--seed 777] [--max-edges 50000] [--dry-run] [--format json]\n\nInfer candidate TF-to-target associations with Arboreto. Associations are not causal or direct-binding evidence.\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the CLI version\n  -h, --help                 Print help';
  return 'Usage: bio-grn infer --expression MATRIX.tsv --tfs TFs.txt --output NETWORK.tsv [--method grnboost2|genie3] [--seed 777] [--max-edges 50000] [--force] [--dry-run] [--format json]';
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
    if (['help', 'describe', 'version', 'dry-run', 'force'].includes(key)) {
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

function parsePositiveInteger(value, key, fallback, max, { allowZero = false } = {}) {
  const result = value === undefined ? fallback : Number(value);
  const lower = allowZero ? 0 : 1;
  if (!Number.isInteger(result) || result < lower || result > max) throw new CliError('invalid-input', `--${key} must be an integer from ${lower} to ${max}.`);
  return result;
}

function splitTsv(line) {
  return line.split('\t').map((value) => value.trim());
}

async function validateExpression(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new CliError('invalid-input', `Cannot read --expression ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 4) throw new CliError('invalid-input', '--expression must contain a header and at least three observations.');
  const genes = splitTsv(lines[0]);
  if (!genes.length || genes.some((gene) => !gene)) throw new CliError('invalid-input', '--expression header contains an empty gene name.');
  if (genes.length < 2 || genes.length > MAX_GENES) throw new CliError('invalid-input', `--expression must contain from 2 to ${MAX_GENES.toLocaleString()} gene columns.`);
  if (new Set(genes).size !== genes.length) throw new CliError('invalid-input', '--expression header contains duplicate gene names.');
  const observations = lines.length - 1;
  if (observations > MAX_OBSERVATIONS) throw new CliError('invalid-input', `--expression exceeds the ${MAX_OBSERVATIONS.toLocaleString()} observation safety limit.`);
  for (let index = 1; index < lines.length; index += 1) {
    const values = splitTsv(lines[index]);
    if (values.length !== genes.length) throw new CliError('invalid-input', `Expression row ${index + 1} has ${values.length} values; expected ${genes.length}.`);
    if (values.some((value) => !value || !Number.isFinite(Number(value)))) throw new CliError('invalid-input', `Expression row ${index + 1} contains a missing or non-numeric value.`);
  }
  return { gene_names: genes, observation_count: observations };
}

async function validateTfs(filePath, geneNames) {
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new CliError('invalid-input', `Cannot read --tfs ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const requested = [...new Set(content.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean))];
  if (!requested.length) throw new CliError('invalid-input', '--tfs is empty.');
  const genes = new Set(geneNames);
  const retained = requested.filter((tf) => genes.has(tf));
  if (!retained.length) throw new CliError('invalid-input', 'None of the requested TF names appears in the expression header.');
  return { requested_count: requested.length, retained };
}

async function outputPaths(output) {
  const resolved = path.resolve(output);
  if (path.extname(resolved).toLowerCase() !== '.tsv') throw new CliError('invalid-input', '--output must end in .tsv.');
  return { edge_table: resolved, manifest: `${resolved}.manifest.json` };
}

async function ensureOutputIsSafe(paths, force) {
  if (force) return;
  for (const value of Object.values(paths)) {
    try {
      await fs.access(value);
      throw new CliError('output-exists', `Refusing to replace existing output ${value}; provide --force after reviewing it.`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error?.code !== 'ENOENT') throw new CliError('invalid-input', `Cannot access output ${value}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function buildPlan(values, expression, tfs, paths) {
  const method = values.method || 'grnboost2';
  if (!METHODS.includes(method)) throw new CliError('invalid-input', `--method must be one of ${METHODS.join(', ')}.`);
  const seed = parsePositiveInteger(values.seed, 'seed', 777, 2_147_483_647, { allowZero: true });
  const maxEdges = parsePositiveInteger(values['max-edges'], 'max-edges', 50_000, 1_000_000);
  return {
    method,
    seed,
    max_edges: maxEdges,
    input: {
      expression_path: path.resolve(values.expression),
      tf_path: path.resolve(values.tfs),
      observation_count: expression.observation_count,
      gene_count: expression.gene_names.length,
      requested_tf_count: tfs.requested_count,
      retained_tf_count: tfs.retained.length,
    },
    output: paths,
    retained_tfs: tfs.retained,
  };
}

function publicResult(planned, plan, extra = {}) {
  return {
    schema_version: 1,
    planned,
    interpretation: 'candidate_regulatory_associations_not_causal_or_direct_binding_evidence',
    method: plan.method,
    seed: plan.seed,
    input: plan.input,
    output: plan.output,
    ...extra,
  };
}

export async function main(argv, io = process, { infer = runInference } = {}) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { allowed(values, ['describe', 'format']); validateFormat(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (command !== 'infer') throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-grn --help'.`);
    allowed(values, ['expression', 'tfs', 'method', 'seed', 'output', 'max-edges', 'force', 'dry-run', 'format']);
    validateFormat(values);
    for (const key of ['expression', 'tfs', 'output']) if (!values[key]) throw new CliError('missing-input', `--${key} is required.`);
    const expression = await validateExpression(values.expression);
    const tfs = await validateTfs(values.tfs, expression.gene_names);
    const paths = await outputPaths(values.output);
    const plan = buildPlan(values, expression, tfs, paths);
    if (values['dry-run']) {
      io.stdout.write(`${JSON.stringify(publicResult(true, plan))}\n`);
      return 0;
    }
    await ensureOutputIsSafe(paths, values.force);
    const inference = await infer({
      expression_path: plan.input.expression_path,
      tf_names: plan.retained_tfs,
      method: plan.method,
      seed: plan.seed,
      max_edges: plan.max_edges,
      output_path: plan.output.edge_table,
      manifest_path: plan.output.manifest,
    });
    io.stdout.write(`${JSON.stringify(publicResult(false, plan, { edge_count: inference.edge_count, retained_edge_count: inference.retained_edge_count, python: inference.python, arboreto: inference.arboreto }))}\n`);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : error instanceof InferenceError ? new CliError(error.code, error.message, 1) : new CliError('inference-failed', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: "run 'bio-grn --help'" } })}\n`);
    return cliError.exitCode;
  }
}
