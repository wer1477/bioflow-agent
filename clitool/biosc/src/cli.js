import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(MODULE_DIR, 'engine.py');
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');

export class CliError extends Error {
  constructor(code, message, exitCode = 2, hint = "run 'bio-sc --help'") {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-sc',
  version: VERSION,
  default_format: 'json',
  exit_codes: { 0: 'success', 1: 'analysis or dependency failure', 2: 'usage or input error' },
  commands: {
    check: {
      description: 'Report the Python interpreter and the Scanpy stack this CLI will use.',
      options: { format: { type: 'string', enum: ['json'], default: 'json' } },
      output: 'CheckResult',
    },
    run: {
      description: 'Run QC, normalization, clustering, UMAP, marker DE, and optional pseudobulk DE on a single-cell matrix.',
      options: {
        input: { type: 'path', required: true, description: 'AnnData .h5ad file or a 10x matrix directory.' },
        output: { type: 'path', required: true, description: 'Directory for the h5ad, tables, figures, and manifest.' },
        'min-genes': { type: 'integer', default: 200, min: 0 },
        'max-pct-mt': { type: 'number', default: 20, min_exclusive: 0, max: 100 },
        'n-hvg': { type: 'integer', default: 2000, min: 1 },
        'n-pcs': { type: 'integer', default: 30, min: 2 },
        resolution: { type: 'number', default: 0.5, min_exclusive: 0 },
        'batch-key': { type: 'string', description: 'obs column for batch reporting; Harmony/scVI are out of scope.' },
        'sample-key': { type: 'string', description: 'obs column identifying biological samples (needed for pseudobulk).' },
        'group-key': { type: 'string', description: 'obs column with the condition to compare (needed for pseudobulk).' },
        seed: { type: 'integer', default: 0 },
        'dry-run': { type: 'boolean', default: false, description: 'Validate inputs and print the plan without running Scanpy.' },
        format: { type: 'string', enum: ['json'], default: 'json' },
      },
      output: 'RunResult',
    },
  },
  schemas: {
    CheckResult: {
      type: 'object',
      required: ['ok', 'python'],
      properties: {
        ok: { type: 'boolean' },
        python: { type: 'string' },
        missing: { type: 'array', items: { type: 'string' } },
        versions: { type: 'object' },
      },
    },
    RunResult: {
      type: 'object',
      required: ['ok', 'outputs', 'summary'],
      properties: {
        ok: { type: 'boolean' },
        outputs: { type: 'object' },
        summary: { type: 'object' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    Error: {
      type: 'object',
      required: ['schema_version', 'error'],
      properties: {
        schema_version: { const: 1 },
        error: {
          type: 'object',
          required: ['code', 'message', 'hint'],
          properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } },
        },
      },
    },
  },
};

function usage(command) {
  if (!command) {
    return [
      'Usage: bio-sc <command> [options]',
      '',
      '  check   Report the Python interpreter and the Scanpy stack.',
      '  run     QC -> normalize -> cluster -> UMAP -> marker DE (optional pseudobulk DE).',
      '',
      'Global options:',
      '  --describe --format json   Print the machine-readable command registry',
      '  --version                  Print the CLI version',
      '  -h, --help                 Print help',
    ].join('\n');
  }
  if (command === 'check') return 'Usage: bio-sc check [--format json]';
  if (command === 'run') {
    return [
      'Usage: bio-sc run --input <h5ad|10x-mtx-dir> --output <dir> [options]',
      '',
      '  --min-genes 200        Filter cells below this many detected genes',
      '  --max-pct-mt 20        Filter cells at or above this mitochondrial percentage',
      '  --n-hvg 2000           Highly variable genes',
      '  --n-pcs 30             Principal components',
      '  --resolution 0.5       Leiden resolution',
      '  --batch-key KEY        obs column with batch labels (reported, not corrected)',
      '  --sample-key KEY       obs column with biological sample ids (pseudobulk)',
      '  --group-key KEY        obs column with condition labels (pseudobulk)',
      '  --seed 0',
      '  --dry-run              Print the plan without running Scanpy',
    ].join('\n');
  }
  return `Usage: bio-sc ${command} [options]`;
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
  for (const key of Object.keys(values)) {
    if (key !== '_' && !keys.includes(key)) throw new CliError('unknown-option', `--${key} is not supported by this command.`);
  }
  if (values._.length) throw new CliError('unexpected-argument', `Unexpected argument: ${values._[0]}.`);
}

function validateFormat(values) {
  if (values.format && values.format !== 'json') throw new CliError('invalid-input', '--format must be json.');
}

function integer(values, key, fallback, min) {
  const value = values[key] === undefined ? fallback : Number(values[key]);
  if (!Number.isInteger(value) || value < min) throw new CliError('invalid-input', `--${key} must be an integer >= ${min}.`);
  return value;
}

function number(values, key, fallback, { min, minExclusive = false, max } = {}) {
  const value = values[key] === undefined ? fallback : Number(values[key]);
  if (!Number.isFinite(value)) throw new CliError('invalid-input', `--${key} must be a number.`);
  if (minExclusive ? value <= min : value < min) throw new CliError('invalid-input', `--${key} must be ${minExclusive ? '>' : '>='} ${min}.`);
  if (max !== undefined && value > max) throw new CliError('invalid-input', `--${key} must be <= ${max}.`);
  return value;
}

function text(values, key) {
  const value = String(values[key] ?? '').trim();
  return value || undefined;
}

/** Resolve the Python interpreter the runtime would use, without assuming PATH is set up. */
export function pythonCommand(env = process.env) {
  const candidates = [];
  if (env.BIOAGENT_ENV_BIN) candidates.push(path.join(env.BIOAGENT_ENV_BIN, 'python3'));
  candidates.push(path.join(REPO_ROOT, '.bioenv', 'bin', 'python'));
  candidates.push('python3');
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import sys'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function checkCommand() {
  const python = pythonCommand();
  if (!python) {
    throw new CliError('missing-python', 'No Python interpreter was found (.bioenv/bin/python or python3).', 1, 'source scripts/activate-bioenv.sh');
  }
  const script = [
    'import json, sys',
    "mods = ['scanpy','anndata','numpy','pandas','igraph','leidenalg','pydeseq2','matplotlib']",
    "out = {'python': sys.version.split()[0], 'versions': {}}",
    'missing = []',
    'for name in mods:',
    '    try:',
    '        module = __import__(name)',
    '        out["versions"][name] = str(getattr(module, "__version__", "unknown"))',
    '    except Exception:',
    '        missing.append(name)',
    "out['missing'] = missing",
    "out['ok'] = 'scanpy' not in missing and 'anndata' not in missing",
    'print(json.dumps(out))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw new CliError('python-failed', result.error.message, 1);
  const parsed = JSON.parse(result.stdout.trim() || '{}');
  parsed.python = `${python} (${parsed.python})`;
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ...parsed })}\n`);
  return parsed.ok ? 0 : 1;
}

function runCommand(values) {
  allowed(values, ['input', 'output', 'min-genes', 'max-pct-mt', 'n-hvg', 'n-pcs', 'resolution', 'batch-key', 'sample-key', 'group-key', 'seed', 'dry-run', 'format']);
  validateFormat(values);
  const input = path.resolve(String(values.input || ''));
  const output = path.resolve(String(values.output || ''));
  if (!values.input) throw new CliError('missing-input', '--input is required.');
  if (!values.output) throw new CliError('missing-input', '--output is required.');
  if (!fs.existsSync(input)) throw new CliError('missing-input', `--input does not exist: ${input}`);
  if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new CliError('invalid-input', `--output must be a directory: ${output}`);

  const parameters = {
    input,
    output,
    min_genes: integer(values, 'min-genes', 200, 0),
    max_pct_mt: number(values, 'max-pct-mt', 20, { min: 0, minExclusive: true, max: 100 }),
    n_hvg: integer(values, 'n-hvg', 2000, 1),
    n_pcs: integer(values, 'n-pcs', 30, 2),
    resolution: number(values, 'resolution', 0.5, { min: 0, minExclusive: true }),
    batch_key: text(values, 'batch-key') || null,
    sample_key: text(values, 'sample-key') || null,
    group_key: text(values, 'group-key') || null,
    seed: integer(values, 'seed', 0, 0),
  };
  if (Boolean(parameters.sample_key) !== Boolean(parameters.group_key)) {
    throw new CliError('invalid-input', '--sample-key and --group-key must be provided together for pseudobulk DE.');
  }
  if (parameters.n_hvg > 50000) throw new CliError('invalid-input', '--n-hvg must be <= 50000.');

  if (values['dry-run']) {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, planned: true, command: 'run', parameters })}\n`);
    return 0;
  }

  const result = runEngine(parameters);
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ...result })}\n`);
  return 0;
}

function runEngine(parameters) {
  const python = pythonCommand();
  if (!python) {
    throw new CliError('missing-python', 'No Python interpreter was found (.bioenv/bin/python or python3).', 1, 'source scripts/activate-bioenv.sh');
  }
  const configFile = path.join(os.tmpdir(), `bio-sc-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(configFile, JSON.stringify(parameters));
  try {
    const result = spawnSync(python, [ENGINE, '--config', configFile], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw new CliError('analysis-failed', result.error.message, 1);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      const detail = lastJsonLine(result.stdout) || result.stderr.trim().split('\n').slice(-1)[0] || `exit ${result.status}`;
      throw new CliError('analysis-failed', detail, 1, 'run `bio-sc check --format json` first');
    }
    const parsed = lastJsonLine(result.stdout);
    if (!parsed) throw new CliError('analysis-failed', 'the engine returned no JSON result', 1);
    return JSON.parse(parsed);
  } finally {
    fs.rmSync(configFile, { force: true });
  }
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export async function main(argv, io = process) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) {
      allowed(values, ['describe', 'format']);
      validateFormat(values);
      io.stdout.write(`${JSON.stringify(description)}\n`);
      return 0;
    }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-sc --help'.`);
    if (command === 'check') {
      allowed(values, ['format']);
      validateFormat(values);
      return checkCommand();
    }
    if (command === 'run') return runCommand(values);
    throw new CliError('unknown-command', `Unknown command: ${command}.`);
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('upstream', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: cliError.hint } })}\n`);
    return cliError.exitCode;
  }
}
