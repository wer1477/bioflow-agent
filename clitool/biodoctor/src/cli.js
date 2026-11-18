import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChecker, inspectProfile, profileSummary } from './doctor.js';

const VERSION = '0.1.0';
const profilesFile = new URL('../profiles.json', import.meta.url);
const profiles = JSON.parse(fs.readFileSync(fileURLToPath(profilesFile), 'utf8')).profiles;

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-doctor',
  version: VERSION,
  default_format: 'json',
  exit_codes: { '0': 'diagnostic completed, including partial or server-required profiles', '1': 'system failure', '2': 'usage or input error' },
  commands: {
    profiles: { description: 'List declared Bioagent capability profiles without probing the environment.', options: {}, output: 'ProfilePage' },
    check: { description: 'Probe one or all local capability profiles. This command never installs software or connects to remote hosts.', options: { profile: { type: 'string', enum: profiles.map((item) => item.id) } }, output: 'DiagnosticReport | DiagnosticPage' },
  },
};

function usage(command) {
  if (!command) return 'Usage: bio-doctor <command> [options]\n\n  profiles   List declared capability profiles.\n  check      Probe one or all local profiles.\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the version\n  -h, --help                 Print help';
  if (command === 'profiles') return 'Usage: bio-doctor profiles [--format json]';
  return 'Usage: bio-doctor check [--profile PROFILE] [--format json]\n\nMissing software is reported in JSON; this command does not install software or connect to lab servers.';
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
    if (['help', 'describe', 'version'].includes(key)) {
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

function format(values) {
  if (values.format && values.format !== 'json') throw new CliError('invalid-input', '--format must be json.');
}

function selectedProfiles(profileId) {
  if (!profileId) return profiles;
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new CliError('unknown-profile', `Unknown profile: ${profileId}. Run bio-doctor profiles.`, 2);
  return [profile];
}

export async function main(argv, io = process, { checker = createChecker() } = {}) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { allowed(values, ['describe', 'format']); format(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run bio-doctor --help.`);
    if (command === 'profiles') {
      allowed(values, ['format']); format(values);
      io.stdout.write(`${JSON.stringify({ schema_version: 1, items: profiles.map(profileSummary) })}\n`);
      return 0;
    }
    allowed(values, ['profile', 'format']); format(values);
    const reports = selectedProfiles(values.profile).map((profile) => inspectProfile(profile, checker));
    const result = reports.length === 1
      ? reports[0]
      : { schema_version: 1, items: reports, status: reports.every((item) => item.status === 'available') ? 'available' : 'partial' };
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const item = error instanceof CliError ? error : new CliError('system', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: item.code, message: item.message, hint: "run 'bio-doctor --help'" } })}\n`);
    return item.exitCode;
  }
}
