import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SPEC } from './spec.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');
const BIOENV_BIN = path.join(REPO_ROOT, '.bioenv', 'bin');

export class CliError extends Error {
  constructor(code, message, exitCode = 2, hint = `run '${SPEC.name} --help'`) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export const description = {
  schema_version: 1,
  name: SPEC.name,
  version: SPEC.version,
  default_format: 'json',
  exit_codes: { 0: 'success', 1: 'runtime or dependency failure', 2: 'usage or input error' },
  commands: SPEC.commands,
  schemas: {
    CheckResult: { type: 'object', required: ['ok', 'available', 'missing'] },
    PlanResult: { type: 'object', required: ['ok', 'planned', 'steps'] },
    RunResult: { type: 'object', required: ['ok', 'outputs', 'summary'] },
    Error: { type: 'object', required: ['schema_version', 'error'] },
  },
};

function usage(command) {
  const lines = [`Usage: ${SPEC.name} <command> [options]`, ''];
  lines.push('  check   Report which external tools are available.');
  lines.push('  plan    Print the commands that would run (no side effects).');
  lines.push('  run     Validate dependencies, then execute the planned commands.');
  lines.push('');
  lines.push('Global options:');
  lines.push('  --describe --format json   Print the machine-readable command registry');
  lines.push('  --version                  Print the CLI version');
  lines.push('  -h, --help                 Print help');
  if (command && SPEC.usage[command]) lines.push('', SPEC.usage[command]);
  return lines.join('\n');
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

function runtimeEnv() {
  const pathEntries = [process.env.BIOAGENT_ENV_BIN, BIOENV_BIN, process.env.PATH].filter(Boolean);
  return { ...process.env, PATH: pathEntries.join(path.delimiter) };
}

export function toolAvailable(tool) {
  const probe = spawnSync('/bin/sh', ['-lc', `command -v ${tool}`], { env: runtimeEnv(), encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function checkCommand() {
  const available = [];
  const missing = [];
  for (const tool of SPEC.tools) (toolAvailable(tool) ? available : missing).push(tool);
  const report = {
    ok: SPEC.nativeReady(available),
    available,
    missing,
    engines: { native: SPEC.nativeReady(available), docker: available.includes('docker') },
  };
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ...report })}\n`);
  return report.ok ? 0 : 1;
}

function planned(values) {
  allowed(values, ['plan', 'run', ...SPEC.optionKeys, 'dry-run', 'format']);
  validateFormat(values);
  let params;
  try {
    params = SPEC.parse(values);
  } catch (error) {
    throw new CliError('invalid-input', error instanceof Error ? error.message : String(error));
  }
  return { params, plan: SPEC.buildPlan(params) };
}

function planCommand(values) {
  const { plan } = planned(values);
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ok: true, planned: true, ...plan })}\n`);
  return 0;
}

function runCommand(values) {
  const { params, plan } = planned(values);
  const available = new Set(SPEC.tools.filter(toolAvailable));
  const required = [...new Set(plan.steps.flatMap((step) => step.requires || []))];
  const missing = required.filter((tool) => !available.has(tool));
  if (missing.length) {
    throw new CliError(
      'missing-tools',
      `missing required tools: ${missing.join(', ')}`,
      1,
      `run '${SPEC.name} check --format json'; install the tools or use --engine docker`,
    );
  }
  if (params.engine === 'docker') {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, ok: true, planned: true, engine: 'docker', ...plan })}\n`);
    return 0;
  }
  fs.mkdirSync(params.output, { recursive: true });
  // The plan references subdirectories (qc/, align/, counts/, ...); create them before
  // any step runs so tools that do not create their own output parents still work.
  for (const step of plan.steps) {
    for (const arg of step.command) {
      if (typeof arg !== 'string' || !arg.startsWith(`${params.output}${path.sep}`)) continue;
      const parent = path.dirname(arg);
      if (parent !== params.output) fs.mkdirSync(parent, { recursive: true });
    }
  }
  const log = [];
  for (const step of plan.steps) {
    process.stderr.write(`[${SPEC.name}] ${step.name}: ${step.command.join(' ')}\n`);
    const result = spawnSync(step.command[0], step.command.slice(1), { env: runtimeEnv(), encoding: 'utf8' });
    log.push({ name: step.name, command: step.command, status: result.status });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw new CliError('analysis-failed', `${step.name}: ${result.error.message}`, 1);
    if (result.status !== 0) throw new CliError('analysis-failed', `${step.name} exited ${result.status}`, 1);
  }
  const manifest = {
    schema_version: 1,
    tool: { name: SPEC.name, version: SPEC.version },
    parameters: params,
    steps: log,
    created_at: new Date().toISOString(),
  };
  const manifestPath = path.join(params.output, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const logPath = path.join(params.output, 'run.log');
  fs.writeFileSync(logPath, log.map((entry) => `${entry.name}\t${entry.status}\t${entry.command.join(' ')}`).join('\n') + '\n');
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ok: true, outputs: { manifest: manifestPath, log: logPath }, summary: { steps: log.length } })}\n`);
  return 0;
}

export async function main(argv, io = process) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${SPEC.version}\n`); return 0; }
    if (values.describe && !command) {
      allowed(values, ['describe', 'format']);
      validateFormat(values);
      io.stdout.write(`${JSON.stringify(description)}\n`);
      return 0;
    }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!SPEC.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run '${SPEC.name} --help'.`);
    if (command === 'check') {
      allowed(values, ['format']);
      validateFormat(values);
      return checkCommand();
    }
    if (command === 'plan') return planCommand(values);
    if (command === 'run') return runCommand(values);
    throw new CliError('unknown-command', `Unknown command: ${command}.`);
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('upstream', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: cliError.hint } })}\n`);
    return cliError.exitCode;
  }
}
