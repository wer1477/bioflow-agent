import fs from 'node:fs';
import path from 'node:path';

const COMMON_OPTIONS = {
  reads: { type: 'string', required: true, description: 'R1.fastq[.gz] or R1,R2 for paired-end.' },
  reference: { type: 'path', required: true, description: 'Genome FASTA, aligner index directory, or Salmon index.' },
  annotation: { type: 'path', description: 'GTF/GFF for featureCounts (required for genome aligners).' },
  output: { type: 'path', required: true },
  aligner: { type: 'string', enum: ['star', 'hisat2', 'bwa', 'salmon'], default: 'star' },
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
  name: 'bio-align',
  version: '0.1.0',
  tools: ['fastp', 'fastqc', 'bwa', 'bowtie2', 'hisat2', 'STAR', 'samtools', 'featureCounts', 'salmon', 'docker'],
  optionKeys: Object.keys(COMMON_OPTIONS),
  commands: {
    check: { description: 'Report the alignment/quantification tools available on PATH.', options: { format: { type: 'string', enum: ['json'], default: 'json' } }, output: 'CheckResult' },
    plan: { description: 'Print the fastp -> aligner -> count/quant commands without running them.', options: COMMON_OPTIONS, output: 'PlanResult' },
    run: { description: 'Validate dependencies and execute the planned commands.', options: { ...COMMON_OPTIONS, 'dry-run': { type: 'boolean', default: false } }, output: 'RunResult' },
  },
  usage: {
    plan: 'Usage: bio-align plan --reads R1[,R2] --reference <index|fasta> --output DIR [--annotation GTF] [--aligner star|hisat2|bwa|salmon]',
    run: 'Usage: bio-align run --reads R1[,R2] --reference <index|fasta> --output DIR [--annotation GTF] [--aligner star|hisat2|bwa|salmon]',
  },
  nativeReady(available) {
    const set = new Set(available);
    return set.has('samtools') && ['STAR', 'hisat2', 'bwa', 'salmon'].some((tool) => set.has(tool));
  },
  parse(values) {
    const reads = String(values.reads || '').split(',').map((entry) => entry.trim()).filter(Boolean).map(resolvePath);
    if (!reads.length) throw new Error('--reads is required.');
    if (reads.length > 2) throw new Error('--reads accepts one or two comma-separated files.');
    for (const file of reads) {
      if (!fs.existsSync(file)) throw new Error(`--reads does not exist: ${file}`);
    }
    if (!values.reference) throw new Error('--reference is required.');
    if (!values.output) throw new Error('--output is required.');
    const reference = resolvePath(values.reference);
    if (!fs.existsSync(reference)) throw new Error(`--reference does not exist: ${reference}`);
    const annotation = values.annotation ? resolvePath(values.annotation) : null;
    if (annotation && !fs.existsSync(annotation)) throw new Error(`--annotation does not exist: ${annotation}`);
    const aligner = String(values.aligner || 'star');
    if (!['star', 'hisat2', 'bwa', 'salmon'].includes(aligner)) throw new Error('--aligner must be star, hisat2, bwa, or salmon.');
    if (!['native', 'docker'].includes(String(values.engine || 'native'))) throw new Error('--engine must be native or docker.');
    return {
      reads,
      reference,
      annotation,
      output: resolvePath(values.output),
      aligner,
      threads: integer(values, 'threads', 4, 1),
      engine: String(values.engine || 'native'),
    };
  },
  buildPlan(params) {
    const steps = [];
    const readArgs = params.reads.length === 2 ? ['-I', params.reads[1]] : [];
    const qcReads = params.reads.length === 2
      ? [path.join(params.output, 'qc', 'R1.fq.gz'), path.join(params.output, 'qc', 'R2.fq.gz')]
      : [path.join(params.output, 'qc', 'R1.fq.gz')];
    steps.push({
      name: 'trim',
      command: ['fastp', '-i', params.reads[0], ...readArgs, '-o', qcReads[0], ...(qcReads[1] ? ['-O', qcReads[1]] : []), '--thread', String(params.threads), '--json', path.join(params.output, 'qc', 'fastp.json')],
      requires: ['fastp'],
    });

    if (params.aligner === 'star') {
      steps.push({
        name: 'align',
        command: ['STAR', '--runThreadN', String(params.threads), '--genomeDir', params.reference, '--readFilesIn', ...qcReads, '--readFilesCommand', 'zcat', '--outSAMtype', 'BAM', 'SortedByCoordinate', '--outFileNamePrefix', `${path.join(params.output, 'align')}${path.sep}`],
        requires: ['STAR', 'samtools'],
      });
      steps.push({ name: 'index', command: ['samtools', 'index', path.join(params.output, 'align', 'Aligned.sortedByCoord.out.bam')], requires: ['samtools'] });
      if (params.annotation) {
        steps.push({ name: 'count', command: ['featureCounts', '-T', String(params.threads), ...(params.reads.length === 2 ? ['-p'] : []), '-a', params.annotation, '-o', path.join(params.output, 'counts', 'counts.txt'), path.join(params.output, 'align', 'Aligned.sortedByCoord.out.bam')], requires: ['featureCounts'] });
      }
    } else if (params.aligner === 'hisat2') {
      steps.push({ name: 'align', command: ['hisat2', '-p', String(params.threads), '-x', params.reference, '-1', qcReads[0], ...(qcReads[1] ? ['-2', qcReads[1]] : []), '-S', path.join(params.output, 'align', 'align.sam')], requires: ['hisat2', 'samtools'] });
      steps.push({ name: 'sort', command: ['samtools', 'sort', '-@', String(params.threads), '-o', path.join(params.output, 'align', 'align.bam'), path.join(params.output, 'align', 'align.sam')], requires: ['samtools'] });
      if (params.annotation) {
        steps.push({ name: 'count', command: ['featureCounts', '-T', String(params.threads), ...(params.reads.length === 2 ? ['-p'] : []), '-a', params.annotation, '-o', path.join(params.output, 'counts', 'counts.txt'), path.join(params.output, 'align', 'align.bam')], requires: ['featureCounts'] });
      }
    } else if (params.aligner === 'bwa') {
      steps.push({ name: 'align', command: ['bwa', 'mem', '-t', String(params.threads), '-o', path.join(params.output, 'align', 'align.sam'), params.reference, qcReads[0], ...(qcReads[1] ? [qcReads[1]] : [])], requires: ['bwa', 'samtools'] });
      steps.push({ name: 'sort', command: ['samtools', 'sort', '-@', String(params.threads), '-o', path.join(params.output, 'align', 'align.bam'), path.join(params.output, 'align', 'align.sam')], requires: ['samtools'] });
      if (params.annotation) {
        steps.push({ name: 'count', command: ['featureCounts', '-T', String(params.threads), ...(params.reads.length === 2 ? ['-p'] : []), '-a', params.annotation, '-o', path.join(params.output, 'counts', 'counts.txt'), path.join(params.output, 'align', 'align.bam')], requires: ['featureCounts'] });
      }
    } else {
      steps.push({ name: 'quant', command: ['salmon', 'quant', '-i', params.reference, '-l', 'A', '-1', qcReads[0], ...(qcReads[1] ? ['-2', qcReads[1]] : []), '-p', String(params.threads), '-o', path.join(params.output, 'quant')], requires: ['salmon'] });
    }
    const warnings = [];
    if (params.aligner !== 'salmon' && !params.annotation) {
      warnings.push('no --annotation: alignment runs, but gene counts (featureCounts) are skipped');
    }
    if (params.engine === 'docker') {
      warnings.push('docker engine is a plan-only preview in this release; install native tools to run');
    }
    return { steps, warnings };
  },
};
