import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

function normalizeChromosome(value) {
  const cleaned = String(value).trim();
  if (!cleaned) return cleaned;
  return cleaned.startsWith('chr') ? cleaned : `chr${cleaned}`;
}

export function parseRegion(value) {
  const match = /^([^:]+):(\d+)-(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error('--region must have the form chr:start-end using one-based inclusive coordinates.');
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('--region has invalid coordinates.');
  return { chromosome: normalizeChromosome(match[1]), start, end, bed_start: start - 1, bed_end: end, display: `${normalizeChromosome(match[1])}:${start}-${end}` };
}

export async function resolveGene(gene, assembly, { fetchImpl = fetch } = {}) {
  const symbol = String(gene).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(symbol)) throw new Error('--gene must be a non-empty gene symbol.');
  const url = `https://rest.ensembl.org/lookup/symbol/homo_sapiens/${encodeURIComponent(symbol)}?content-type=application/json`;
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Ensembl gene lookup failed for ${symbol}: HTTP ${response.status}.`);
  const record = await response.json();
  if (record.assembly_name !== assembly) throw new Error(`Gene ${symbol} resolved to ${record.assembly_name}, not requested assembly ${assembly}.`);
  const region = parseRegion(`${record.seq_region_name}:${record.start}-${record.end}`);
  return {
    region,
    resolver: {
      source: 'ensembl-rest', url, retrieved_at: new Date().toISOString(),
      record: { id: record.id, display_name: record.display_name, assembly_name: record.assembly_name, strand: record.strand, seq_region_name: record.seq_region_name, start: record.start, end: record.end },
    },
  };
}

function openText(filePath) {
  const source = fs.createReadStream(filePath);
  return filePath.endsWith('.gz') ? source.pipe(createGunzip()) : source;
}

function overlaps(region, start, end) {
  return start < region.bed_end && end > region.bed_start;
}

function rowFor(dataset, fields, region) {
  const offset = dataset.source === 'cpg-island' ? 1 : 0;
  if (fields.length < offset + 3 || normalizeChromosome(fields[offset]) !== region.chromosome) return null;
  const start = Number(fields[offset + 1]);
  const end = Number(fields[offset + 2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !overlaps(region, start, end)) return null;
  const common = {
    source: dataset.source,
    dataset_id: dataset.id,
    dataset_version: dataset.version,
    assembly: dataset.assembly,
    evidence_type: dataset.evidence_type,
    region: `${region.chromosome}:${start + 1}-${end}`,
    overlap_query_region: region.display,
    biosample: dataset.biosample || null,
    assay: dataset.assay || null,
  };
  if (dataset.source === 'cpg-island') return { ...common, feature: fields[4] || null, cpg_count: Number(fields[6]) || null, gc_count: Number(fields[7]) || null };
  if (dataset.source === 'chromhmm') return { ...common, chromatin_state: fields[3] || null };
  if (dataset.source === 'encode-peak') return { ...common, peak_name: fields[3] || null, signal_value: Number(fields[6]) || null, q_value: Number(fields[8]) || null };
  return { ...common, tf_or_feature: fields[3] || null, score: Number(fields[4]) || null };
}

export async function queryDataset(dataset, dataDir, region) {
  const filePath = path.resolve(dataDir, dataset.file_path);
  const rows = [];
  const reader = readline.createInterface({ input: openText(filePath), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) continue;
    const row = rowFor(dataset, line.split('\t'), region);
    if (row) rows.push(row);
  }
  return rows;
}
