import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const ENGINE_PATH = fileURLToPath(new URL('./engine.py', import.meta.url));
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENGINE_TIMEOUT_MS = 300_000;
const ENGINE_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TITLE = 'Analysis Report';
const DEFAULT_OUTPUT = 'report.md';
const BOOLEAN_FLAGS = new Set(['help', 'describe', 'version', 'dry-run']);
const HELP_HINT = "run 'bio-report --help'";

export class CliError extends Error {
  constructor(code, message, exitCode = 2, hint = null) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

const BUILD_OPTIONS = {
  manifest: { type: 'path[]', description: 'Manifest JSON produced by a tool run; repeatable. Missing fields are reported as warnings.' },
  'results-dir': { type: 'path[]', description: 'Directory scanned recursively for .csv and .tsv tables; repeatable.' },
  'figures-dir': { type: 'path[]', description: 'Directory scanned recursively for .png, .pdf and .svg figures; repeatable.' },
  methods: { type: 'path', description: 'Markdown file whose text becomes the Methods section.' },
  title: { type: 'string', default: DEFAULT_TITLE, description: 'Report title.' },
  output: { type: 'path', default: DEFAULT_OUTPUT, description: 'Markdown output path; resolved against the current directory.' },
  pdf: { type: 'path', description: 'Optional PDF output rendered with matplotlib (no pandoc or LaTeX).' },
  'dry-run': { type: 'boolean', default: false, description: 'Print the planned reads, writes and actions without touching the filesystem.' },
  format: { type: 'string', enum: ['json'], default: 'json', description: 'Output format.' },
};

const CHECK_OPTIONS = {
  format: { type: 'string', enum: ['json'], default: 'json', description: 'Output format.' },
};

export const description = {
  schema_version: 1,
  name: 'bio-report',
  version: VERSION,
  default_format: 'json',
  exit_codes: {
    '0': 'success',
    '1': 'runtime failure: the Python engine is unavailable, matplotlib cannot render the PDF, or the report could not be written',
    '2': 'usage or input error',
  },
  commands: {
    build: {
      description: 'Assemble a reproducible Markdown report, and optionally a matplotlib PDF, from manifests, result tables, figures and a methods file.',
      required_any: ['manifest', 'results-dir', 'figures-dir', 'methods'],
      options: BUILD_OPTIONS,
      output: 'BuildResult',
    },
    check: {
      description: 'Report the resolved Python interpreter and whether matplotlib is importable for PDF output.',
      options: CHECK_OPTIONS,
      output: 'CheckResult',
    },
  },
  schemas: {
    BuildResult: {
      type: 'object',
      required: ['schema_version', 'ok', 'outputs', 'counts'],
      properties: {
        schema_version: { const: 1 },
        ok: { type: 'boolean', description: 'False only when the PDF requested by --pdf could not be written; the Markdown report is still listed in outputs.' },
        title: { type: 'string' },
        outputs: { type: 'object', required: ['markdown'], properties: { markdown: { type: 'string' }, pdf: { type: 'string' } } },
        counts: { type: 'object', required: ['manifests', 'tables', 'figures'], properties: { manifests: { type: 'integer' }, tables: { type: 'integer' }, figures: { type: 'integer' } } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    PlannedBuild: {
      type: 'object',
      required: ['schema_version', 'planned', 'title', 'inputs', 'outputs', 'actions'],
      properties: {
        schema_version: { const: 1 },
        planned: { const: true },
        title: { type: 'string' },
        inputs: { type: 'object' },
        outputs: { type: 'object' },
        actions: { type: 'array', items: { type: 'string' } },
      },
    },
    CheckResult: {
      type: 'object',
      required: ['schema_version', 'ok', 'interpreter', 'matplotlib', 'pdf_ready'],
      properties: {
        schema_version: { const: 1 },
        ok: { type: 'boolean', description: 'True when the Python interpreter ran the engine.' },
        interpreter: { type: 'object', properties: { source: { type: 'string', enum: ['BIOAGENT_ENV_BIN', 'repository .bioenv', 'PATH'] }, requested: { type: 'string' }, path: { type: 'string' }, version: { type: 'string' } } },
        matplotlib: { type: 'object', properties: { available: { type: 'boolean' }, version: { type: ['string', 'null'] }, error: { type: ['string', 'null'] } } },
        pdf_ready: { type: 'boolean' },
        hint: { type: ['string', 'null'] },
        error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
      },
    },
    Error: {
      type: 'object',
      required: ['schema_version', 'error'],
      properties: {
        schema_version: { const: 1 },
        error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } } },
      },
    },
  },
};

function usage(command) {
  if (!command) {
    return [
      'Usage: bio-report <command> [options]',
      '',
      'Assemble a reproducible Markdown (and optional PDF) analysis report from tool',
      'manifests, result tables, figures and methods notes. Every run is recorded with',
      'its parameters, software version and sha256 provenance.',
      '',
      'Commands:',
      '  build   Build the report. Requires at least one input source.',
      '  check   Report the Python interpreter and matplotlib availability.',
      '',
      'Global options:',
      '  --describe [--format json]   Print the machine-readable command registry',
      '  --version                    Print the CLI version',
      '  -h, --help                   Print help',
      '',
      'Exit codes: 0 success; 1 runtime failure; 2 usage or input error.',
    ].join('\n');
  }
  if (command === 'build') {
    return [
      'Usage: bio-report build [--manifest PATH]... [--results-dir DIR]... [--figures-dir DIR]...',
      '                        [--methods PATH] [--title TEXT] [--output report.md]',
      '                        [--pdf report.pdf] [--dry-run] [--format json]',
      '',
      'Reads manifests for commands, parameters, software versions and sha256 digests;',
      'summarizes .csv/.tsv tables (first 20 rows plus row and column counts); lists',
      '.png/.pdf/.svg figures; and splices in a Methods Markdown file. Requires at least',
      'one of --manifest, --results-dir, --figures-dir or --methods.',
      '',
      '  --manifest PATH     Manifest JSON; repeat for multiple tool runs. Tolerates',
      '                      missing fields: they become warnings, not failures.',
      '  --results-dir DIR   Directory scanned recursively for .csv/.tsv tables; repeatable.',
      '  --figures-dir DIR   Directory scanned recursively for .png/.pdf/.svg figures; repeatable.',
      '  --methods PATH      Markdown file copied into the Methods section.',
      '  --title TEXT        Report title (default: "Analysis Report").',
      '  --output PATH       Markdown output path (default: report.md).',
      '  --pdf PATH          Optional PDF rendered with matplotlib; needs matplotlib and',
      '                      no pandoc or LaTeX. A failure still writes the Markdown',
      '                      report, prints a hint, and exits 1.',
      '  --dry-run           Print the planned inputs, outputs and actions; write nothing.',
      '  --format json       Machine output (default and only format).',
      '',
      'Examples:',
      '  bio-report build --manifest run/fastp.json --manifest run/star.json --results-dir results',
      '  bio-report build --manifest run/star.json --figures-dir figures --methods methods.md',
      '  bio-report build --manifest run/star.json --output out/report.md --pdf out/report.pdf',
      '  bio-report build --manifest run/star.json --dry-run',
      '',
      'Exit codes: 0 success; 1 runtime failure; 2 usage or input error.',
    ].join('\n');
  }
  return [
    'Usage: bio-report check [--format json]',
    '',
    'Reports the Python interpreter that runs the report engine (resolved from',
    'BIOAGENT_ENV_BIN, <repo>/.bioenv/bin/python, then python3 on PATH) and whether',
    'matplotlib is importable for --pdf. Exits 0 when the interpreter ran; 1 otherwise.',
  ].join('\n');
}

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  const raw = command ? argv.slice(1) : argv;
  const entries = [];
  const positionals = [];

  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === '-h') {
      entries.push({ key: 'help', value: undefined });
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const key = separator === -1 ? body : body.slice(0, separator);
    if (!key) throw new CliError('invalid-input', 'An option must have a name.', 2, HELP_HINT);
    let value = separator === -1 ? undefined : body.slice(separator + 1);
    if (!BOOLEAN_FLAGS.has(key) && value === undefined) {
      const next = raw[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      }
    }
    entries.push({ key, value });
  }

  return { command, entries, positionals };
}

function requestedFormat(parsed) {
  return parsed.entries.find((entry) => entry.key === 'format')?.value;
}

function assertFormatValue(value) {
  if (value !== undefined && value !== 'json') throw new CliError('invalid-input', '--format must be json.', 2, HELP_HINT);
}

function coerce(command, parsed) {
  const spec = description.commands[command].options;
  const values = {};

  for (const entry of parsed.entries) {
    if (entry.key === 'help' || entry.key === 'describe' || entry.key === 'version') continue;
    const option = spec[entry.key];
    if (!option) {
      throw new CliError('unknown-option', `--${entry.key} is not supported by '${command}'.`, 2, `run 'bio-report ${command} --help'`);
    }
    if (option.type === 'boolean') {
      if (entry.value !== undefined) throw new CliError('invalid-input', `--${entry.key} does not take a value.`, 2, `run 'bio-report ${command} --help'`);
      values[entry.key] = true;
      continue;
    }
    if (entry.value === undefined) {
      throw new CliError('missing-value', `--${entry.key} requires a value.`, 2, `run 'bio-report ${command} --help'`);
    }
    if (option.type === 'path[]') {
      (values[entry.key] ??= []).push(path.resolve(entry.value));
      continue;
    }
    if (values[entry.key] !== undefined) {
      throw new CliError('duplicate-option', `--${entry.key} may be provided only once; use one path per option.`, 2, `run 'bio-report ${command} --help'`);
    }
    values[entry.key] = option.type === 'path' ? path.resolve(entry.value) : entry.value;
  }

  for (const [key, option] of Object.entries(spec)) {
    if (values[key] !== undefined) continue;
    if (option.type === 'path[]') values[key] = [];
    else if (option.default !== undefined) values[key] = option.type === 'path' ? path.resolve(option.default) : option.default;
  }

  if (values.format !== undefined && !(spec.format?.enum ?? []).includes(values.format)) {
    throw new CliError('invalid-input', `--format must be one of ${(spec.format?.enum ?? []).join(', ')}.`, 2, `run 'bio-report ${command} --help'`);
  }
  if (parsed.positionals.length) {
    throw new CliError('unexpected-argument', `Unexpected argument: ${parsed.positionals[0]}.`, 2, `run 'bio-report ${command} --help'`);
  }

  return values;
}

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePython(environment = process.env) {
  const candidates = [];
  if (environment.BIOAGENT_ENV_BIN) {
    candidates.push({ source: 'BIOAGENT_ENV_BIN', path: path.join(environment.BIOAGENT_ENV_BIN, 'python3') });
  }
  candidates.push({ source: 'repository .bioenv', path: path.join(REPOSITORY_ROOT, '.bioenv', 'bin', 'python') });
  candidates.push({ source: 'PATH', path: 'python3' });

  for (const candidate of candidates) {
    if (candidate.source === 'PATH') return candidate;
    if (isExecutableFile(candidate.path)) return candidate;
  }
  return { source: 'PATH', path: 'python3' };
}

function pythonHint(python) {
  if (python.source === 'PATH') {
    return 'install Python 3.9 or newer, or set BIOAGENT_ENV_BIN to a directory that provides python3';
  }
  return `check that ${python.path} is executable, or set BIOAGENT_ENV_BIN to a directory that provides python3`;
}

function runPython(python, arguments_, input) {
  const result = spawnSync(python.path, arguments_, {
    input,
    encoding: 'utf8',
    timeout: ENGINE_TIMEOUT_MS,
    maxBuffer: ENGINE_MAX_BUFFER,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new CliError('engine-timeout', `The report engine did not finish within ${Math.round(ENGINE_TIMEOUT_MS / 1000)} seconds.`, 1, 'reduce the number of manifests, tables or figures and retry');
  }
  if (result.error) {
    throw new CliError('python-unavailable', `Cannot run ${python.path}: ${result.error.message}`, 1, pythonHint(python));
  }
  return result;
}

function parseEngineDocument(result) {
  const stdout = (result.stdout ?? '').trim();
  let document = null;
  if (stdout) {
    try {
      document = JSON.parse(stdout);
    } catch {
      document = null;
    }
  }
  if (result.status !== 0 && document?.error) {
    throw new CliError(document.error.code ?? 'engine-failed', document.error.message ?? 'The report engine failed.', 1, document.hint ?? 'run bio-report check');
  }
  if (result.status !== 0) {
    const diagnostic = String(result.stderr ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || stdout.slice(-400) || 'no diagnostic';
    throw new CliError('engine-failed', `The report engine exited with ${result.status ?? 'no status'}: ${diagnostic}`, 1, 'run bio-report check, then retry with a smaller input set');
  }
  if (!document) {
    throw new CliError('engine-failed', 'The report engine did not return a JSON document.', 1, 'run bio-report check');
  }
  return document;
}

function assertFile(target, flag) {
  let stats;
  try {
    stats = fs.statSync(target);
  } catch {
    throw new CliError('invalid-input', `${flag} path does not exist: ${target}`, 2, "run 'bio-report build --help'");
  }
  if (!stats.isFile()) throw new CliError('invalid-input', `${flag} expects a file: ${target}`, 2, "run 'bio-report build --help'");
}

function assertDirectory(target, flag) {
  let stats;
  try {
    stats = fs.statSync(target);
  } catch {
    throw new CliError('invalid-input', `${flag} directory does not exist: ${target}`, 2, "run 'bio-report build --help'");
  }
  if (!stats.isDirectory()) throw new CliError('invalid-input', `${flag} expects a directory: ${target}`, 2, "run 'bio-report build --help'");
}

function plannedActions(inputs, output, pdf) {
  const actions = [
    `read ${inputs.manifests.length} manifest file(s) for tools, versions, parameters, commands and sha256 digests`,
    `write the Markdown report to ${output}`,
  ];
  if (inputs.results_dirs.length) actions.splice(1, 0, `scan ${inputs.results_dirs.length} results director${inputs.results_dirs.length === 1 ? 'y' : 'ies'} for .csv/.tsv tables`);
  if (inputs.figures_dirs.length) actions.splice(actions.length - 1, 0, `scan ${inputs.figures_dirs.length} figures director${inputs.figures_dirs.length === 1 ? 'y' : 'ies'} for .png/.pdf/.svg figures`);
  if (inputs.methods) actions.splice(actions.length - 1, 0, `read the methods Markdown from ${inputs.methods}`);
  if (pdf) actions.push(`render the PDF with matplotlib to ${pdf}`);
  return actions;
}

async function build(values, io) {
  const inputs = {
    manifests: values.manifest,
    results_dirs: values['results-dir'],
    figures_dirs: values['figures-dir'],
    methods: values.methods ?? null,
  };
  if (!inputs.manifests.length && !inputs.results_dirs.length && !inputs.figures_dirs.length && !inputs.methods) {
    throw new CliError('missing-input', 'Provide at least one input: --manifest, --results-dir, --figures-dir, or --methods.', 2, "run 'bio-report build --help'");
  }
  for (const manifest of inputs.manifests) assertFile(manifest, '--manifest');
  for (const directory of inputs.results_dirs) assertDirectory(directory, '--results-dir');
  for (const directory of inputs.figures_dirs) assertDirectory(directory, '--figures-dir');
  if (inputs.methods) assertFile(inputs.methods, '--methods');

  const output = values.output;
  const pdf = values.pdf ?? null;
  if (pdf && pdf === output) {
    throw new CliError('invalid-input', '--pdf and --output must be different paths.', 2, "run 'bio-report build --help'");
  }

  const planned = {
    schema_version: 1,
    planned: true,
    title: values.title,
    inputs,
    outputs: pdf ? { markdown: output, pdf } : { markdown: output },
    actions: plannedActions(inputs, output, pdf),
  };
  if (values['dry-run']) {
    io.stdout.write(`${JSON.stringify(planned)}\n`);
    return 0;
  }

  const python = resolvePython();
  const payload = JSON.stringify({
    title: values.title,
    output,
    pdf,
    methods: inputs.methods,
    manifests: inputs.manifests,
    results_dirs: inputs.results_dirs,
    figures_dirs: inputs.figures_dirs,
  });
  const document = parseEngineDocument(runPython(python, [ENGINE_PATH, 'build'], payload));

  const response = {
    schema_version: 1,
    ok: document.ok === true,
    title: values.title,
    outputs: document.outputs ?? {},
    counts: document.counts ?? { manifests: inputs.manifests.length, tables: 0, figures: 0 },
    warnings: document.warnings ?? [],
  };
  io.stdout.write(`${JSON.stringify(response)}\n`);
  for (const warning of response.warnings) io.stderr.write(`warning: ${warning}\n`);

  if (!response.ok) {
    const code = document.error?.code ?? 'engine-failed';
    const message = document.error?.message ?? 'The report could not be completed.';
    io.stderr.write(`error[${code}]: ${message}\n`);
    if (document.hint) io.stderr.write(`hint: ${document.hint}\n`);
    return 1;
  }
  return 0;
}

function check(io) {
  const python = resolvePython();
  let document;
  try {
    document = parseEngineDocument(runPython(python, [ENGINE_PATH, 'check']));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const response = {
      schema_version: 1,
      ok: false,
      interpreter: { source: python.source, requested: python.path, path: null, version: null },
      matplotlib: { available: false, version: null, error: error.message },
      pdf_ready: false,
      hint: error.hint ?? pythonHint(python),
      error: { code: error.code, message: error.message },
    };
    io.stdout.write(`${JSON.stringify(response)}\n`);
    io.stderr.write(`error[${error.code}]: ${error.message}\n`);
    return 1;
  }
  const matplotlib = document.matplotlib ?? { available: false, version: null, error: 'The engine did not report matplotlib status.' };
  const interpreterPath = document.python?.path ?? python.path;
  const response = {
    schema_version: 1,
    ok: document.python?.available === true,
    interpreter: { source: python.source, requested: python.path, path: interpreterPath, version: document.python?.version ?? null },
    matplotlib,
    pdf_ready: matplotlib.available === true,
    hint: matplotlib.available ? null : `install matplotlib for PDF output: "${interpreterPath}" -m pip install matplotlib. Markdown reports work without it.`,
  };
  io.stdout.write(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : 1;
}

export async function main(argv, io = process) {
  try {
    const parsed = parse(argv);
    const wantsHelp = parsed.entries.some((entry) => entry.key === 'help');
    const wantsVersion = parsed.entries.some((entry) => entry.key === 'version');
    const wantsDescribe = parsed.entries.some((entry) => entry.key === 'describe');

    if (!parsed.command) {
      if (wantsVersion) {
        io.stdout.write(`${VERSION}\n`);
        return 0;
      }
      if (wantsDescribe) {
        assertFormatValue(requestedFormat(parsed));
        io.stdout.write(`${JSON.stringify(description)}\n`);
        return 0;
      }
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (!description.commands[parsed.command]) {
      throw new CliError('unknown-command', `Unknown command: ${parsed.command}.`, 2, `run 'bio-report --help' to list commands: ${Object.keys(description.commands).join(', ')}`);
    }
    if (wantsHelp) {
      io.stdout.write(`${usage(parsed.command)}\n`);
      return 0;
    }
    if (wantsDescribe) {
      assertFormatValue(requestedFormat(parsed));
      io.stdout.write(`${JSON.stringify({ ...description, commands: { [parsed.command]: description.commands[parsed.command] } })}\n`);
      return 0;
    }

    const values = coerce(parsed.command, parsed);
    if (parsed.command === 'check') return check(io);
    return await build(values, io);
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('internal', error instanceof Error ? error.message : String(error), 1, HELP_HINT);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: cliError.hint ?? HELP_HINT } })}\n`);
    return cliError.exitCode;
  }
}
