const ENSEMBL_REST = {
  GRCh38: 'https://rest.ensembl.org',
  GRCh37: 'https://grch37.rest.ensembl.org',
};
const REQUEST_TIMEOUT_MS = 30_000;

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

async function requestJson(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
      ...options,
    });
  } catch (error) {
    throw new UpstreamError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.text();
  if (!response.ok) throw new UpstreamError(`HTTP ${response.status} from ${url}: ${body.slice(0, 500)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new UpstreamError(`Expected JSON from ${url}`);
  }
}

function transcript(item) {
  return {
    gene_id: item.gene_id || null,
    gene_symbol: item.gene_symbol || null,
    transcript_id: item.transcript_id || null,
    biotype: item.biotype || null,
    consequence_terms: item.consequence_terms || [],
    impact: item.impact || null,
    canonical: Boolean(item.canonical),
    mane_select: item.mane_select || null,
    hgvsc: item.hgvsc || null,
    hgvsp: item.hgvsp || null,
  };
}

function clinicalEvidence(item) {
  return {
    id: item.id || null,
    allele_string: item.allele_string || null,
    clinical_significance: item.clin_sig || [],
    phenotype_or_disease: item.phenotype_or_disease ?? null,
    somatic: item.somatic ?? null,
  };
}

function normalize(item, assembly) {
  return {
    input: item.input || null,
    assembly,
    location: item.seq_region_name && item.start ? {
      chromosome: String(item.seq_region_name),
      start: item.start,
      end: item.end ?? item.start,
      strand: item.strand ?? null,
    } : null,
    allele_string: item.allele_string || null,
    most_severe_consequence: item.most_severe_consequence || null,
    transcripts: (item.transcript_consequences || []).map(transcript),
    clinical_evidence: (item.colocated_variants || [])
      .filter((variant) => Array.isArray(variant.clin_sig) && variant.clin_sig.length)
      .map(clinicalEvidence),
  };
}

export function createClient({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async annotate({ assembly, variants }) {
      const base = ENSEMBL_REST[assembly];
      if (!base) throw new UpstreamError(`Unsupported assembly: ${assembly}`);
      const url = new URL('/vep/homo_sapiens/region', base);
      url.searchParams.set('canonical', '1');
      url.searchParams.set('hgvs', '1');
      if (assembly === 'GRCh38') url.searchParams.set('mane', '1');
      const data = await requestJson(fetchImpl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants: variants.map((variant) => variant.vepInput) }),
      });
      if (!Array.isArray(data)) throw new UpstreamError('Ensembl VEP response is not an array.');
      return data.map((item) => normalize(item, assembly));
    },
  };
}
