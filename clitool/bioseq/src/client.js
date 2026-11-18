const BLAST_URL = 'https://blast.ncbi.nlm.nih.gov/Blast.cgi';
const REQUEST_TIMEOUT_MS = 30_000;

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

async function requestText(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, ...options });
  } catch (error) {
    throw new UpstreamError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.text();
  if (!response.ok) throw new UpstreamError(`HTTP ${response.status} from NCBI BLAST: ${body.slice(0, 500)}`);
  return body;
}

function parameter(text, name) {
  return new RegExp(`^${name}\\s*=\\s*(.+)$`, 'mi').exec(text)?.[1]?.trim() || null;
}

export function createClient({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async submitBlast({ sequence, program, database, maxHits, email }) {
      const form = new URLSearchParams({
        CMD: 'Put',
        QUERY: sequence,
        PROGRAM: program,
        DATABASE: database,
        HITLIST_SIZE: String(maxHits),
        FORMAT_TYPE: 'JSONSA',
        EMAIL: email,
        TOOL: 'bio-seq',
      });
      const text = await requestText(fetchImpl, BLAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' },
        body: form,
      });
      const rid = parameter(text, 'RID');
      if (!rid) throw new UpstreamError(`NCBI BLAST did not return a RID: ${text.slice(0, 500)}`);
      const estimatedWaitSeconds = Number(parameter(text, 'RTOE'));
      return { rid, estimated_wait_seconds: Number.isFinite(estimatedWaitSeconds) ? estimatedWaitSeconds : null };
    },

    async blastStatus({ rid }) {
      const url = new URL(BLAST_URL);
      url.search = new URLSearchParams({ CMD: 'Get', RID: rid, FORMAT_OBJECT: 'SearchInfo' }).toString();
      const text = await requestText(fetchImpl, url, { headers: { Accept: 'text/plain' } });
      const status = parameter(text, 'Status');
      if (!status) throw new UpstreamError(`NCBI BLAST did not return a search status: ${text.slice(0, 500)}`);
      return { rid, status: status.toLowerCase(), has_hits: parameter(text, 'ThereAreHits') === 'yes' };
    },

    async blastResults({ rid }) {
      const url = new URL(BLAST_URL);
      url.search = new URLSearchParams({ CMD: 'Get', RID: rid, FORMAT_TYPE: 'JSONSA' }).toString();
      const text = await requestText(fetchImpl, url, { headers: { Accept: 'application/json' } });
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError(`Expected JSONSA results from NCBI BLAST for RID ${rid}. Check status first with bio-seq blast-status.`);
      }
    },
  };
}
