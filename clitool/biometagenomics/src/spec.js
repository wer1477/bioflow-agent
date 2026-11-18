import fs from 'node:fs';
import path from 'node:path';

const COMMON_OPTIONS = {
  reads: { type: 'string', required: true, description: 'R1.fastq[.gz] or R1,R2 for paired-end.' },
  output: { type: 'path', required: true },
  database: { type: 'path', required: true, description: 'Classifier database directory.' },
  classifier: { type: 'string', enum: ['kaiju', 'kraken2'], default: 'kraken2' },
  assembler: { type: 'string', enum: ['megahit', 'spades'], default: 'megahit' },
  'host-reference': { type: 'path', description: 'Optional host FASTA for read depletion (needs an existing BWA index).' },
  threads: { type: 'integer', default: 4, min: 1 },
  engine: { type: 'string', enum: ['native', 'docker'], default: 'native' },
};

function resolvePath(value) {
  return path.resolve(String(value || ''));
}

function integer(values, key, fallback, min) {
  const value = values[key] === undefined ? fallback : Number(values[key]);
  if (!Number.isInteger(value) || value < min) throw new Error(`--${key} must be an integer >= ${min}.`);
  return value;
}

export const SPEC = {
  name: 'bio-metagenomics',
  version: '0.1.0',
  tools: ['fastp', 'megahit', 'spades.py', 'kaiju', 'kraken2', 'bwa', 'minimap2', 'samtools', 'seqkit', 'taxpasta', 'docker'],
  optionKeys: Object.keys(COMMON_OPTIONS),
  commands: {
    check: { description: 'Report the metagenomics tools available on PATH.', options: { format: { type: 'string', enum: ['json'], default: 'json' } }, output: 'CheckResult' },
    plan: { description: 'Print the QC -> host removal -> assembly -> classification -> standardisation commands.', options: COMMON_OPTIONS, output: 'PlanResult' },
    run: { description: 'Validate dependencies and execute the planned commands.', options: { ...COMMON_OPTIONS, 'dry-run': { type: 'boolean', default: false } }, output: 'RunResult' },
  },
  usage: {
    plan: 'Usage: bio-metagenomics plan --reads R1[,R2] --output DIR --database DIR [--classifier kaiju|kraken2] [--assembler megahit|spades] [--host-reference FASTA]',
    run: 'Usage: bio-metagenomics run --reads R1[,R2] --output DIR --database DIR [--classifier kaiju|kraken2] [--assembler megahit|spades] [--host-reference FASTA]',
  },
  nativeReady(available) {
    const set = new Set(available);
    return set.has('samtools')
      && (set.has('kaiju') || set.has('kraken2'))
      && (set.has('megahit') || set.has('spades.py'));
  },
  parse(values) {
    const reads = String(values.reads || '').split(',').map((entry) => entry.trim()).filter(Boolean).map(resolvePath);
    if (!reads.length) throw new Error('--reads is required.');
    if (reads.length > 2) throw new Error('--reads accepts one or two comma-separated files.');
    for (const file of reads) {
      if (!fs.existsSync(file)) throw new Error(`--reads does not exist: ${file}`);
    }
    if (!values.output) throw new Error('--output is required.');
    if (!values.database) throw new Error('--database is required.');
    const database = resolvePath(values.database);
    if (!fs.existsSync(database)) throw new Error(`--database does not exist: ${database}`);
    const hostReference = values['host-reference'] ? resolvePath(values['host-reference']) : null;
    if (hostReference && !fs.existsSync(hostReference)) throw new Error(`--host-reference does not exist: ${hostReference}`);
    const classifier = String(values.classifier || 'kraken2');
    if (!['kaiju', 'kraken2'].includes(classifier)) throw new Error('--classifier must be kaiju or kraken2.');
    const assembler = String(values.assembler || 'megahit');
    if (!['megahit', 'spades'].includes(assembler)) throw new Error('--assembler must be megahit or spades.');
    if (!['native', 'docker'].includes(String(values.engine || 'native'))) throw new Error('--engine must be native or docker.');
    return {
      reads,
      output: resolvePath(values.output),
      database,
      classifier,
      assembler,
      hostReference,
      threads: integer(values, 'threads', 4, 1),
      engine: String(values.engine || 'native'),
    };
  },
  buildPlan(params) {
    const steps = [];
    const paired = params.reads.length === 2;
    const qc = [path.join(params.output, 'qc', 'R1.fq.gz'), path.join(params.output, 'qc', 'R2.fq.gz')];
    steps.push({
      name: 'trim',
      command: ['fastp', '-i', params.reads[0], ...(paired ? ['-I', params.reads[1]] : []), '-o', qc[0], ...(paired ? ['-O', qc[1]] : []), '--thread', String(params.threads), '--json', path.join(params.output, 'qc', 'fastp.json')],
      requires: ['fastp'],
    });

    let analysisReads = paired ? qc : [qc[0]];
    if (params.hostReference) {
      steps.push({
        name: 'host-align',
        command: ['bwa', 'mem', '-t', String(params.threads), '-o', path.join(params.output, 'host', 'host.sam'), params.hostReference, ...analysisReads],
        requires: ['bwa', 'samtools'],
      });
      steps.push({ name: 'host-filter', command: ['samtools', 'view', '-b', '-f', '4', '-o', path.join(params.output, 'host', 'unmapped.bam'), path.join(params.output, 'host', 'host.sam')], requires: ['samtools'] });
      steps.push({
        name: 'host-split',
        command: ['samtools', 'fastq', '-1', path.join(params.output, 'host', 'clean_R1.fq.gz'), '-2', path.join(params.output, 'host', 'clean_R2.fq.gz'), '-0', '/dev/null', path.join(params.output, 'host', 'unmapped.bam')],
        requires: ['samtools'],
      });
      analysisReads = [path.join(params.output, 'host', 'clean_R1.fq.gz'), path.join(params.output, 'host', 'clean_R2.fq.gz')];
    }

    if (params.assembler === 'megahit') {
      steps.push({
        name: 'assemble',
        command: ['megahit', '-1', analysisReads[0], ...(analysisReads[1] ? ['-2', analysisReads[1]] : []), '-o', path.join(params.output, 'assembly'), '-t', String(params.threads)],
        requires: ['megahit'],
      });
    } else {
      steps.push({
        name: 'assemble',
        command: ['spades.py', '-1', analysisReads[0], ...(analysisReads[1] ? ['-2', analysisReads[1]] : []), '-o', path.join(params.output, 'assembly'), '-t', String(params.threads)],
        requires: ['spades.py'],
      });
    }
    const contigs = params.assembler === 'megahit'
      ? path.join(params.output, 'assembly', 'final.contigs.fa')
      : path.join(params.output, 'assembly', 'contigs.fasta');
    steps.push({ name: 'contig-stats', command: ['seqkit', 'stats', '-a', contigs], requires: ['seqkit'] });

    if (params.classifier === 'kaiju') {
      steps.push({
        name: 'classify',
        command: ['kaiju', '-t', path.join(params.database, 'nodes.dmp'), '-f', path.join(params.database, 'kaiju_db.fmi'), '-i', contigs, '-o', path.join(params.output, 'taxonomy', 'kaiju.out'), '-z', String(params.threads)],
        requires: ['kaiju'],
      });
      steps.push({
        name: 'standardise',
        command: ['taxpasta', 'standardise', '--taxonomy', 'kaiju', '--profile', path.join(params.output, 'taxonomy', 'kaiju.out'), '--output', path.join(params.output, 'taxonomy', 'taxonomy.tsv')],
        requires: ['taxpasta'],
      });
    } else {
      steps.push({
        name: 'classify',
        command: ['kraken2', '--db', params.database, '--threads', String(params.threads), '--output', path.join(params.output, 'taxonomy', 'kraken.out'), '--report', path.join(params.output, 'taxonomy', 'kraken.report'), contigs],
        requires: ['kraken2'],
      });
      steps.push({
        name: 'standardise',
        command: ['taxpasta', 'standardise', '--taxonomy', 'kraken2', '--profile', path.join(params.output, 'taxonomy', 'kraken.report'), '--output', path.join(params.output, 'taxonomy', 'taxonomy.tsv')],
        requires: ['taxpasta'],
      });
    }
    const warnings = [];
    if (params.engine === 'docker') warnings.push('docker engine is a plan-only preview in this release; install native tools to run');
    warnings.push('classification requires a prebuilt database; kaiju expects nodes.dmp + kaiju_db.fmi, kraken2 expects a standard --db directory');
    return { steps, warnings };
  },
};
