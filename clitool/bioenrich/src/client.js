const GPROFILER_URL = 'https://biit.cs.ut.ee/gprofiler/api/gost/profile/';
const ENRICHR_URL = 'https://maayanlab.cloud/Enrichr';
const REQUEST_TIMEOUT_MS = 30_000;

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

async function requestJson(fetchImpl, url, options = {}) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json', ...(options.headers || {}) }, signal: controller.signal, ...options });
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

function gprofilerResult(item) {
  return {
    source: item.source || null,
    term_id: item.native || null,
    term_name: item.name || null,
    // g:Profiler's `p_value` is already corrected for multiple testing; it
    // does not expose the corresponding unadjusted value in this response.
    p_value: null,
    adjusted_p_value: item.p_value ?? null,
    term_size: item.term_size ?? null,
    query_size: item.query_size ?? null,
    intersection_size: item.intersection_size ?? null,
    intersections: item.intersections || [],
  };
}

function enrichrResult(library, item) {
  const [termName, pValue, zScore, combinedScore, overlapGenes, adjustedPValue] = item;
  return {
    source: library,
    term_id: termName || null,
    term_name: termName || null,
    p_value: pValue ?? null,
    adjusted_p_value: adjustedPValue ?? null,
    term_size: null,
    query_size: null,
    intersection_size: Array.isArray(overlapGenes) ? overlapGenes.length : null,
    intersections: Array.isArray(overlapGenes) ? overlapGenes : [],
    z_score: zScore ?? null,
    combined_score: combinedScore ?? null,
  };
}

export function createClient({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async gprofiler({ genes, organism, sources, userThreshold, background }) {
      const payload = {
        organism,
        query: genes,
        sources: sources || [],
        user_threshold: userThreshold,
        significance_threshold_method: 'g_SCS',
        domain_scope: background?.length ? 'custom_annotated' : 'annotated',
        no_evidences: false,
        combined: false,
      };
      if (background?.length) payload.custom_bg = background;
      const data = await requestJson(fetchImpl, GPROFILER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!Array.isArray(data.result)) throw new UpstreamError('g:Profiler response does not contain a result array.');
      return { meta: data.meta || {}, results: data.result.map(gprofilerResult) };
    },

    async enrichr({ genes, library }) {
      const libraries = await this.enrichrLibraries();
      if (!libraries.some((item) => item.name === library)) throw new UpstreamError(`Unknown Enrichr library: ${library}. Run bio-enrich libraries to discover current names.`);
      const form = new FormData();
      form.set('list', genes.join('\n'));
      form.set('description', 'bio-enrich gene-list enrichment');
      const submitted = await requestJson(fetchImpl, `${ENRICHR_URL}/addList`, {
        method: 'POST',
        body: form,
      });
      if (!submitted.userListId) throw new UpstreamError('Enrichr did not return userListId.');
      const url = new URL(`${ENRICHR_URL}/enrich`);
      url.searchParams.set('userListId', String(submitted.userListId));
      url.searchParams.set('backgroundType', library);
      const data = await requestJson(fetchImpl, url);
      if (!Array.isArray(data[library])) throw new UpstreamError(`Enrichr response does not contain the requested library: ${library}.`);
      return { meta: { user_list_id: submitted.userListId }, results: data[library].map((item) => enrichrResult(library, item)) };
    },

    async enrichrLibraries() {
      const data = await requestJson(fetchImpl, `${ENRICHR_URL}/datasetStatistics`);
      return (data.statistics || []).map((item) => ({
        name: item.libraryName,
        description: item.libraryDescription || null,
        gene_count: item.numTerms ?? null,
        category_id: item.categoryId ?? null,
      })).filter((item) => item.name);
    },
  };
}
