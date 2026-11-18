import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const SCHEMA_VERSION = 1;
const FORMATS = ['json'];
const OUTPUT_FILES = ['qc.json', 'qc.tsv', 'manifest.json'];
const ENGINE_PATH = fileURLToPath(new URL('./engine.py', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODULES = ['pysam', 'scanpy', 'anndata', 'h5py', 'numpy', 'scipy'];
const REQUIRED_MODULES = ['pysam'];
const OPTIONAL_TOOLS = ['fastp', 'fastqc', 'samtools'];
const DRY_RUN_NOTE = 'No files were written; the real run will create qc.json, qc.tsv, and manifest.json in --output.';

export class CliError extends Error {
  constructor(code, message, hint = "run 'bio-qc --help'", exitCode = 2) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

const ERROR_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'error'],
  properties: {
    schema_version: { const: 1 },
    error: {
      type: 'object',
      required: ['code', 'message', 'hint'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        hint: { type: 'string' },
      },
    },
  },
};

export const description = {
  schema_version: 1,
  name: 'bio-qc',
  version: VERSION,
  default_format: 'json',
  description: 'Quality-control summaries for FASTQ reads, BAM alignments, and single-cell expression matrices. Built-in statistics need only a Python interpreter; external fastp/FastQC are reported by check but never required.',
  exit_codes: {
    '0': 'success',
    '1': 'dependency, Python, or analysis failure',
    '2': 'usage or input error',
  },
  python_resolution: [
    '${BIOAGENT_ENV_BIN}/python3 when BIOAGENT_ENV_BIN is set',
    '<repository>/.bioenv/bin/python',
    'python3 on PATH',
  ],
  commands: {
    check: {
      description: 'Report the selected Python interpreter, QC backend modules, and optional external tools.',
      writes: [],
      options: {
        format: { type: 'string', enum: FORMATS, default: 'json', description: 'Output format.' },
      },
      examples: ['bio-qc check --format json'],
      output: 'CheckResult',
    },
    fastq: {
      description: 'Stream FASTQ or gzip-compressed FASTQ reads and compute read/base totals, Q20/Q30 ratios, GC and N percentages, read lengths, and a length distribution without invoking fastp or FastQC.',
      writes: OUTPUT_FILES,
      options: {
        input: { type: 'path', required: true, description: 'Read 1 FASTQ, optionally gzip-compressed.' },
        input2: { type: 'path', description: 'Optional Read 2 FASTQ for paired-end input.' },
        output: { type: 'path', required: true, description: 'Output directory for qc.json, qc.tsv, and manifest.json.' },
        'dry-run': { type: 'boolean', default: false, description: 'Validate inputs and print the plan without reading reads or writing files.' },
        format: { type: 'string', enum: FORMATS, default: 'json', description: 'Output format.' },
      },
      examples: [
        'bio-qc fastq --input R1.fastq.gz --input2 R2.fastq.gz --output qc_out --format json',
        'bio-qc fastq --input reads.fastq --output qc_out --dry-run',
      ],
      output: 'FastqQcResult',
    },
    bam: {
      description: 'Summarize BAM alignment records: mapped/duplicate/properly-paired reads, average insert size, reference count, and a rough coverage estimate using pysam.',
      writes: OUTPUT_FILES,
      options: {
        input: { type: 'path', required: true, description: 'BAM file. CRAM is not supported by this command.' },
        output: { type: 'path', required: true, description: 'Output directory for qc.json, qc.tsv, and manifest.json.' },
        'dry-run': { type: 'boolean', default: false, description: 'Validate inputs and print the plan without reading alignments or writing files.' },
        format: { type: 'string', enum: FORMATS, default: 'json', description: 'Output format.' },
      },
      examples: [
        'bio-qc bam --input sample.bam --output qc_out --format json',
        'bio-qc bam --input sample.bam --output qc_out --dry-run',
      ],
      output: 'BamQcResult',
    },
    matrix: {
      description: 'Summarize a single-cell expression matrix: cells, genes, counts per cell, genes detected per cell, and mitochondrial fraction when gene names start with MT-. Reads .h5ad via anndata, 10x Matrix Market directories via scipy, and dense CSV/TSV matrices without extra packages.',
      writes: OUTPUT_FILES,
      options: {
        input: { type: 'path', required: true, description: '.h5ad file, 10x mtx directory, or .csv/.tsv/.txt dense matrix with cells as rows and genes as columns.' },
        output: { type: 'path', required: true, description: 'Output directory for qc.json, qc.tsv, and manifest.json.' },
        'dry-run': { type: 'boolean', default: false, description: 'Validate the matrix type and print the plan without reading the matrix or writing files.' },
        format: { type: 'string', enum: FORMATS, default: 'json', description: 'Output format.' },
      },
      examples: [
        'bio-qc matrix --input matrix.csv --output qc_out --format json',
        'bio-qc matrix --input filtered.h5ad --output qc_out --format json',
        'bio-qc matrix --input filtered_feature_bc_matrix/ --output qc_out --dry-run',
      ],
      output: 'MatrixQcResult',
    },
  },
  schemas: {
    CheckResult: {
      type: 'object',
      required: ['schema_version', 'command', 'ok', 'python', 'modules', 'tools', 'missing', 'optional_missing', 'capabilities'],
      properties: {
        schema_version: { const: 1 },
        command: { const: 'check' },
        ok: { type: 'boolean' },
        python: { type: 'object' },
        modules: { type: 'object' },
        tools: { type: 'object' },
        missing: { type: 'array', items: { type: 'string' } },
        optional_missing: { type: 'array', items: { type: 'string' } },
        capabilities: { type: 'object' },
        hints: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    FastqQcResult: {
      type: 'object',
      required: ['schema_version', 'command', 'planned', 'input', 'output_dir'],
      properties: {
        schema_version: { const: 1 },
        command: { const: 'fastq' },
        planned: { type: 'boolean' },
        input: { type: 'object' },
        output_dir: { type: 'string' },
        planned_files: { type: 'array', items: { type: 'string' } },
        outputs: { type: 'object' },
        summary: { type: 'object' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    BamQcResult: {
      type: 'object',
      required: ['schema_version', 'command', 'planned', 'input', 'output_dir'],
      properties: {
        schema_version: { const: 1 },
        command: { const: 'bam' },
        planned: { type: 'boolean' },
        input: { type: 'object' },
        output_dir: { type: 'string' },
        planned_files: { type: 'array', items: { type: 'string' } },
        outputs: { type: 'object' },
        summary: { type: 'object' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    MatrixQcResult: {
      type: 'object',
      required: ['schema_version', 'command', 'planned', 'input', 'output_dir'],
      properties: {
        schema_version: { const: 1 },
        command: { const: 'matrix' },
        planned: { type: 'boolean' },
        input: { type: 'object' },
        output_dir: { type: 'string' },
        planned_files: { type: 'array', items: { type: 'string' } },
        outputs: { type: 'object' },
        summary: { type: 'object' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    Error: ERROR_SCHEMA,
  },
};

function optionToken(name, option) {
  const flag = name.startsWith('--') ? name : `--${name}`;
  let token = flag;
  if (option.type !== 'boolean') {
    const placeholder = option.type === 'integer' ? 'N' : option.type === 'path' ? 'PATH' : 'VALUE';
    token += option.enum ? ` ${option.enum.join('|')}` : ` ${placeholder}`;
  }
  return option.required ? token : `[${token}]`;
}

function optionHelp(options) {
  return Object.entries(options).map(([name, option]) => {
    const details = [];
    if (option.required) details.push('required');
    if (option.default !== undefined) details.push(`default: ${JSON.stringify(option.default)}`);
    if (option.enum) details.push(`one of: ${option.enum.join(', ')}`);
    const suffix = details.length ? ` (${details.join('; ')})` : '';
    return `  ${optionToken(name, option).padEnd(34)}${option.description || ''}${suffix}`;
  });
}

function topUsage() {
  const commands = Object.entries(description.commands)
    .map(([name, spec]) => `  ${name.padEnd(9)}${spec.description.split('. ')[0].replace(/\.$/, '')}.`)
    .join('\n');
  return `Usage: bio-qc <command> [options]

${description.description}

Commands:
${commands}

Global options:
  --describe --format json   Print the machine-readable command registry
  --version                  Print the CLI version
  -h, --help                 Print help

Run 'bio-qc <command> --help' for command-specific options and examples.
stdout carries one JSON result; diagnostics and errors go to stderr.
Exit codes: 0 success, 1 dependency or analysis failure, 2 usage or input error.`;
}

function commandUsage(command) {
  const spec = description.commands[command];
  const options = Object.entries(spec.options).map(([name, option]) => optionToken(name, option));
  const outputLine = spec.writes.length
    ? `Artifacts: ${spec.writes.join(', ')} inside --output.`
    : 'Artifacts: none (read-only command).';
  const examples = (spec.examples || []).length
    ? `\nExamples:\n${spec.examples.map((example) => `  ${example}`).join('\n')}\n`
    : '';
  return `Usage: bio-qc ${command} ${options.join(' ')}

${spec.description}

Options:
${optionHelp(spec.options).join('\n')}
${examples}
${outputLine}
stdout carries one JSON result; diagnostics and errors go to stderr.
Exit codes: 0 success, 1 dependency or analysis failure, 2 usage or input error.`;
}

function usage(command) {
  return command ? commandUsage(command) : topUsage();
}

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  const raw = command ? argv.slice(1) : argv;
  const values = { _: [] };
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === '-h' || token === '--help') { values.help = true; continue; }
    if (token === '--') { values._.push(...raw.slice(index + 1)); break; }
    if (!token.startsWith('--')) { values._.push(token); continue; }
    const [key, inline] = token.slice(2).split('=', 2);
    if (['help', 'describe', 'version', 'dry-run'].includes(key)) {
      if (inline !== undefined) throw new CliError('invalid-input', `--${key} does not take a value.`);
      values[key] = true;
      continue;
    }
    const value = inline !== undefined ? inline : raw[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError('missing-value', `--${key} requires a value.`, `Run 'bio-qc ${command ? `${command} ` : ''}--help'.`);
    }
    if (values[key] !== undefined) throw new CliError('duplicate-option', `--${key} may be provided only once.`);
    values[key] = value;
  }
  return { command, values };
}

function allowed(values, keys, command) {
  for (const key of Object.keys(values)) {
    if (key === '_') continue;
    if (!keys.includes(key)) {
      throw new CliError('unknown-option', `--${key} is not supported by this command.`, `Run 'bio-qc ${command ? `${command} ` : ''}--help'.`);
    }
  }
  if (values._.length) throw new CliError('unexpected-argument', `Unexpected argument: ${values._[0]}.`, `Run 'bio-qc ${command ? `${command} ` : ''}--help'.`);
}

function validateFormat(values) {
  if (values.format !== undefined && !FORMATS.includes(values.format)) {
    throw new CliError('invalid-input', `--format must be one of ${FORMATS.join(', ')}.`);
  }
}

function lastLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1].trim() : '';
}

function pythonCandidates(env) {
  const candidates = [];
  if (env.BIOAGENT_ENV_BIN) candidates.push({ command: path.join(env.BIOAGENT_ENV_BIN, 'python3'), source: 'BIOAGENT_ENV_BIN' });
  candidates.push({ command: path.join(REPO_ROOT, '.bioenv', 'bin', 'python'), source: 'repository .bioenv' });
  candidates.push({ command: 'python3', source: 'PATH' });
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.command)) return false;
    seen.add(candidate.command);
    return true;
  });
}

function probeInterpreter(command) {
  const child = spawnSync(command, ['-c', 'import sys; print(sys.version.split()[0]); print(sys.executable)'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONWARNINGS: 'ignore' },
  });
  if (child.error) {
    return { ok: false, error: child.error.code === 'ENOENT' ? 'not found' : child.error.message };
  }
  if (child.status !== 0) {
    return { ok: false, error: lastLine(child.stderr) || `exited with code ${child.status}` };
  }
  const lines = String(child.stdout || '').trim().split(/\r?\n/);
  if (!lines[0]) return { ok: false, error: 'interpreter printed no version' };
  return { ok: true, version: lines[0], path: lines[1] || command };
}

export function resolvePython({ env = process.env } = {}) {
  const attempts = [];
  for (const candidate of pythonCandidates(env)) {
    const probe = probeInterpreter(candidate.command);
    attempts.push({
      command: candidate.command,
      source: candidate.source,
      ok: probe.ok,
      version: probe.version ?? null,
      path: probe.path ?? null,
      error: probe.ok ? null : probe.error,
    });
    if (probe.ok) {
      return {
        python: { command: candidate.command, source: candidate.source, version: probe.version, path: probe.path },
        attempts,
      };
    }
  }
  return { python: null, attempts };
}

const PROBE_SCRIPT = [
  'import importlib, json, sys',
  'names = json.loads(sys.argv[1])',
  'modules = {}',
  'for name in names:',
  '    try:',
  '        module = importlib.import_module(name)',
  '        version = getattr(module, "__version__", None)',
  '        if version is None:',
  '            try:',
  '                from importlib.metadata import version as package_version',
  '                version = package_version(name)',
  '            except Exception:',
  '                version = None',
  '        modules[name] = {"available": True, "version": str(version) if version is not None else None}',
  '    except Exception as exc:',
  '        modules[name] = {"available": False, "version": None, "error": type(exc).__name__}',
  'print(json.dumps({"executable": sys.executable, "version": sys.version.split()[0], "modules": modules}))',
].join('\n');

function probeModules(command) {
  const child = spawnSync(command, ['-c', PROBE_SCRIPT, JSON.stringify(MODULES)], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONWARNINGS: 'ignore' },
  });
  if (child.error) return { ok: false, error: child.error.message };
  if (child.status !== 0) return { ok: false, error: lastLine(child.stderr) || `exited with code ${child.status}` };
  try {
    const payload = JSON.parse(String(child.stdout || '').trim());
    return { ok: true, modules: payload.modules || {}, executable: payload.executable, version: payload.version };
  } catch (error) {
    return { ok: false, error: `module probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function findExecutable(name) {
  const directories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

function toolVersion(executable) {
  const child = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONWARNINGS: 'ignore' },
  });
  if (child.error) return null;
  const text = `${child.stdout || ''}\n${child.stderr || ''}`;
  const line = text.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  return line || null;
}

function detectTools() {
  const tools = {};
  for (const name of OPTIONAL_TOOLS) {
    const executable = findExecutable(name);
    tools[name] = executable
      ? { available: true, path: executable, version: toolVersion(executable) }
      : { available: false, path: null, version: null };
  }
  return tools;
}

function pythonHint(attempts) {
  const tried = attempts.map((attempt) => `${attempt.command} (${attempt.source}${attempt.error ? `: ${attempt.error}` : ''})`).join('; ');
  return `Tried: ${tried}. Set BIOAGENT_ENV_BIN to a bin directory containing python3, create ${path.join(REPO_ROOT, '.bioenv')} from requirements.txt, or put python3 on PATH.`;
}

function checkHints({ python, modules, capabilities, tools }) {
  const hints = [];
  if (!python) {
    hints.push(`No working Python interpreter was found. Set BIOAGENT_ENV_BIN to a bin directory containing python3, create ${path.join(REPO_ROOT, '.bioenv')} from requirements.txt, or put python3 on PATH.`);
    return hints;
  }
  if (!modules.pysam?.available) hints.push(`Install pysam to enable BAM QC with: "${python.command}" -m pip install pysam`);
  if (!capabilities.matrix_h5ad) hints.push(`Install anndata and h5py to read .h5ad matrices with: "${python.command}" -m pip install anndata h5py (CSV/TSV matrices work without them).`);
  if (!capabilities.matrix_mtx) hints.push(`Install scipy to read 10x Matrix Market directories with: "${python.command}" -m pip install scipy`);
  if (!tools.fastp.available || !tools.fastqc.available) hints.push('fastp and FastQC are optional cross-check tools; bio-qc computes FASTQ statistics in Python without them.');
  return hints;
}

function checkCommand(io) {
  const { python, attempts } = resolvePython();
  const tools = detectTools();
  let modules = {};
  const warnings = [];
  let pythonReport = {
    ok: false,
    command: null,
    path: null,
    version: null,
    source: null,
    candidates: attempts,
  };
  if (python) {
    const probe = probeModules(python.command);
    if (probe.ok) {
      modules = probe.modules;
    } else {
      warnings.push(`Python module probe failed: ${probe.error}`);
    }
    pythonReport = {
      ok: true,
      command: python.command,
      path: python.path,
      version: python.version,
      source: python.source,
      candidates: attempts,
    };
  }
  const skipped = attempts.filter((attempt) => !attempt.ok);
  if (skipped.length) {
    warnings.push(`Skipped unusable Python candidate(s): ${skipped.map((attempt) => `${attempt.command} (${attempt.error})`).join('; ')}`);
  }
  const missing = [];
  if (!python) missing.push('python3');
  else if (!modules.pysam?.available) missing.push(...REQUIRED_MODULES.filter((name) => !modules[name]?.available));
  const capabilities = {
    fastq: Boolean(python),
    bam: Boolean(python && modules.pysam?.available),
    matrix_csv: Boolean(python),
    matrix_h5ad: Boolean(python && modules.anndata?.available && modules.h5py?.available),
    matrix_mtx: Boolean(python && modules.scipy?.available),
  };
  const optionalMissing = ['fastp', 'fastqc'].filter((name) => !tools[name].available);
  const hints = checkHints({ python, modules, capabilities, tools });
  const result = {
    schema_version: SCHEMA_VERSION,
    command: 'check',
    ok: missing.length === 0,
    python: pythonReport,
    modules,
    tools,
    missing,
    optional_missing: optionalMissing,
    capabilities,
    hints,
    warnings,
  };
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

function ensureReadableFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new CliError('invalid-input', `${label} does not exist: ${filePath}`, `Check the path and retry with an absolute path if needed (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!stat.isFile()) throw new CliError('invalid-input', `${label} is not a regular file: ${filePath}`, 'Pass a file path, not a directory.');
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new CliError('invalid-input', `${label} is not readable: ${filePath}`, 'Check file permissions.');
  }
  return stat;
}

function inspectOutput(output) {
  const absolute = path.resolve(output);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) throw new CliError('invalid-input', `--output exists and is not a directory: ${absolute}`, 'Pass a directory path or remove the existing file.');
    return { path: absolute, exists: true };
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error.code === 'ENOENT') return { path: absolute, exists: false };
    throw new CliError('invalid-input', `Cannot inspect --output ${absolute}: ${error instanceof Error ? error.message : String(error)}`, 'Check the parent directory and permissions.');
  }
}

function ensureOutputDir(outputPath) {
  try {
    fs.mkdirSync(outputPath, { recursive: true });
  } catch (error) {
    throw new CliError('output-failed', `Cannot create output directory ${outputPath}: ${error instanceof Error ? error.message : String(error)}`, 'Check the parent directory and permissions.', 1);
  }
}

function plannedFiles(outputPath) {
  return OUTPUT_FILES.map((file) => path.join(outputPath, file));
}

function detectCompression(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(2);
    const bytes = fs.readSync(descriptor, buffer, 0, 2, 0);
    return bytes === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b ? 'gzip' : 'plain';
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest('hex');
  } catch (error) {
    throw new CliError('output-failed', `Cannot hash ${filePath}: ${error instanceof Error ? error.message : String(error)}`, 'Check file permissions.', 1);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fingerprintFile(filePath) {
  return { path: filePath, sha256: sha256File(filePath), bytes: fs.statSync(filePath).size };
}

function fingerprintPath(inputPath) {
  let stat;
  try {
    stat = fs.statSync(inputPath);
  } catch (error) {
    throw new CliError('invalid-input', `Input does not exist: ${inputPath}`, `Check the path (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (stat.isFile()) return [fingerprintFile(inputPath)];
  if (stat.isDirectory()) {
    const files = fs.readdirSync(inputPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(inputPath, entry.name))
      .sort();
    if (!files.length) throw new CliError('invalid-input', `Input directory contains no files: ${inputPath}`, 'Provide a 10x Matrix Market directory or a matrix file.');
    return files.map((file) => fingerprintFile(file));
  }
  throw new CliError('invalid-input', `Input is neither a file nor a directory: ${inputPath}`, 'Pass a matrix file or a 10x mtx directory.');
}

function runEngine(python, request) {
  if (!fs.existsSync(ENGINE_PATH)) {
    throw new CliError('internal-error', `Python engine is missing: ${ENGINE_PATH}`, 'Reinstall bio-qc; the package is incomplete.', 1);
  }
  const options = {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONWARNINGS: 'ignore', PYTHONIOENCODING: 'utf-8', MPLBACKEND: 'Agg' },
  };
  const timeout = Number(process.env.BIO_QC_TIMEOUT_MS || 0);
  if (Number.isFinite(timeout) && timeout > 0) options.timeout = timeout;
  const child = spawnSync(python.command, [ENGINE_PATH], options);
  if (child.error) {
    if (child.error.code === 'ENOENT') {
      throw new CliError('dependency-missing', `Python interpreter disappeared: ${python.command}`, 'Run bio-qc check and install or select a working interpreter.', 1);
    }
    throw new CliError('analysis-failed', `Cannot start the Python engine: ${child.error.message}`, 'Run bio-qc check for interpreter details.', 1);
  }
  const payload = parseEnginePayload(child.stdout);
  if (payload && payload.ok === false) {
    const engineError = payload.error || {};
    throw new CliError(
      engineError.code || 'analysis-failed',
      engineError.message || 'The Python engine reported a failure.',
      engineError.hint || 'Run bio-qc check for dependency details.',
      engineError.code === 'invalid-input' ? 2 : 1,
    );
  }
  if (child.status !== 0) {
    const detail = lastLine(child.stderr);
    throw new CliError(
      'analysis-failed',
      `Python engine exited with code ${child.status}${child.signal ? ` (signal ${child.signal})` : ''}${detail ? `: ${detail}` : ''}.`,
      'Set BIO_QC_DEBUG=1 for engine diagnostics, or run bio-qc check.',
      1,
    );
  }
  if (!payload || payload.ok !== true) {
    throw new CliError('analysis-failed', 'Python engine returned an unexpected payload.', 'Run bio-qc check, then retry with --verbose diagnostics (BIO_QC_DEBUG=1).', 1);
  }
  return payload;
}

function parseEnginePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function requirePython() {
  const resolved = resolvePython();
  if (!resolved.python) {
    throw new CliError('dependency-missing', 'No working Python interpreter was found.', pythonHint(resolved.attempts), 1);
  }
  return resolved;
}

function pythonPlan(resolved) {
  if (resolved.python) {
    return {
      available: true,
      command: resolved.python.command,
      path: resolved.python.path,
      version: resolved.python.version,
      source: resolved.python.source,
    };
  }
  return { available: false, command: null, path: null, version: null, source: null, candidates: resolved.attempts };
}

function planWarnings(resolved) {
  return resolved.python ? [] : ['No working Python interpreter was found; the real run will fail until one is installed.'];
}

function writeFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (error) {
    throw new CliError('output-failed', `Cannot write ${filePath}: ${error instanceof Error ? error.message : String(error)}`, 'Check output directory permissions.', 1);
  }
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function tsvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

function writeTsv(filePath, header, rows) {
  const lines = [header.map(tsvCell).join('\t'), ...rows.map((row) => row.map(tsvCell).join('\t'))];
  writeFile(filePath, `${lines.join('\n')}\n`);
}

function flattenMetrics(value, prefix = '') {
  const rows = [];
  if (Array.isArray(value)) return rows;
  if (value === null || value === undefined) {
    if (prefix) rows.push([prefix, null]);
    return rows;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      rows.push(...flattenMetrics(value[key], prefix ? `${prefix}.${key}` : key));
    }
    return rows;
  }
  rows.push([prefix, value]);
  return rows;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function manifestPython(resolved, engineResult) {
  return {
    command: resolved.python.command,
    path: engineResult.python?.executable || resolved.python.path,
    version: engineResult.python?.version || resolved.python.version,
    source: resolved.python.source,
  };
}

function writeManifest({ argv, commandName, inputs, parameters, python, outputDir, outputFiles, createdAt }) {
  const outputs = outputFiles.map((file) => {
    const stat = fs.statSync(file);
    return { path: file, sha256: sha256File(file), bytes: stat.size };
  });
  const manifest = {
    schema_version: SCHEMA_VERSION,
    tool: { name: 'bio-qc', version: VERSION },
    command_name: commandName,
    command: ['bio-qc', ...argv],
    command_line: ['bio-qc', ...argv].map(shellQuote).join(' '),
    created_at: createdAt,
    python,
    inputs,
    parameters,
    output_dir: outputDir,
    outputs,
    environment: { platform: process.platform, node: process.version },
  };
  const manifestPath = path.join(outputDir, 'manifest.json');
  writeJson(manifestPath, manifest);
  return manifestPath;
}

function fastqSummary(combined) {
  return {
    reads: combined.reads,
    bases: combined.bases,
    read_pairs: combined.read_pairs ?? null,
    q20_ratio: combined.q20_ratio,
    q30_ratio: combined.q30_ratio,
    gc_pct: combined.gc_pct,
    n_pct: combined.n_pct,
    mean_length: combined.mean_length,
    min_length: combined.min_length,
    max_length: combined.max_length,
  };
}

function fastqTsv(files, combined) {
  const header = ['file', 'reads', 'bases', 'q20_ratio', 'q30_ratio', 'gc_pct', 'n_pct', 'mean_length', 'min_length', 'max_length'];
  const row = (label, metrics) => [label, metrics.reads, metrics.bases, metrics.q20_ratio, metrics.q30_ratio, metrics.gc_pct, metrics.n_pct, metrics.mean_length, metrics.min_length, metrics.max_length];
  return {
    header,
    rows: [...files.map((file) => row(file.path, file)), row('combined', combined)],
  };
}

function fastqCommand(argv, values, io) {
  const read1 = path.resolve(values.input);
  ensureReadableFile(read1, '--input');
  const read2 = values.input2 ? path.resolve(values.input2) : null;
  if (read2) ensureReadableFile(read2, '--input2');
  const output = inspectOutput(values.output);
  const inputs = [{ role: 'r1', path: read1, compression: detectCompression(read1) }];
  if (read2) inputs.push({ role: 'r2', path: read2, compression: detectCompression(read2) });
  const parameters = { paired: Boolean(read2), quality_encoding: 'phred+33', length_distribution_limit: 20 };
  if (values['dry-run']) {
    const resolved = resolvePython();
    const result = {
      schema_version: SCHEMA_VERSION,
      command: 'fastq',
      planned: true,
      input: { reads: inputs },
      output_dir: output.path,
      planned_files: plannedFiles(output.path),
      parameters,
      python: pythonPlan(resolved),
      warnings: planWarnings(resolved),
      note: DRY_RUN_NOTE,
    };
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const resolved = requirePython();
  const engineResult = runEngine(resolved.python, {
    command: 'fastq',
    inputs: inputs.map((input) => ({ role: input.role, path: input.path })),
    length_distribution_limit: 20,
  });
  const createdAt = new Date().toISOString();
  const python = manifestPython(resolved, engineResult);
  const qc = {
    schema_version: SCHEMA_VERSION,
    command: 'fastq',
    created_at: createdAt,
    tool: { name: 'bio-qc', version: VERSION },
    python,
    parameters,
    inputs: engineResult.files.map((file) => ({ role: file.role, path: file.path, sha256: file.sha256, bytes: file.bytes })),
    files: engineResult.files,
    combined: engineResult.combined,
    warnings: engineResult.warnings || [],
  };
  const qcJsonPath = path.join(output.path, 'qc.json');
  const qcTsvPath = path.join(output.path, 'qc.tsv');
  ensureOutputDir(output.path);
  writeJson(qcJsonPath, qc);
  const table = fastqTsv(engineResult.files, engineResult.combined);
  writeTsv(qcTsvPath, table.header, table.rows);
  const manifestPath = writeManifest({
    argv,
    commandName: 'fastq',
    inputs: qc.inputs,
    parameters,
    python,
    outputDir: output.path,
    outputFiles: [qcJsonPath, qcTsvPath],
    createdAt,
  });
  const result = {
    schema_version: SCHEMA_VERSION,
    command: 'fastq',
    planned: false,
    input: {
      read1: { path: engineResult.files[0].path, sha256: engineResult.files[0].sha256, bytes: engineResult.files[0].bytes, reads: engineResult.files[0].reads, compression: engineResult.files[0].compression },
      read2: engineResult.files[1] ? { path: engineResult.files[1].path, sha256: engineResult.files[1].sha256, bytes: engineResult.files[1].bytes, reads: engineResult.files[1].reads, compression: engineResult.files[1].compression } : null,
    },
    output_dir: output.path,
    outputs: { qc_json: qcJsonPath, qc_tsv: qcTsvPath, manifest: manifestPath },
    summary: fastqSummary(engineResult.combined),
    warnings: engineResult.warnings || [],
  };
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

function bamCommand(argv, values, io) {
  const input = path.resolve(values.input);
  ensureReadableFile(input, '--input');
  const output = inspectOutput(values.output);
  const parameters = { coverage_method: 'aligned_query_bases_over_reference_length' };
  if (values['dry-run']) {
    const resolved = resolvePython();
    const result = {
      schema_version: SCHEMA_VERSION,
      command: 'bam',
      planned: true,
      input: { path: input },
      output_dir: output.path,
      planned_files: plannedFiles(output.path),
      parameters,
      python: pythonPlan(resolved),
      warnings: planWarnings(resolved),
      note: DRY_RUN_NOTE,
    };
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const resolved = requirePython();
  const engineResult = runEngine(resolved.python, { command: 'bam', input: { path: input } });
  const fingerprint = fingerprintPath(input);
  const createdAt = new Date().toISOString();
  const python = manifestPython(resolved, engineResult);
  const metrics = engineResult.metrics || {};
  const qc = {
    schema_version: SCHEMA_VERSION,
    command: 'bam',
    created_at: createdAt,
    tool: { name: 'bio-qc', version: VERSION },
    python,
    pysam: engineResult.pysam || null,
    parameters,
    inputs: fingerprint,
    metrics,
    warnings: engineResult.warnings || [],
  };
  const qcJsonPath = path.join(output.path, 'qc.json');
  const qcTsvPath = path.join(output.path, 'qc.tsv');
  ensureOutputDir(output.path);
  writeJson(qcJsonPath, qc);
  writeTsv(qcTsvPath, ['section', 'metric', 'value'], flattenMetrics(metrics, 'bam'));
  const manifestPath = writeManifest({
    argv,
    commandName: 'bam',
    inputs: fingerprint,
    parameters,
    python,
    outputDir: output.path,
    outputFiles: [qcJsonPath, qcTsvPath],
    createdAt,
  });
  const summary = {
    total_reads: metrics.total_reads,
    mapped_reads: metrics.mapped_reads,
    mapped_ratio: metrics.mapped_ratio,
    duplicate_ratio: metrics.duplicate_ratio,
    properly_paired_ratio: metrics.properly_paired_ratio,
    average_insert_size: metrics.average_insert_size,
    average_read_length: metrics.average_read_length,
    reference_count: metrics.reference_count,
    mean_coverage: metrics.mean_coverage,
    genome_coverage: metrics.genome_coverage,
  };
  const result = {
    schema_version: SCHEMA_VERSION,
    command: 'bam',
    planned: false,
    input: { path: input, sha256: fingerprint[0]?.sha256 ?? null, bytes: fingerprint[0]?.bytes ?? null },
    output_dir: output.path,
    outputs: { qc_json: qcJsonPath, qc_tsv: qcTsvPath, manifest: manifestPath },
    summary,
    warnings: engineResult.warnings || [],
  };
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

function classifyMatrix(input) {
  let stat;
  try {
    stat = fs.statSync(input);
  } catch (error) {
    throw new CliError('invalid-input', `Matrix input does not exist: ${input}`, `Check the path (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (stat.isDirectory()) return 'mtx-dir';
  if (!stat.isFile()) throw new CliError('invalid-input', `Matrix input is not a file or directory: ${input}`, 'Pass a .h5ad file, a 10x mtx directory, or a .csv/.tsv/.txt matrix.');
  const extension = path.extname(input).toLowerCase();
  if (extension === '.h5ad' || extension === '.h5') return 'h5ad';
  if (extension === '.csv') return 'csv';
  if (extension === '.tsv' || extension === '.tab') return 'tsv';
  if (extension === '.txt') return sniffDelimited(input);
  throw new CliError('invalid-input', `Cannot infer matrix type from extension '${extension || '(none)'}': ${input}`, 'Use .h5ad, a 10x mtx directory, .csv, .tsv, .tab, or .txt.');
}

function sniffDelimited(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytes).toString('utf8');
    const tabs = (head.match(/\t/g) || []).length;
    const commas = (head.match(/,/g) || []).length;
    return tabs > commas ? 'tsv' : 'csv';
  } catch {
    return 'csv';
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function matrixSummary(metrics) {
  return {
    input_type: metrics.input_type,
    cells: metrics.cells,
    genes: metrics.genes,
    total_counts: metrics.total_counts,
    median_counts_per_cell: metrics.counts_per_cell?.median ?? null,
    median_genes_detected: metrics.genes_detected_per_cell?.median ?? null,
    pct_mito_median: metrics.pct_mito?.per_cell?.median ?? null,
    cells_over_20pct_mito: metrics.pct_mito?.cells_over_threshold ?? null,
    mito_gene_count: metrics.pct_mito?.gene_count ?? 0,
  };
}

function matrixCommand(argv, values, io) {
  const input = path.resolve(values.input);
  const inputType = classifyMatrix(input);
  const output = inspectOutput(values.output);
  const parameters = { input_type: inputType, mito_prefix: 'MT-' };
  if (values['dry-run']) {
    const resolved = resolvePython();
    const result = {
      schema_version: SCHEMA_VERSION,
      command: 'matrix',
      planned: true,
      input: { path: input, type: inputType },
      output_dir: output.path,
      planned_files: plannedFiles(output.path),
      parameters,
      python: pythonPlan(resolved),
      warnings: planWarnings(resolved),
      note: DRY_RUN_NOTE,
    };
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const resolved = requirePython();
  const engineResult = runEngine(resolved.python, { command: 'matrix', input: { path: input, type: inputType } });
  const fingerprint = fingerprintPath(input);
  const createdAt = new Date().toISOString();
  const python = manifestPython(resolved, engineResult);
  const metrics = engineResult.metrics || {};
  const qc = {
    schema_version: SCHEMA_VERSION,
    command: 'matrix',
    created_at: createdAt,
    tool: { name: 'bio-qc', version: VERSION },
    python,
    parameters,
    input: { path: input, type: inputType },
    inputs: fingerprint,
    metrics,
    warnings: engineResult.warnings || [],
  };
  const qcJsonPath = path.join(output.path, 'qc.json');
  const qcTsvPath = path.join(output.path, 'qc.tsv');
  ensureOutputDir(output.path);
  writeJson(qcJsonPath, qc);
  writeTsv(qcTsvPath, ['section', 'metric', 'value'], flattenMetrics(metrics, 'matrix'));
  const manifestPath = writeManifest({
    argv,
    commandName: 'matrix',
    inputs: fingerprint,
    parameters,
    python,
    outputDir: output.path,
    outputFiles: [qcJsonPath, qcTsvPath],
    createdAt,
  });
  const result = {
    schema_version: SCHEMA_VERSION,
    command: 'matrix',
    planned: false,
    input: { path: input, type: inputType, files: fingerprint },
    output_dir: output.path,
    outputs: { qc_json: qcJsonPath, qc_tsv: qcTsvPath, manifest: manifestPath },
    summary: matrixSummary(metrics),
    warnings: engineResult.warnings || [],
  };
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

export async function main(argv, io = process) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) {
      allowed(values, ['version'], undefined);
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (values.describe && !command) {
      allowed(values, ['describe', 'format'], undefined);
      validateFormat(values);
      io.stdout.write(`${JSON.stringify(description)}\n`);
      return 0;
    }
    if (!command) {
      allowed(values, ['help'], undefined);
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (!description.commands[command]) {
      throw new CliError('unknown-command', `Unknown command: ${command}.`, "Run 'bio-qc --help' to list commands.");
    }
    if (values.help) {
      io.stdout.write(`${usage(command)}\n`);
      return 0;
    }
    if (command === 'check') {
      allowed(values, ['format'], command);
      validateFormat(values);
      return checkCommand(io);
    }
    if (command === 'fastq') {
      allowed(values, ['input', 'input2', 'output', 'dry-run', 'format'], command);
      validateFormat(values);
      if (!values.input) throw new CliError('missing-input', "--input is required for 'bio-qc fastq'.", "Run 'bio-qc fastq --help'.");
      if (!values.output) throw new CliError('missing-input', "--output is required for 'bio-qc fastq'.", "Run 'bio-qc fastq --help'.");
      return fastqCommand(argv, values, io);
    }
    if (command === 'bam') {
      allowed(values, ['input', 'output', 'dry-run', 'format'], command);
      validateFormat(values);
      if (!values.input) throw new CliError('missing-input', "--input is required for 'bio-qc bam'.", "Run 'bio-qc bam --help'.");
      if (!values.output) throw new CliError('missing-input', "--output is required for 'bio-qc bam'.", "Run 'bio-qc bam --help'.");
      return bamCommand(argv, values, io);
    }
    if (command === 'matrix') {
      allowed(values, ['input', 'output', 'dry-run', 'format'], command);
      validateFormat(values);
      if (!values.input) throw new CliError('missing-input', "--input is required for 'bio-qc matrix'.", "Run 'bio-qc matrix --help'.");
      if (!values.output) throw new CliError('missing-input', "--output is required for 'bio-qc matrix'.", "Run 'bio-qc matrix --help'.");
      return matrixCommand(argv, values, io);
    }
    throw new CliError('unknown-command', `Unknown command: ${command}.`, "Run 'bio-qc --help' to list commands.");
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError('internal-error', error instanceof Error ? error.message : String(error), "Run 'bio-qc --help'; set BIO_QC_DEBUG=1 for a stack trace.", 1);
    if (!(error instanceof CliError) && process.env.BIO_QC_DEBUG && error instanceof Error && error.stack) {
      io.stderr.write(`${error.stack}\n`);
    }
    io.stderr.write(`${JSON.stringify({
      schema_version: SCHEMA_VERSION,
      error: { code: cliError.code, message: cliError.message, hint: cliError.hint },
    })}\n`);
    return cliError.exitCode;
  }
}
