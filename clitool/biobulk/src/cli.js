import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(MODULE_DIR, 'engine.py');
const R_ENGINE = path.join(MODULE_DIR, 'engine.R');
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');
const ENGINES = ['pydeseq2', 'deseq2-r'];

export class CliError extends Error {
  constructor(code, message, exitCode = 2, hint = "run 'bio-bulk --help'") {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-bulk',
  version: VERSION,
  default_format: 'json',
  exit_codes: { 0: 'success', 1: 'analysis or dependency failure', 2: 'usage or input error' },
  commands: {
    check: {
      description: 'Report the Python/R DESeq2 engine and its dependencies.',
      options: { format: { type: 'string', enum: ['json'], default: 'json' } },
      output: 'CheckResult',
    },
    run: {
      description: 'Run bulk RNA-seq differential expression with DESeq2 semantics.',
      options: {
        counts: { type: 'path', required: true, description: 'Genes x samples count matrix (TSV/CSV).' },
        samples: { type: 'path', required: true, description: 'Sample sheet with sample, condition, and covariates.' },
        design: { type: 'string', default: '~condition', description: 'DESeq2 design formula, e.g. "~batch+condition".' },
        contrast: { type: 'string', required: true, description: 'variable:target:reference, e.g. condition:treated:control.' },
        engine: { type: 'string', enum: ENGINES, default: 'pydeseq2' },
        'min-count': { type: 'integer', default: 10, min: 0, description: 'Keep genes with row sum >= this value.' },
        output: { type: 'path', required: true },
        'dry-run': { type: 'boolean', default: false },
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
        r: { type: 'object' },
      },
    },
    RunResult: {
      type: 'object',
      required: ['ok', 'outputs', 'summary'],
      properties: { ok: { type: 'boolean' }, outputs: { type: 'object' }, summary: { type: 'object' }, warnings: { type: 'array', items: { type: 'string' } } },
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
      'Usage: bio-bulk <command> [options]',
      '',
      '  check   Report the Python/R DESeq2 engine and dependencies.',
      '  run     Differential expression on a genes x samples count matrix.',
      '',
      'Global options:',
      '  --describe --format json   Print the machine-readable command registry',
      '  --version                  Print the CLI version',
      '  -h, --help                 Print help',
    ].join('\n');
  }
  if (command === 'check') return 'Usage: bio-bulk check [--format json]';
  if (command === 'run') {
    return [
      'Usage: bio-bulk run --counts <matrix> --samples <sheet> --contrast <v:t:r> --output <dir> [options]',
      '',
      '  --design "~batch+condition"   DESeq2 design formula (default "~condition")',
      '  --contrast condition:treated:control',
      '  --engine pydeseq2|deseq2-r',
      '  --min-count 10                 Filter genes with row sum below this value',
      '  --dry-run                      Validate inputs and print the plan',
    ].join('\n');
  }
  return `Usage: bio-bulk ${command} [options]`;
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

export function rscriptCommand(env = process.env) {
  const candidates = [];
  if (env.BIOAGENT_ENV_BIN) candidates.push(path.join(env.BIOAGENT_ENV_BIN, 'Rscript'));
  candidates.push(path.join(REPO_ROOT, '.bioenv', 'bin', 'Rscript'));
  candidates.push('Rscript');
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function rAvailable() {
  const rscript = rscriptCommand();
  if (!rscript) return false;
  const probe = spawnSync(rscript, ['--vanilla', '-e', 'suppressMessages(suppressWarnings(library(DESeq2))); cat("ok")'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0 && probe.stdout.includes('ok');
}

function checkCommand() {
  const python = pythonCommand();
  const report = { python: python ? `${python}` : null, versions: {}, missing: [], r: { available: rAvailable() } };
  if (python) {
    const script = [
      'import json, sys',
      "mods = ['pydeseq2','pandas','numpy','matplotlib','scipy']",
      "out = {'python': sys.version.split()[0], 'versions': {}, 'missing': []}",
      'for name in mods:',
      '    try:',
      '        module = __import__(name)',
      '        out["versions"][name] = str(getattr(module, "__version__", "unknown"))',
      '    except Exception:',
      '        out["missing"].append(name)',
      "out['ok'] = all(item not in out['missing'] for item in ['pydeseq2','pandas','numpy','matplotlib'])",
      'print(json.dumps(out))',
    ].join('\n');
    const probe = spawnSync(python, ['-c', script], { encoding: 'utf8' });
    if (probe.error) throw new CliError('python-failed', probe.error.message, 1);
    const parsed = JSON.parse(probe.stdout.trim() || '{}');
    report.python = `${python} (${parsed.python})`;
    report.versions = parsed.versions || {};
    report.missing = parsed.missing || [];
  } else {
    report.missing.push('python');
  }
  report.ok = (report.missing.length === 0) || report.r.available;
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ...report })}\n`);
  return report.ok ? 0 : 1;
}

function readSampleColumns(samplesPath) {
  const content = fs.readFileSync(samplesPath, 'utf8');
  const first = content.split(/\r?\n/, 1)[0] || '';
  return first.split(',').map((name) => name.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function runCommand(values) {
  allowed(values, ['counts', 'samples', 'design', 'contrast', 'engine', 'min-count', 'output', 'dry-run', 'format']);
  validateFormat(values);
  const counts = path.resolve(String(values.counts || ''));
  const samples = path.resolve(String(values.samples || ''));
  const output = path.resolve(String(values.output || ''));
  if (!values.counts) throw new CliError('missing-input', '--counts is required.');
  if (!values.samples) throw new CliError('missing-input', '--samples is required.');
  if (!values.contrast) throw new CliError('missing-input', '--contrast is required (variable:target:reference).');
  if (!values.output) throw new CliError('missing-input', '--output is required.');
  if (!fs.existsSync(counts)) throw new CliError('missing-input', `--counts does not exist: ${counts}`);
  if (!fs.existsSync(samples)) throw new CliError('missing-input', `--samples does not exist: ${samples}`);
  if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new CliError('invalid-input', `--output must be a directory: ${output}`);

  const design = String(values.design || '~condition').trim();
  if (!design.startsWith('~') || design.length < 2) throw new CliError('invalid-input', '--design must be a formula such as "~batch+condition".');
  const terms = design.slice(1).split('+').map((term) => term.trim()).filter(Boolean);
  if (!terms.length) throw new CliError('invalid-input', '--design has no terms.');
  if (terms.some((term) => term.includes('*') || term.includes(':'))) {
    throw new CliError('invalid-input', '--design interaction terms are not supported in this release; use main effects.');
  }

  const parts = String(values.contrast).split(':').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !part)) throw new CliError('invalid-input', '--contrast must be variable:target:reference.');
  const [variable, target, reference] = parts;
  if (!terms.includes(variable)) throw new CliError('invalid-input', `contrast variable '${variable}' is not a term in --design.`);

  const columns = readSampleColumns(samples);
  for (const name of ['sample', ...terms]) {
    if (!columns.includes(name)) throw new CliError('invalid-input', `samples sheet is missing column '${name}' (found: ${columns.join(', ') || 'none'}).`);
  }

  const engine = String(values.engine || 'pydeseq2');
  if (!ENGINES.includes(engine)) throw new CliError('invalid-input', `--engine must be one of ${ENGINES.join(', ')}.`);
  const parameters = {
    counts,
    samples,
    output,
    design,
    variable,
    target,
    reference,
    engine,
    min_count: integer(values, 'min-count', 10, 0),
  };

  if (values['dry-run']) {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, planned: true, command: 'run', parameters })}\n`);
    return 0;
  }
  const result = runEngine(parameters);
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ...result })}\n`);
  return 0;
}

function runEngine(parameters) {
  if (parameters.engine === 'deseq2-r') {
    const rscript = rscriptCommand();
    if (!rscript) throw new CliError('missing-r', 'Rscript was not found; install R + DESeq2 or use --engine pydeseq2.', 1);
    const r = spawnSync(rscript, ['--vanilla', R_ENGINE, ...engineArguments(parameters)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new CliError('missing-r', 'Rscript was not found; install R + DESeq2 or use --engine pydeseq2.', 1);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) throw new CliError('analysis-failed', lastLine(r.stderr) || `Rscript exited ${r.status}`, 1, 'run `bio-bulk check --format json`');
    return JSON.parse(lastJsonLine(r.stdout));
  }

  const python = pythonCommand();
  if (!python) throw new CliError('missing-python', 'No Python interpreter was found (.bioenv/bin/python or python3).', 1, 'source scripts/activate-bioenv.sh');
  const configFile = path.join(os.tmpdir(), `bio-bulk-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(configFile, JSON.stringify(parameters));
  try {
    const result = spawnSync(python, [ENGINE, '--config', configFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw new CliError('analysis-failed', result.error.message, 1);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new CliError('analysis-failed', lastJsonLine(result.stdout) || lastLine(result.stderr), 1, 'run `bio-bulk check --format json`');
    const parsed = lastJsonLine(result.stdout);
    if (!parsed) throw new CliError('analysis-failed', 'the engine returned no JSON result', 1);
    return JSON.parse(parsed);
  } finally {
    fs.rmSync(configFile, { force: true });
  }
}

function engineArguments(parameters) {
  return [
    parameters.counts,
    parameters.samples,
    parameters.output,
    parameters.design,
    `${parameters.variable}:${parameters.target}:${parameters.reference}`,
    String(parameters.min_count),
  ];
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function lastLine(text) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
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
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-bulk --help'.`);
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
