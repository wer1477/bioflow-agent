import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CommandError, createRunner } from './runner.js';

const VERSION = '0.1.0';
const GENOME_INCLUDES = ['genome', 'rna', 'protein', 'cds', 'gff3', 'gtf', 'gbff', 'seq-report', 'all', 'none'];
const DEFAULT_GENOME_INCLUDES = ['genome', 'gff3', 'protein', 'cds'];
const MAX_THREADS = 16;
const GIB = 1024 ** 3;

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-fetch',
  version: VERSION,
  default_format: 'json',
  exit_codes: { '0': 'success', '1': 'dependency, upstream, or system failure', '2': 'usage or input error' },
  commands: {
    genome: {
      description: 'Download an NCBI Assembly or BioProject genome data package as a ZIP archive and write a provenance manifest beside it.',
      side_effects: 'Writes only the explicit --output ZIP and <output>.bio-fetch.json. Existing targets are refused; --dry-run performs no tool invocation or write.',
      options: {
        accession: { type: 'string', required: true, description: 'NCBI Assembly (GCA_/GCF_) or BioProject (PRJNA/PRJEB/PRJDB) accession.' },
        include: { type: 'string[]', default: DEFAULT_GENOME_INCLUDES, enum: GENOME_INCLUDES, description: 'Comma-separated package content, for example genome,gff3,protein,cds.' },
        output: { type: 'path', required: true, description: 'New .zip output path.' },
        'dry-run': { type: 'boolean', default: false },
      },
      output: 'GenomeFetchResult',
    },
    sra: {
      description: 'Prefetch one public SRA run and convert it to split FASTQ files in a new output directory.',
      side_effects: 'Writes a new explicit --output directory containing sra/, fastq/, and manifest.json. Existing directories are refused; --dry-run performs no tool invocation or write.',
      options: {
        accession: { type: 'string', required: true, description: 'Public SRA run accession: SRR, ERR, or DRR.' },
        output: { type: 'path', required: true, description: 'New output directory.' },
        threads: { type: 'integer', default: 2, min: 1, max: MAX_THREADS },
        'max-disk-gib': { type: 'integer', default: 100, min: 1, max: 2000, description: 'Minimum free-space guardrail required before conversion; actual output is recorded and checked after each stage.' },
        'dry-run': { type: 'boolean', default: false },
      },
      output: 'SraFetchResult',
    },
  },
  schemas: {
    GenomeFetchResult: { type: 'object', required: ['schema_version', 'planned', 'accession', 'include', 'output', 'manifest', 'command'], properties: { schema_version: { const: 1 }, planned: { type: 'boolean' }, accession: { type: 'string' }, include: { type: 'array', items: { type: 'string' } }, output: { type: 'string' }, manifest: { type: 'string' }, command: { type: 'array', items: { type: 'string' } }, bytes_written: { type: ['integer', 'null'] }, sha256: { type: ['string', 'null'] }, tool_version: { type: ['string', 'null'] } } },
    SraFetchResult: { type: 'object', required: ['schema_version', 'planned', 'accession', 'output', 'manifest', 'commands', 'threads', 'max_disk_gib'], properties: { schema_version: { const: 1 }, planned: { type: 'boolean' }, accession: { type: 'string' }, output: { type: 'string' }, manifest: { type: 'string' }, commands: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, threads: { type: 'integer' }, max_disk_gib: { type: 'integer' }, artifacts: { type: 'array' }, tool_versions: { type: ['object', 'null'] } } },
    Error: { type: 'object', required: ['schema_version', 'error'], properties: { schema_version: { const: 1 }, error: { type: 'object', required: ['code', 'message', 'hint'] } } },
  },
};

function usage(command) {
  if (!command) return 'Usage: bio-fetch <command> [options]\n\n  genome   Download an NCBI genome data-package ZIP.\n  sra      Prefetch one public SRA run and convert it to split FASTQ.\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the CLI version\n  -h, --help                 Print help';
  if (command === 'genome') return 'Usage: bio-fetch genome --accession GCF_000001405.40 --output PATH.zip [--include genome,gff3,protein,cds] [--dry-run] [--format json]\n\nRequires the NCBI datasets executable. The ZIP and its adjacent provenance manifest are the only created artifacts.';
  return 'Usage: bio-fetch sra --accession SRR123456 --output PATH [--threads 2] [--max-disk-gib 100] [--dry-run] [--format json]\n\nRequires prefetch and fasterq-dump from the SRA Toolkit. --output must not already exist.';
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

function required(values, key) {
  if (!values[key]) throw new CliError('missing-input', `--${key} is required.`);
  return values[key];
}

function positiveInteger(value, key, fallback, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new CliError('invalid-input', `--${key} must be an integer from 1 to ${max}.`);
  return result;
}

function outputPath(value, type) {
  const result = path.resolve(value);
  if (result === path.parse(result).root) throw new CliError('invalid-input', `--output must name a ${type}, not a filesystem root.`);
  return result;
}

function genomeRequest(values) {
  const accession = required(values, 'accession').toUpperCase();
  if (!/^(?:GC[AF]_\d{9}(?:\.\d+)?|PRJ(?:NA|EB|DB)\d+)$/i.test(accession)) throw new CliError('invalid-input', '--accession must be an NCBI Assembly (GCA_/GCF_) or BioProject (PRJNA/PRJEB/PRJDB) accession.');
  const output = outputPath(required(values, 'output'), 'ZIP file');
  if (!output.toLowerCase().endsWith('.zip')) throw new CliError('invalid-input', '--output for genome must end in .zip.');
  const include = [...new Set(String(values.include || DEFAULT_GENOME_INCLUDES.join(',')).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (!include.length || include.some((item) => !GENOME_INCLUDES.includes(item))) throw new CliError('invalid-input', `--include must contain only: ${GENOME_INCLUDES.join(', ')}.`);
  if ((include.includes('all') || include.includes('none')) && include.length > 1) throw new CliError('invalid-input', '--include all and --include none cannot be combined with other values.');
  const command = ['datasets', 'download', 'genome', 'accession', accession, '--include', include.join(','), '--filename'];
  return { accession, include, output, manifest: `${output}.bio-fetch.json`, command };
}

function sraRequest(values) {
  const accession = required(values, 'accession').toUpperCase();
  if (!/^(?:SRR|ERR|DRR)\d+$/i.test(accession)) throw new CliError('invalid-input', '--accession must be a public SRA run accession beginning SRR, ERR, or DRR.');
  const output = outputPath(required(values, 'output'), 'directory');
  const threads = positiveInteger(values.threads, 'threads', 2, MAX_THREADS);
  const maxDiskGib = positiveInteger(values['max-disk-gib'], 'max-disk-gib', 100, 2000);
  return { accession, output, manifest: path.join(output, 'manifest.json'), threads, maxDiskGib };
}

async function exists(target, files = fs) {
  try { await files.access(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function ensureNewTargets(targets, files = fs) {
  for (const target of targets) if (await exists(target, files)) throw new CliError('output-exists', `Refusing to overwrite existing output: ${target}. Choose a new --output path.`);
}

function temporary(target) {
  return `${target}.bio-fetch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.partial`;
}

async function checksum(file, files = fs) {
  const data = await files.readFile(file);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function fileArtifact(file, files = fs) {
  const stat = await files.stat(file);
  return { path: file, bytes: stat.size, sha256: await checksum(file, files) };
}

async function filesUnder(directory, files = fs) {
  const result = [];
  async function walk(current) {
    for (const entry of await files.readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  await walk(directory);
  return result.sort();
}

async function directoryBytes(directory, files = fs) {
  let bytes = 0;
  for (const item of await filesUnder(directory, files)) bytes += (await files.stat(item)).size;
  return bytes;
}

async function freeBytes(directory, files = fs) {
  const stat = await files.statfs(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}

async function toolVersion(runner, command) {
  const result = await runner.run(command, ['--version']);
  return result.stdout || result.stderr || null;
}

async function writeJson(target, content, files = fs) {
  const temp = temporary(target);
  try {
    await files.writeFile(temp, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
    await files.rename(temp, target);
  } catch (error) {
    await files.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function runGenome(request, { runner, files }) {
  await ensureNewTargets([request.output, request.manifest], files);
  await files.mkdir(path.dirname(request.output), { recursive: true });
  const partial = temporary(request.output);
  const command = [...request.command, partial, '--no-progressbar'];
  try {
    const version = await toolVersion(runner, 'datasets');
    await runner.run(command[0], command.slice(1));
    const artifact = await fileArtifact(partial, files);
    await files.rename(partial, request.output);
    const manifest = { schema_version: 1, tool: { name: 'datasets', version }, fetched_at: new Date().toISOString(), accession: request.accession, include: request.include, command, artifact: { ...artifact, path: request.output } };
    await writeJson(request.manifest, manifest, files);
    return { schema_version: 1, planned: false, accession: request.accession, include: request.include, output: request.output, manifest: request.manifest, command, bytes_written: artifact.bytes, sha256: artifact.sha256, tool_version: version };
  } catch (error) {
    await files.rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

async function findSra(directory, files = fs) {
  const matches = (await filesUnder(directory, files)).filter((item) => /\.sra(?:lite)?$/i.test(item));
  if (matches.length !== 1) throw new CliError('unexpected-output', `prefetch produced ${matches.length} SRA files; expected exactly one for this run.` , 1);
  return matches[0];
}

async function runSra(request, { runner, files, freeSpace }) {
  await ensureNewTargets([request.output], files);
  await files.mkdir(path.dirname(request.output), { recursive: true });
  const available = await freeSpace(path.dirname(request.output));
  const requiredBytes = request.maxDiskGib * GIB;
  if (available < requiredBytes) throw new CliError('insufficient-disk', `Only ${(available / GIB).toFixed(1)} GiB is free near --output; --max-disk-gib requires ${request.maxDiskGib} GiB.`, 1);
  const partial = temporary(request.output);
  const sraDirectory = path.join(partial, 'sra');
  const fastqDirectory = path.join(partial, 'fastq');
  // SRA Toolkit requires the final prefetch directory to retain the run accession.
  const prefetch = ['prefetch', '--output-directory', path.join(sraDirectory, request.accession), request.accession];
  let fasterq;
  try {
    await files.mkdir(partial, { recursive: false });
    const versions = { prefetch: await toolVersion(runner, 'prefetch'), fasterq_dump: await toolVersion(runner, 'fasterq-dump') };
    await runner.run(prefetch[0], prefetch.slice(1));
    if (await directoryBytes(partial, files) > requiredBytes) throw new CliError('disk-limit-exceeded', `prefetch output exceeded the ${request.maxDiskGib} GiB guardrail.`, 1);
    const source = await findSra(sraDirectory, files);
    fasterq = ['fasterq-dump', '--split-files', '--skip-technical', '--threads', String(request.threads), '--outdir', fastqDirectory, source];
    await runner.run(fasterq[0], fasterq.slice(1));
    if (await directoryBytes(partial, files) > requiredBytes) throw new CliError('disk-limit-exceeded', `FASTQ output exceeded the ${request.maxDiskGib} GiB guardrail.`, 1);
    const artifactPaths = (await filesUnder(fastqDirectory, files)).filter((item) => /\.fastq$/i.test(item));
    if (!artifactPaths.length) throw new CliError('unexpected-output', 'fasterq-dump completed without producing FASTQ files.', 1);
    const artifacts = await Promise.all(artifactPaths.map((item) => fileArtifact(item, files)));
    const manifest = { schema_version: 1, tools: versions, fetched_at: new Date().toISOString(), accession: request.accession, threads: request.threads, max_disk_gib: request.maxDiskGib, commands: [prefetch, fasterq], source_sra: await fileArtifact(source, files), artifacts: artifacts.map((artifact) => ({ ...artifact, path: path.relative(partial, artifact.path) })) };
    await writeJson(path.join(partial, 'manifest.json'), manifest, files);
    await files.rename(partial, request.output);
    const outputArtifacts = artifacts.map((artifact) => ({ ...artifact, path: path.join(request.output, path.relative(partial, artifact.path)) }));
    return { schema_version: 1, planned: false, accession: request.accession, output: request.output, manifest: request.manifest, commands: [prefetch, fasterq], threads: request.threads, max_disk_gib: request.maxDiskGib, artifacts: outputArtifacts, tool_versions: versions };
  } catch (error) {
    await files.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function main(argv, io = process, { runner = createRunner(), files = fs, freeSpace = freeBytes } = {}) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { allowed(values, ['describe', 'format']); validateFormat(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-fetch --help'.`);
    validateFormat(values);
    const keys = command === 'genome' ? ['accession', 'include', 'output', 'dry-run', 'format'] : ['accession', 'output', 'threads', 'max-disk-gib', 'dry-run', 'format'];
    allowed(values, keys);
    const request = command === 'genome' ? genomeRequest(values) : sraRequest(values);
    if (values['dry-run']) {
      const output = command === 'genome'
        ? { schema_version: 1, planned: true, accession: request.accession, include: request.include, output: request.output, manifest: request.manifest, command: [...request.command, request.output, '--no-progressbar'], bytes_written: null, sha256: null, tool_version: null }
        : { schema_version: 1, planned: true, accession: request.accession, output: request.output, manifest: request.manifest, commands: [['prefetch', '--output-directory', path.join(request.output, 'sra', request.accession), request.accession], ['fasterq-dump', '--split-files', '--skip-technical', '--threads', String(request.threads), '--outdir', path.join(request.output, 'fastq'), '<prefetched-sra-file>']], threads: request.threads, max_disk_gib: request.maxDiskGib, artifacts: [], tool_versions: null };
      io.stdout.write(`${JSON.stringify(output)}\n`);
      return 0;
    }
    const output = command === 'genome' ? await runGenome(request, { runner, files }) : await runSra(request, { runner, files, freeSpace });
    io.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : error instanceof CommandError ? new CliError('command-failed', error.message, 1) : new CliError('system', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: "run 'bio-fetch --help'" } })}\n`);
    return cliError.exitCode;
  }
}
