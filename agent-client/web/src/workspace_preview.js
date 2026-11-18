// 文件预览的纯逻辑：类型判定、语言映射、各格式解析。
// 无 React 依赖，保持纯函数可单测（与 domain/ 下其余模块同样的约定）。

const TEXT_PREVIEW_LINE_LIMIT = 5000;
const TABLE_PREVIEW_ROW_LIMIT = 500;
const SEQUENCE_RECORD_LIMIT = 50;
const SEQUENCE_CHAR_LIMIT = 2000;
const NOTEBOOK_OUTPUT_LIMIT = 2000;
export const HEX_PREVIEW_BYTE_LIMIT = 512;

/**
 * 扩展名 → 预览类型。`code` 类由 getWorkspaceFileLanguage 决定高亮语言；
 * 这里只决定"用哪种视图看"，不认识的一律 text。
 */
const EXTENSION_KIND = new Map([
  ['md', 'markdown'],
  ['mdx', 'markdown'],
  ['markdown', 'markdown'],
  ['ipynb', 'notebook'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['csv', 'table'],
  ['tsv', 'table'],
  ['tab', 'table'],
  ['vcf', 'vcf'],
  ['fa', 'fasta'],
  ['fna', 'fasta'],
  ['faa', 'fasta'],
  ['ffn', 'fasta'],
  ['mfa', 'fasta'],
  ['fasta', 'fasta'],
  ['fq', 'fastq'],
  ['fastq', 'fastq'],
  ['gff', 'gff'],
  ['gff3', 'gff'],
  ['gtf', 'gff'],
  ['bed', 'bed'],
  ['sam', 'sam'],
  ['yaml', 'code'],
  ['yml', 'code'],
]);

/** 扩展名 → highlight.js 语言名；只映射已注册的语言，避免为预览引入新的语言包。 */
const EXTENSION_LANGUAGE = new Map([
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'javascript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['py', 'python'],
  ['r', 'r'],
  ['rs', 'rust'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['hpp', 'cpp'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['json', 'json'],
  ['jsonl', 'json'],
  ['ndjson', 'json'],
  ['diff', 'diff'],
  ['patch', 'diff'],
]);

/** 确定是文本的后缀：决定"能不能编辑"以及要不要走 hexdump 兜底。 */
const TEXTISH_EXTENSIONS = new Set([
  'txt', 'log', 'text', 'csv', 'tsv', 'tab', 'json', 'jsonc', 'jsonl', 'ndjson', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'css', 'sql', 'go', 'java', 'lua',
  'py', 'r', 'sh', 'bash', 'zsh', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'rs', 'c', 'h',
  'cpp', 'cc', 'hpp', 'md', 'mdx', 'markdown', 'ipynb', 'nwk', 'treefile', 'nex', 'phy',
  'mtx', 'vcf', 'sam', 'pdb', 'cif', 'diff', 'patch', 'gff', 'gff3', 'gtf', 'bed',
  'fa', 'fna', 'faa', 'ffn', 'mfa', 'fasta', 'fq', 'fastq',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);

export function extensionOf(path) {
  const match = /\.([a-z0-9]+)$/i.exec(String(path || ''));
  return match?.[1]?.toLowerCase() || '';
}

export function getWorkspaceFileExtension(path) {
  const extension = extensionOf(path);
  return extension ? extension.toUpperCase() : 'TEXT';
}

export function getWorkspacePreviewKind(path) {
  const extension = extensionOf(path);
  if (EXTENSION_KIND.has(extension)) return EXTENSION_KIND.get(extension);
  return EXTENSION_LANGUAGE.has(extension) ? 'code' : 'text';
}

export function getWorkspaceFileLanguage(path) {
  return EXTENSION_LANGUAGE.get(extensionOf(path)) || '';
}

export function isTextishExtension(path) {
  return TEXTISH_EXTENSIONS.has(extensionOf(path));
}

export function isImageExtension(path) {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

export function splitLines(content) {
  return String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
}

export function prepareTextPreview(content, lineLimit = TEXT_PREVIEW_LINE_LIMIT) {
  const allLines = splitLines(content);
  return {
    lines: allLines.slice(0, lineLimit),
    totalLines: allLines.length,
    truncated: allLines.length > lineLimit,
  };
}

export function parseVcfPreview(content, rowLimit = TABLE_PREVIEW_ROW_LIMIT) {
  const lines = splitLines(content);
  const metadata = [];
  let columns = [];
  const rows = [];
  let totalRows = 0;

  for (const line of lines) {
    if (line.startsWith('##')) {
      metadata.push(line.slice(2));
      continue;
    }
    if (line.startsWith('#CHROM')) {
      columns = line.slice(1).split('\t');
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    totalRows += 1;
    if (rows.length < rowLimit) rows.push(line.split('\t'));
  }

  return { metadata, columns, rows, totalRows, truncated: totalRows > rows.length };
}

export function parseDelimitedRow(line, delimiter) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

export function parseDelimitedPreview(content, delimiter, rowLimit = TABLE_PREVIEW_ROW_LIMIT) {
  const lines = splitLines(content).filter((line) => line.length > 0);
  const columns = lines.length ? parseDelimitedRow(lines[0], delimiter) : [];
  const dataLines = lines.slice(1);
  return {
    columns,
    rows: dataLines.slice(0, rowLimit).map((line) => parseDelimitedRow(line, delimiter)),
    totalRows: dataLines.length,
    truncated: dataLines.length > rowLimit,
  };
}

export function formatJsonPreview(content) {
  try {
    return { formatted: JSON.stringify(JSON.parse(String(content || '')), null, 2), valid: true };
  } catch {
    return { formatted: String(content || ''), valid: false };
  }
}

/** FASTA：记录数 + 长度分布，序列只保留前若干条、每条截前 2000 字符。 */
export function parseFastaPreview(content, recordLimit = SEQUENCE_RECORD_LIMIT) {
  const records = [];
  let current = null;
  let totalRecords = 0;
  let totalBases = 0;
  let minLength = 0;
  let maxLength = 0;

  const flush = () => {
    if (!current) return;
    const length = current.sequence.length;
    totalRecords += 1;
    totalBases += length;
    minLength = minLength === 0 ? length : Math.min(minLength, length);
    maxLength = Math.max(maxLength, length);
    if (records.length < recordLimit) {
      records.push({
        id: current.id,
        length,
        preview: current.sequence.slice(0, SEQUENCE_CHAR_LIMIT),
      });
    }
  };

  for (const line of splitLines(content)) {
    if (!line) continue;
    if (line.startsWith('>')) {
      flush();
      current = { id: line.slice(1).trim(), sequence: '' };
    } else if (current) {
      current.sequence += line.trim();
    }
  }
  flush();

  return {
    records,
    totalRecords,
    totalBases,
    minLength,
    maxLength,
    meanLength: totalRecords ? Math.round(totalBases / totalRecords) : 0,
    truncated: totalRecords > records.length,
  };
}

/** FASTQ：四行一条 read，顺带给出长度、GC 与平均质量（Phred+33）。 */
export function parseFastqPreview(content, recordLimit = SEQUENCE_RECORD_LIMIT) {
  const lines = splitLines(content).filter((line) => line.length > 0);
  const reads = [];
  let totalReads = 0;
  let totalBases = 0;
  let gcBases = 0;
  let minLength = 0;
  let maxLength = 0;
  let qualitySum = 0;
  let qualityCount = 0;

  for (let index = 0; index + 1 < lines.length; index += 4) {
    const header = lines[index];
    if (!header.startsWith('@')) break;
    const sequence = String(lines[index + 1] || '').trim();
    const quality = String(lines[index + 3] || '').trim();
    totalReads += 1;
    totalBases += sequence.length;
    minLength = minLength === 0 ? sequence.length : Math.min(minLength, sequence.length);
    maxLength = Math.max(maxLength, sequence.length);
    gcBases += countGc(sequence);
    for (const char of quality) {
      qualitySum += Math.max(0, char.charCodeAt(0) - 33);
      qualityCount += 1;
    }
    if (reads.length < recordLimit) {
      reads.push({
        id: header.slice(1).trim(),
        sequence,
        quality,
        length: sequence.length,
        gc: sequence.length ? Math.round((countGc(sequence) / sequence.length) * 1000) / 10 : 0,
        meanQuality: quality
          ? Math.round(([...quality].reduce((sum, char) => sum + Math.max(0, char.charCodeAt(0) - 33), 0) / quality.length) * 10) / 10
          : 0,
      });
    }
  }

  return {
    reads,
    totalReads,
    totalBases,
    minLength,
    maxLength,
    meanLength: totalReads ? Math.round(totalBases / totalReads) : 0,
    gcContent: totalBases ? Math.round((gcBases / totalBases) * 1000) / 10 : 0,
    meanQuality: qualityCount ? Math.round((qualitySum / qualityCount) * 10) / 10 : 0,
    truncated: totalReads > reads.length,
  };
}

function countGc(sequence) {
  let count = 0;
  for (const char of String(sequence).toUpperCase()) {
    if (char === 'G' || char === 'C') count += 1;
  }
  return count;
}

const GFF_COLUMNS = ['seqid', 'source', 'type', 'start', 'end', 'score', 'strand', 'phase', 'attributes'];

/** GFF3/GTF：`##` 头单独折叠，feature 类型计数给一个概览。 */
export function parseGffPreview(content, rowLimit = TABLE_PREVIEW_ROW_LIMIT) {
  const metadata = [];
  const rows = [];
  const featureCounts = new Map();
  let totalRows = 0;

  for (const line of splitLines(content)) {
    if (!line) continue;
    if (line.startsWith('##')) {
      metadata.push(line.slice(2));
      continue;
    }
    if (line.startsWith('#')) continue;
    const cells = line.split('\t');
    if (cells.length < 9) continue;
    totalRows += 1;
    featureCounts.set(cells[2], (featureCounts.get(cells[2]) || 0) + 1);
    if (rows.length < rowLimit) rows.push(cells);
  }

  return {
    metadata,
    columns: GFF_COLUMNS,
    rows,
    totalRows,
    truncated: totalRows > rows.length,
    features: [...featureCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([type, count]) => ({ type, count })),
  };
}

const BED_COLUMNS = [
  'chrom', 'start', 'end', 'name', 'score', 'strand', 'thickStart', 'thickEnd',
  'itemRgb', 'blockCount', 'blockSizes', 'blockStarts',
];

/** BED：列数可变，按实际列数裁剪标准表头。 */
export function parseBedPreview(content, rowLimit = TABLE_PREVIEW_ROW_LIMIT) {
  const lines = splitLines(content).filter((line) => line
    && !line.startsWith('#')
    && !line.startsWith('track')
    && !line.startsWith('browser'));
  const rows = lines.slice(0, rowLimit).map((line) => line.split('\t'));
  const columnCount = Math.max(3, ...rows.map((row) => row.length));
  return {
    columns: BED_COLUMNS.slice(0, columnCount),
    rows,
    totalRows: lines.length,
    truncated: lines.length > rows.length,
  };
}

const SAM_COLUMNS = ['QNAME', 'FLAG', 'RNAME', 'POS', 'MAPQ', 'CIGAR', 'RNEXT', 'PNEXT', 'TLEN', 'SEQ', 'QUAL'];

/** SAM：`@` 头折叠，顺带统计 mapped / unmapped。 */
export function parseSamPreview(content, rowLimit = TABLE_PREVIEW_ROW_LIMIT) {
  const header = [];
  const rows = [];
  let totalRows = 0;
  let unmapped = 0;

  for (const line of splitLines(content)) {
    if (!line) continue;
    if (line.startsWith('@')) {
      header.push(line);
      continue;
    }
    const cells = line.split('\t');
    if (cells.length < 11) continue;
    totalRows += 1;
    if ((Number(cells[1]) & 4) === 4) unmapped += 1;
    if (rows.length < rowLimit) rows.push(cells.slice(0, 11));
  }

  return {
    header,
    columns: SAM_COLUMNS,
    rows,
    totalRows,
    mapped: totalRows - unmapped,
    unmapped,
    truncated: totalRows > rows.length,
  };
}

/** ipynb：单元格列表；markdown 交给调用方的渲染器，代码交给 CodeBlock。 */
export function parseNotebookPreview(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch {
    return { valid: false, cells: [], kernel: '', language: '' };
  }
  const cells = (Array.isArray(parsed?.cells) ? parsed.cells : []).map((cell) => ({
    type: cell?.cell_type === 'code' ? 'code' : cell?.cell_type === 'markdown' ? 'markdown' : 'raw',
    source: Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source || ''),
    outputs: collectNotebookOutputs(cell?.outputs),
  }));
  return {
    valid: true,
    cells,
    kernel: parsed?.metadata?.kernelspec?.display_name || parsed?.metadata?.kernelspec?.name || '',
    language: parsed?.metadata?.language_info?.name || '',
  };
}

function collectNotebookOutputs(outputs) {
  if (!Array.isArray(outputs)) return [];
  const texts = [];
  for (const output of outputs) {
    const data = output?.data || {};
    const candidate = data['text/plain'] ?? output?.text;
    if (typeof candidate === 'string') texts.push(candidate.slice(0, NOTEBOOK_OUTPUT_LIMIT));
    else if (Array.isArray(candidate)) texts.push(candidate.join('').slice(0, NOTEBOOK_OUTPUT_LIMIT));
  }
  return texts;
}

/** 未知二进制：base64 → 前 N 字节的 hexdump，至少让用户看清文件头。 */
export function parseHexPreview(base64Content, byteLimit = HEX_PREVIEW_BYTE_LIMIT) {
  const bytes = decodeBase64Bytes(base64Content, byteLimit);
  const rows = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.slice(offset, offset + 16);
    rows.push({
      offset: offset.toString(16).padStart(8, '0'),
      hex: [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
      ascii: [...chunk].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join(''),
    });
  }
  return { rows, bytes: bytes.length, truncated: bytes.length >= byteLimit };
}

function decodeBase64Bytes(base64Content, byteLimit) {
  const raw = String(base64Content || '');
  if (!raw) return new Uint8Array(0);
  try {
    const binary = atob(raw);
    const length = Math.min(byteLimit, binary.length);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}
