import fs from 'node:fs/promises';
import { createClient } from './client.js';

const VERSION = '0.1.0';
const MAX_BLAST_LENGTH = 100_000;
const PROGRAMS = ['blastn', 'blastp'];
const STANDARD_GENETIC_CODE = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L', TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S', TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*', TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
  CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L', CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P', CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q', CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M', ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T', AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K', AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
  GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V', GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A', GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E', GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};
const NUCLEOTIDE = new Set('ACGTURYSWKMBDHVN');
const PROTEIN = new Set('ABCDEFGHIKLMNPQRSTVWXYZ*');

export class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const description = {
  schema_version: 1,
  name: 'bio-seq',
  version: VERSION,
  default_format: 'json',
  exit_codes: { '0': 'success', '1': 'upstream or system failure', '2': 'usage or input error' },
  commands: {
    validate: { description: 'Parse raw or FASTA sequences and report alphabet, length, and validity.', options: { sequence: { type: 'string', conflicts_with: ['input'] }, input: { type: 'path', conflicts_with: ['sequence'] } }, output: 'SequenceValidationResult' },
    translate: { description: 'Translate nucleotide sequences with the standard genetic code.', options: { sequence: { type: 'string', conflicts_with: ['input'] }, input: { type: 'path', conflicts_with: ['sequence'] }, frame: { type: 'integer', enum: [1, 2, 3], default: 1 } }, output: 'TranslationResult' },
    blast: { description: 'Submit one validated nucleotide or protein sequence to NCBI BLAST. Returns an asynchronous RID; it does not poll.', options: { sequence: { type: 'string', conflicts_with: ['input'] }, input: { type: 'path', conflicts_with: ['sequence'] }, program: { type: 'string', enum: PROGRAMS, required: true }, database: { type: 'string', description: 'NCBI BLAST database; defaults to nt for blastn and nr for blastp.' }, 'max-hits': { type: 'integer', default: 10, min: 1, max: 100 }, email: { type: 'string', required: true }, 'dry-run': { type: 'boolean', default: false } }, output: 'BlastSubmission' },
    'blast-status': { description: 'Read the NCBI BLAST status for a previously submitted RID.', options: { rid: { type: 'string', required: true } }, output: 'BlastStatus' },
    'blast-results': { description: 'Retrieve ready NCBI BLAST results as the provider JSONSA report.', options: { rid: { type: 'string', required: true } }, output: 'BlastResults' },
  },
  schemas: {
    SequenceValidationResult: { type: 'object', required: ['schema_version', 'records'], properties: { schema_version: { const: 1 }, records: { type: 'array' } } },
    TranslationResult: { type: 'object', required: ['schema_version', 'frame', 'records'], properties: { schema_version: { const: 1 }, frame: { type: 'integer' }, records: { type: 'array' } } },
    BlastSubmission: { type: 'object', required: ['schema_version', 'planned', 'query'], properties: { schema_version: { const: 1 }, planned: { type: 'boolean' }, query: { type: 'object' }, rid: { type: ['string', 'null'] } } },
    BlastStatus: { type: 'object', required: ['schema_version', 'rid', 'status', 'has_hits'], properties: { schema_version: { const: 1 }, rid: { type: 'string' }, status: { type: 'string' }, has_hits: { type: 'boolean' } } },
    BlastResults: { type: 'object', required: ['schema_version', 'rid', 'report'], properties: { schema_version: { const: 1 }, rid: { type: 'string' }, report: { type: 'object' } } },
  },
};

function usage(command) {
  if (!command) return 'Usage: bio-seq <command> [options]\n\n  validate        Parse and validate raw or FASTA sequence records.\n  translate       Translate nucleotide sequences using the standard genetic code.\n  blast           Submit one sequence to NCBI BLAST and return a RID.\n  blast-status    Read status for a NCBI BLAST RID.\n  blast-results   Retrieve the JSONSA report for a ready RID.\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the CLI version\n  -h, --help                 Print help';
  if (command === 'blast') return 'Usage: bio-seq blast (--sequence SEQUENCE | --input FASTA) --program blastn|blastp --email EMAIL [--database NAME] [--max-hits 10] [--dry-run] [--format json]\n\nSubmits one sequence to NCBI. It returns a RID immediately; wait at least one minute before polling that RID with blast-status.';
  if (command === 'blast-status' || command === 'blast-results') return `Usage: bio-seq ${command} --rid RID [--format json]`;
  return `Usage: bio-seq ${command} (--sequence SEQUENCE | --input FASTA) [--frame 1|2|3] [--format json]`;
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

function cleanSequence(value, label) {
  const sequence = value.replace(/\s+/g, '').toUpperCase();
  if (!sequence) throw new CliError('invalid-input', `${label} is empty.`);
  if (!/^[A-Z*]+$/.test(sequence)) throw new CliError('invalid-input', `${label} contains characters outside the supported sequence alphabets.`);
  return sequence;
}

function record(id, sequence) {
  const characters = [...sequence];
  const nucleotide = characters.every((character) => NUCLEOTIDE.has(character));
  const protein = characters.every((character) => PROTEIN.has(character));
  if (!nucleotide && !protein) throw new CliError('invalid-input', `Sequence ${id} contains unsupported IUPAC symbols.`);
  const type = nucleotide ? 'nucleotide' : 'protein';
  const canonical = type === 'nucleotide' ? new Set('ACGTU') : new Set('ACDEFGHIKLMNPQRSTVWY');
  return { id, sequence, type, length: sequence.length, ambiguous_count: characters.filter((character) => !canonical.has(character)).length };
}

function parseFasta(text) {
  const lines = text.split(/\r?\n/);
  const hasHeaders = lines.some((line) => line.trim().startsWith('>'));
  if (!hasHeaders) return [record('sequence_1', cleanSequence(text, 'Sequence'))];
  const records = [];
  let header = null;
  let sequence = [];
  const finish = () => {
    if (header === null) return;
    records.push(record(header, cleanSequence(sequence.join(''), `Sequence ${header}`)));
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      finish();
      header = line.slice(1).trim().split(/\s+/, 1)[0];
      if (!header) throw new CliError('invalid-input', 'Each FASTA header must include an identifier.');
      sequence = [];
    } else {
      if (header === null) throw new CliError('invalid-input', 'FASTA sequence content must follow a header.');
      sequence.push(line);
    }
  }
  finish();
  if (!records.length) throw new CliError('invalid-input', 'No FASTA records found.');
  return records;
}

async function sequenceRecords(values) {
  if (Boolean(values.sequence) === Boolean(values.input)) throw new CliError('missing-input', 'Provide exactly one of --sequence or --input.');
  let content = values.sequence;
  if (values.input) {
    try {
      content = await fs.readFile(values.input, 'utf8');
    } catch (error) {
      throw new CliError('invalid-input', `Cannot read --input ${values.input}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return parseFasta(content);
}

function frame(values) {
  const result = values.frame === undefined ? 1 : Number(values.frame);
  if (![1, 2, 3].includes(result)) throw new CliError('invalid-input', '--frame must be 1, 2, or 3.');
  return result;
}

function translate(sequence, selectedFrame) {
  const normalized = sequence.replaceAll('U', 'T');
  let protein = '';
  for (let index = selectedFrame - 1; index + 2 < normalized.length; index += 3) protein += STANDARD_GENETIC_CODE[normalized.slice(index, index + 3)] || 'X';
  return protein;
}

function positiveInteger(value, key, fallback, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new CliError('invalid-input', `--${key} must be an integer from 1 to ${max}.`);
  return result;
}

function blastRequest(values, records) {
  if (records.length !== 1) throw new CliError('invalid-input', 'NCBI BLAST submission accepts exactly one sequence record per request.');
  const program = values.program;
  if (!PROGRAMS.includes(program)) throw new CliError('invalid-input', '--program must be blastn or blastp.');
  const item = records[0];
  if ((program === 'blastn') !== (item.type === 'nucleotide')) throw new CliError('invalid-input', `--program ${program} requires a ${program === 'blastn' ? 'nucleotide' : 'protein'} sequence.`);
  if (item.length > MAX_BLAST_LENGTH) throw new CliError('invalid-input', `The BLAST query exceeds the ${MAX_BLAST_LENGTH.toLocaleString()} residue safety limit.`);
  if (!values.email || !/^\S+@\S+\.\S+$/.test(values.email)) throw new CliError('invalid-input', '--email must be a valid contact email required by NCBI BLAST usage guidance.');
  return { sequence: item.sequence, sequence_id: item.id, sequence_type: item.type, program, database: values.database || (program === 'blastn' ? 'nt' : 'nr'), maxHits: positiveInteger(values['max-hits'], 'max-hits', 10, 100), email: values.email };
}

export async function main(argv, io = process, { client = createClient() } = {}) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { allowed(values, ['describe', 'format']); validateFormat(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!description.commands[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'bio-seq --help'.`);
    if (command === 'blast-status' || command === 'blast-results') {
      allowed(values, ['rid', 'format']); validateFormat(values);
      if (!values.rid || !/^[A-Z0-9-]+$/i.test(values.rid)) throw new CliError('invalid-input', '--rid must be a non-empty NCBI BLAST request id.');
      const output = command === 'blast-status' ? await client.blastStatus({ rid: values.rid }) : { rid: values.rid, report: await client.blastResults({ rid: values.rid }) };
      io.stdout.write(`${JSON.stringify({ schema_version: 1, ...output })}\n`);
      return 0;
    }
    const keys = command === 'validate' ? ['sequence', 'input', 'format'] : command === 'translate' ? ['sequence', 'input', 'frame', 'format'] : ['sequence', 'input', 'program', 'database', 'max-hits', 'email', 'dry-run', 'format'];
    allowed(values, keys); validateFormat(values);
    const records = await sequenceRecords(values);
    if (command === 'validate') {
      io.stdout.write(`${JSON.stringify({ schema_version: 1, records: records.map(({ sequence, ...item }) => item) })}\n`);
      return 0;
    }
    if (command === 'translate') {
      const selectedFrame = frame(values);
      for (const item of records) if (item.type !== 'nucleotide') throw new CliError('invalid-input', `Sequence ${item.id} is protein; translate requires nucleotide records.`);
      io.stdout.write(`${JSON.stringify({ schema_version: 1, frame: selectedFrame, records: records.map((item) => ({ id: item.id, input_length: item.length, protein: translate(item.sequence, selectedFrame) })) })}\n`);
      return 0;
    }
    const request = blastRequest(values, records);
    const query = { sequence_id: request.sequence_id, sequence_type: request.sequence_type, sequence_length: request.sequence.length, program: request.program, database: request.database, max_hits: request.maxHits };
    if (values['dry-run']) {
      io.stdout.write(`${JSON.stringify({ schema_version: 1, planned: true, query, rid: null, estimated_wait_seconds: null })}\n`);
      return 0;
    }
    const submission = await client.submitBlast(request);
    io.stdout.write(`${JSON.stringify({ schema_version: 1, planned: false, query, ...submission, next: { command: `bio-seq blast-status --rid ${submission.rid} --format json`, minimum_poll_interval_seconds: 60 } })}\n`);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('upstream', error instanceof Error ? error.message : String(error), 1);
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: "run 'bio-seq --help'" } })}\n`);
    return cliError.exitCode;
  }
}
