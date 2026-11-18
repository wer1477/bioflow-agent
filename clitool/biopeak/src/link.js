import fs from 'node:fs/promises';

export class LinkError extends Error {}

function fields(line) { return line.split('\t'); }

function attribute(value, key) {
  const match = value.match(new RegExp(`(?:^|;)\\s*${key}\\s+\"([^\"]+)\"`));
  return match?.[1] || null;
}

export async function readPeaks(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const peaks = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) continue;
    const row = fields(line);
    const start = Number(row[1]); const end = Number(row[2]);
    if (row.length < 3 || !row[0] || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw new LinkError(`Invalid BED/narrowPeak row ${index + 1} in ${filePath}.`);
    peaks.push({ id: row[3] || `peak_${peaks.length + 1}`, chrom: row[0], start, end, score: row[4] || null });
  }
  if (!peaks.length) throw new LinkError(`No BED/narrowPeak intervals found in ${filePath}.`);
  return peaks;
}

export async function readGenes(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const byId = new Map();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line || line.startsWith('#')) continue;
    const row = fields(line);
    if (row.length < 9 || !['gene', 'transcript'].includes(row[2])) continue;
    const start = Number(row[3]); const end = Number(row[4]);
    if (!row[0] || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || !['+', '-'].includes(row[6])) throw new LinkError(`Invalid GTF row ${index + 1} in ${filePath}.`);
    const geneId = attribute(row[8], 'gene_id');
    if (!geneId) continue;
    const candidate = { gene_id: geneId, gene_name: attribute(row[8], 'gene_name') || geneId, chrom: row[0], strand: row[6], tss: row[6] === '+' ? start - 1 : end - 1 };
    const existing = byId.get(geneId);
    if (!existing || row[2] === 'gene') byId.set(geneId, candidate);
  }
  const genes = [...byId.values()];
  if (!genes.length) throw new LinkError(`No gene/transcript records with gene_id were found in ${filePath}.`);
  return genes;
}

function overlap(leftStart, leftEnd, rightStart, rightEnd) { return leftStart < rightEnd && rightStart < leftEnd; }
function distance(peak, tss) { return tss < peak.start ? peak.start - tss : (tss >= peak.end ? tss - peak.end + 1 : 0); }

export function linkPeaks({ peaks, genes, promoterUpstream, promoterDownstream, maxDistance }) {
  const byChrom = new Map();
  for (const gene of genes) byChrom.set(gene.chrom, [...(byChrom.get(gene.chrom) || []), gene]);
  const links = [];
  for (const peak of peaks) {
    const candidates = byChrom.get(peak.chrom) || [];
    const promoters = candidates.filter((gene) => {
      const start = Math.max(0, gene.tss - (gene.strand === '+' ? promoterUpstream : promoterDownstream));
      const end = gene.tss + (gene.strand === '+' ? promoterDownstream : promoterUpstream) + 1;
      return overlap(peak.start, peak.end, start, end);
    });
    const selected = promoters.length ? promoters.map((gene) => ({ gene, link_type: 'promoter_overlap', distance_to_tss: distance(peak, gene.tss) })) : (() => {
      const nearest = candidates.map((gene) => ({ gene, distance_to_tss: distance(peak, gene.tss) })).sort((a, b) => a.distance_to_tss - b.distance_to_tss || a.gene.gene_id.localeCompare(b.gene.gene_id))[0];
      return nearest && nearest.distance_to_tss <= maxDistance ? [{ ...nearest, link_type: 'nearest_tss' }] : [];
    })();
    for (const item of selected.sort((a, b) => a.gene.gene_id.localeCompare(b.gene.gene_id))) links.push({
      peak_id: peak.id, chrom: peak.chrom, start: peak.start, end: peak.end, peak_score: peak.score,
      gene_id: item.gene.gene_id, gene_name: item.gene.gene_name, link_type: item.link_type, distance_to_tss: item.distance_to_tss,
    });
  }
  return links;
}

export function tsv(links) {
  const headers = ['peak_id', 'chrom', 'start', 'end', 'peak_score', 'gene_id', 'gene_name', 'link_type', 'distance_to_tss'];
  return `${headers.join('\t')}\n${links.map((link) => headers.map((key) => link[key] ?? '').join('\t')).join('\n')}${links.length ? '\n' : ''}`;
}
