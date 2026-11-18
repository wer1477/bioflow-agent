import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getWorkspaceFileLanguage,
  getWorkspacePreviewKind,
  isImageExtension,
  isTextishExtension,
  parseBedPreview,
  parseDelimitedPreview,
  parseFastaPreview,
  parseFastqPreview,
  parseGffPreview,
  parseHexPreview,
  parseNotebookPreview,
  parseSamPreview,
  parseVcfPreview,
  prepareTextPreview,
} from '../src/workspace_preview.js';

test('recognises research data and readable document formats', () => {
  assert.equal(getWorkspacePreviewKind('runs/Data/sample.vcf'), 'vcf');
  assert.equal(getWorkspacePreviewKind('runs/Data/counts.tsv'), 'table');
  assert.equal(getWorkspacePreviewKind('runs/Analysis/report.json'), 'json');
  assert.equal(getWorkspacePreviewKind('README.md'), 'markdown');
  assert.equal(getWorkspacePreviewKind('notes.txt'), 'text');
});

test('routes the extended format list to a dedicated view', () => {
  assert.equal(getWorkspacePreviewKind('ref/genome.fasta'), 'fasta');
  assert.equal(getWorkspacePreviewKind('reads/sample.fq'), 'fastq');
  assert.equal(getWorkspacePreviewKind('ref/genes.gff3'), 'gff');
  assert.equal(getWorkspacePreviewKind('ref/peaks.bed'), 'bed');
  assert.equal(getWorkspacePreviewKind('aln/sample.sam'), 'sam');
  assert.equal(getWorkspacePreviewKind('analysis.ipynb'), 'notebook');
  assert.equal(getWorkspacePreviewKind('config.yml'), 'code');
  assert.equal(getWorkspacePreviewKind('script.py'), 'code');
  assert.equal(getWorkspacePreviewKind('archive.tar.gz'), 'text');
});

test('maps extensions onto already-registered highlight.js languages', () => {
  assert.equal(getWorkspaceFileLanguage('a/b/main.py'), 'python');
  assert.equal(getWorkspaceFileLanguage('main.ts'), 'typescript');
  assert.equal(getWorkspaceFileLanguage('pipeline.sh'), 'bash');
  assert.equal(getWorkspaceFileLanguage('config.yaml'), 'yaml');
  assert.equal(getWorkspaceFileLanguage('unknown.weird'), '');
});

test('separates text-ish and image extensions for edit/preview decisions', () => {
  assert.equal(isTextishExtension('report.md'), true);
  assert.equal(isTextishExtension('sample.bam'), false);
  assert.equal(isImageExtension('plot.png'), true);
  assert.equal(isImageExtension('sample.bam'), false);
});

test('parses VCF headers, metadata, and variant rows', () => {
  const preview = parseVcfPreview([
    '##fileformat=VCFv4.2',
    '##reference=GRCh38',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    '17\t7674220\trs11540652\tC\tT\t.\tPASS\t.',
  ].join('\n'));

  assert.deepEqual(preview.columns, ['CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO']);
  assert.equal(preview.metadata.length, 2);
  assert.deepEqual(preview.rows[0], ['17', '7674220', 'rs11540652', 'C', 'T', '.', 'PASS', '.']);
});

test('parses quoted CSV cells and preserves the table shape', () => {
  const preview = parseDelimitedPreview('gene,description,count\nBRCA1,"DNA, repair",42', ',');
  assert.deepEqual(preview.columns, ['gene', 'description', 'count']);
  assert.deepEqual(preview.rows, [['BRCA1', 'DNA, repair', '42']]);
});

test('limits very long text previews while retaining stable line numbers', () => {
  const preview = prepareTextPreview('one\ntwo\nthree', 2);
  assert.deepEqual(preview.lines, ['one', 'two']);
  assert.equal(preview.totalLines, 3);
  assert.equal(preview.truncated, true);
});

test('FASTA preview counts records and keeps a bounded sequence preview', () => {
  const preview = parseFastaPreview([
    '>seq1 first record',
    'ACGTACGT',
    'ACGT',
    '>seq2',
    'GGGG',
  ].join('\n'));

  assert.equal(preview.totalRecords, 2);
  assert.equal(preview.totalBases, 16);
  assert.equal(preview.minLength, 4);
  assert.equal(preview.maxLength, 12);
  assert.equal(preview.meanLength, 8);
  assert.deepEqual(preview.records.map((record) => record.id), ['seq1 first record', 'seq2']);
  assert.equal(preview.records[0].preview, 'ACGTACGTACGT');
});

test('FASTQ preview derives length, GC, and mean quality', () => {
  const preview = parseFastqPreview([
    '@read1',
    'ACGTACGT',
    '+',
    'IIIIIIII',
    '@read2',
    'GGCC',
    '+',
    '!!!!',
  ].join('\n'));

  assert.equal(preview.totalReads, 2);
  assert.equal(preview.totalBases, 12);
  assert.equal(preview.minLength, 4);
  assert.equal(preview.maxLength, 8);
  // read1 是 50% GC、read2 是 100% GC，12 个碱基里 8 个 GC。
  assert.equal(preview.gcContent, 66.7);
  assert.equal(preview.meanQuality, 26.7);
  assert.equal(preview.reads[0].id, 'read1');
  assert.equal(preview.reads[1].meanQuality, 0);
});

test('GFF preview keeps metadata, nine columns, and feature counts', () => {
  const preview = parseGffPreview([
    '##gff-version 3',
    'chr1\ttest\tgene\t1\t100\t.\t+\t.\tID=g1',
    'chr1\ttest\texon\t10\t20\t.\t+\t.\tID=e1',
    'chr1\ttest\texon\t30\t40\t.\t+\t.\tID=e2',
  ].join('\n'));

  assert.deepEqual(preview.metadata, ['gff-version 3']);
  assert.equal(preview.columns.length, 9);
  assert.equal(preview.totalRows, 3);
  assert.deepEqual(preview.features[0], { type: 'exon', count: 2 });
  assert.equal(preview.rows[0][2], 'gene');
});

test('BED preview adapts its header to the column count', () => {
  const preview = parseBedPreview([
    'track name=peaks',
    'chr1\t10\t20\tpeak1\t100',
    'chr1\t30\t40\tpeak2\t200',
  ].join('\n'));

  assert.equal(preview.totalRows, 2);
  assert.deepEqual(preview.columns, ['chrom', 'start', 'end', 'name', 'score']);
  assert.deepEqual(preview.rows[0], ['chr1', '10', '20', 'peak1', '100']);
});

test('SAM preview splits header from records and counts unmapped reads', () => {
  const preview = parseSamPreview([
    '@HD\tVN:1.6',
    '@SQ\tSN:chr1\tLN:1000',
    'r1\t0\tchr1\t7\t60\t8M\t*\t0\t0\tACGTACGT\tIIIIIIII',
    'r2\t4\t*\t0\t0\t*\t*\t0\t0\tACGT\tIIII',
  ].join('\n'));

  assert.equal(preview.header.length, 2);
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.mapped, 1);
  assert.equal(preview.unmapped, 1);
  assert.equal(preview.columns[0], 'QNAME');
});

test('notebook preview separates markdown, code, and outputs', () => {
  const preview = parseNotebookPreview(JSON.stringify({
    metadata: { kernelspec: { display_name: 'Python 3' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'body'] },
      { cell_type: 'code', source: 'print(1)', outputs: [{ data: { 'text/plain': '1' } }] },
    ],
  }));

  assert.equal(preview.valid, true);
  assert.equal(preview.kernel, 'Python 3');
  assert.equal(preview.cells[0].type, 'markdown');
  assert.equal(preview.cells[0].source, '# Title\nbody');
  assert.deepEqual(preview.cells[1].outputs, ['1']);
});

test('notebook preview degrades instead of throwing on broken JSON', () => {
  const preview = parseNotebookPreview('{not json');
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.cells, []);
});

test('hex preview decodes the head of a binary file', () => {
  const preview = parseHexPreview(Buffer.from('AB', 'utf8').toString('base64'));
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].offset, '00000000');
  assert.equal(preview.rows[0].hex, '41 42');
  assert.equal(preview.rows[0].ascii, 'AB');
  assert.equal(preview.truncated, false);
});

test('hex preview survives content that is not valid base64', () => {
  const preview = parseHexPreview('***not base64***');
  assert.equal(preview.rows.length, 0);
  assert.equal(preview.bytes, 0);
});
