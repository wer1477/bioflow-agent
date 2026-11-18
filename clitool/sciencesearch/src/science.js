import { createHttp, HttpError } from './http.js';
import { ConnectorRegistry, decodeCursor, encodeCursor } from './registry.js';

const http = createHttp();
const MAX_BUFFERED_HITS_PER_SOURCE = 10;

export const DOMAINS = ['literature', 'biology', 'genomics', 'proteomics', 'pathways', 'structure', 'omics', 'clinical', 'chemistry'];

const sourceContracts = {
  pubmed: { record_id: 'PubMed PMID, for example 12345678.' },
  europepmc: { record_id: 'Europe PMC record id, PMID, or DOI.' },
  biorxiv: { record_id: 'DOI, for example 10.1101/2024.01.01.123456.', parameters: [{ name: 'fromDate', type: 'date', description: 'Inclusive YYYY-MM-DD lower date bound.' }, { name: 'toDate', type: 'date', description: 'Inclusive YYYY-MM-DD upper date bound.' }] },
  uniprot: { record_id: 'UniProt accession, for example P04637.' },
  ncbi_gene: { record_id: 'NCBI Gene numeric id.' },
  ensembl: { record_id: 'Ensembl stable id, for example ENSG00000141510.', parameters: [{ name: 'species', type: 'string', default: 'homo_sapiens', description: 'Ensembl species name for symbol lookup.' }, { name: 'seqType', type: 'string', enum: ['genomic', 'cdna', 'cds', 'protein'], description: 'Sequence type for FASTA download.' }] },
  reactome: { record_id: 'Reactome stable id, for example R-HSA-69563.' },
  kegg: { record_id: 'KEGG entry id, for example hsa:7157.', parameters: [{ name: 'db', type: 'string', default: 'genes', description: 'KEGG database to search, for example genes or pathway.' }] },
  rcsb_pdb: { record_id: 'Four-character PDB entry id, for example 1TUP.' },
  interpro: { record_id: 'InterPro accession, for example IPR000001.' },
  string: { record_id: 'STRING protein id.', parameters: [{ name: 'species', type: 'integer', default: 9606, description: 'NCBI taxonomy id.' }] },
  geo: { record_id: 'GEO GDS numeric id or accession.', parameters: [{ name: 'organism', type: 'string', description: 'Organism term included in the GDS query.' }, { name: 'study_type', type: 'string', description: 'Study-type term included in the GDS query.' }] },
  openalex: { record_id: 'OpenAlex work id or DOI.', parameters: [{ name: 'mailto', type: 'string', description: 'Contact address sent to OpenAlex for polite-pool identification.' }] },
  semantic_scholar: { record_id: 'Semantic Scholar paper id, DOI, PMID, or arXiv id.', auth: 'optional_api_key', parameters: [{ name: 'apiKey', type: 'string', secret: true, description: 'Optional Semantic Scholar key; SEMANTIC_SCHOLAR_API_KEY is also accepted.' }] },
  crossref: { record_id: 'DOI, optionally as a doi.org URL.' },
  arxiv: { record_id: 'arXiv id, for example 2401.01234.', parameters: [{ name: 'query', type: 'arxiv_query', description: 'The search query may use arXiv prefixes such as ti:, au:, abs:, cat:, or all:.' }] },
  clinvar: { record_id: 'ClinVar variation numeric id.' },
  opentargets: { record_id: 'Ensembl target id, EFO disease id, or ChEMBL drug id.', parameters: [{ name: 'entity', type: 'string', enum: ['target', 'disease', 'drug'], description: 'Optional Open Targets entity filter.' }] },
  chembl: { record_id: 'ChEMBL molecule id, for example CHEMBL25.' },
  alphafold: { record_id: 'UniProt accession, for example P04637.' },
  cellxgene: { record_id: 'CELLxGENE dataset UUID.', parameters: [{ name: 'organism', type: 'string', description: 'Organism label filter.' }, { name: 'tissue', type: 'string', description: 'Tissue label filter.' }, { name: 'disease', type: 'string', description: 'Disease label filter.' }] },
  dbsnp: { record_id: 'dbSNP rsID, for example rs7412; the rs prefix is optional.' },
  gnomad: {
    record_id: 'gnomAD variant id (chrom-pos-ref-alt, for example 17-43057062-T-TG), rsID (for example rs80357906), or Ensembl gene id (for example ENSG00000012048).',
    parameters: [{ name: 'dataset', type: 'string', enum: ['gnomad_r4', 'gnomad_r3', 'gnomad_r2_1', 'exac'], default: 'gnomad_r4', description: 'gnomAD dataset. gnomad_r4 and gnomad_r3 target GRCh38; gnomad_r2_1 and exac target GRCh37.' }],
  },
  gtex: {
    record_id: 'GTEx gene GENCODE id (for example ENSG00000141510.16) or gene symbol (for example TP53).',
    parameters: [{ name: 'gencodeVersion', type: 'string', enum: ['v39', 'v26', 'v19'], default: 'v26', description: 'GTEx GENCODE annotation version; v19 targets GRCh37/hg19.' }],
  },
  jaspar: {
    record_id: 'JASPAR matrix id, for example MA0106.1.',
    parameters: [{ name: 'collection', type: 'string', enum: ['CORE', 'CNE', 'PHYLOFACTS', 'SPLICE', 'POLYA', 'UNVALIDATED'], description: 'Optional JASPAR matrix collection filter.' }, { name: 'tax_group', type: 'string', description: 'Optional JASPAR taxonomy group filter, for example vertebrates or plants.' }],
  },
};

export const catalog = [
  ['pubmed', 'PubMed', 'literature', 'NCBI PubMed biomedical literature search via E-utilities.', ['xml', 'abstract.txt', 'json'], 'https://pubmed.ncbi.nlm.nih.gov/'],
  ['europepmc', 'Europe PMC', 'literature', 'Biomedical articles, preprints, grants, and abstracts.', ['json', 'xml'], 'https://europepmc.org/'],
  ['biorxiv', 'bioRxiv', 'literature', 'Preprint search using the public bioRxiv API.', ['json', 'pdf-link'], 'https://www.biorxiv.org/'],
  ['uniprot', 'UniProt', 'proteomics', 'Protein sequence and functional annotation search.', ['json', 'fasta', 'txt', 'gff'], 'https://www.uniprot.org/'],
  ['ncbi_gene', 'NCBI Gene', 'genomics', 'NCBI Gene records through E-utilities.', ['json', 'xml'], 'https://www.ncbi.nlm.nih.gov/gene/'],
  ['ensembl', 'Ensembl', 'genomics', 'Gene lookup by symbol; defaults to homo_sapiens.', ['json', 'fasta'], 'https://www.ensembl.org/'],
  ['reactome', 'Reactome', 'pathways', 'Pathway and reaction search.', ['json', 'sbml'], 'https://reactome.org/'],
  ['kegg', 'KEGG', 'pathways', 'KEGG REST pathway and gene entry search.', ['txt', 'kgml'], 'https://www.kegg.jp/'],
  ['rcsb_pdb', 'RCSB PDB', 'structure', 'Protein structure search.', ['json', 'cif', 'pdb', 'fasta'], 'https://www.rcsb.org/'],
  ['interpro', 'InterPro', 'proteomics', 'Protein family, domain, and functional-site lookup.', ['json'], 'https://www.ebi.ac.uk/interpro/'],
  ['string', 'STRING', 'biology', 'Protein interaction network search.', ['json', 'tsv'], 'https://string-db.org/'],
  ['geo', 'NCBI GEO', 'omics', 'NCBI GEO dataset search through GDS E-utilities.', ['json', 'xml', 'links'], 'https://www.ncbi.nlm.nih.gov/geo/'],
  ['openalex', 'OpenAlex', 'literature', 'Open scholarly graph of works, authors, venues, and concepts.', ['json'], 'https://openalex.org/'],
  ['semantic_scholar', 'Semantic Scholar', 'literature', 'Academic graph with citations, references, and influence signals.', ['json'], 'https://www.semanticscholar.org/'],
  ['crossref', 'Crossref', 'literature', 'Cross-publisher DOI metadata, references, and citation counts.', ['json'], 'https://www.crossref.org/'],
  ['arxiv', 'arXiv', 'literature', 'Open-access preprints across quantitative biology and adjacent fields.', ['json', 'pdf-link'], 'https://arxiv.org/'],
  ['clinvar', 'ClinVar', 'clinical', 'Clinical variant interpretations through NCBI E-utilities.', ['json', 'xml'], 'https://www.ncbi.nlm.nih.gov/clinvar/'],
  ['opentargets', 'Open Targets', 'clinical', 'Target, disease, drug, and evidence graph.', ['json'], 'https://platform.opentargets.org/'],
  ['chembl', 'ChEMBL', 'chemistry', 'Curated bioactive molecules, activities, and drug discovery metadata.', ['json'], 'https://www.ebi.ac.uk/chembl/'],
  ['alphafold', 'AlphaFold DB', 'structure', 'Predicted protein structures with confidence metadata.', ['json', 'cif', 'pdb'], 'https://alphafold.ebi.ac.uk/'],
  ['cellxgene', 'CELLxGENE', 'omics', 'Single-cell dataset discovery and downloadable h5ad assets.', ['json', 'links'], 'https://cellxgene.cziscience.com/'],
  ['dbsnp', 'dbSNP', 'genomics', 'NCBI dbSNP refSNP summaries with mapping, allele, and clinical-significance metadata.', ['json', 'xml'], 'https://www.ncbi.nlm.nih.gov/snp/'],
  ['gnomad', 'gnomAD', 'genomics', 'gnomAD population allele frequencies and variant lookup.', ['json'], 'https://gnomad.broadinstitute.org/'],
  ['gtex', 'GTEx', 'omics', 'GTEx Portal gene annotation and tissue expression resource.', ['json'], 'https://gtexportal.org/'],
  ['jaspar', 'JASPAR', 'biology', 'JASPAR transcription factor binding-site matrix profiles.', ['json', 'jaspar', 'pfm'], 'https://jaspar.elixir.no/'],
].map(([id, name, domain, description, download_formats, homepage]) => ({
  id, name, domain, description, download_formats, homepage, auth: 'none', parameters: [], ...sourceContracts[id],
  pagination: ({
    pubmed: 'offset', europepmc: 'page', biorxiv: 'page', openalex: 'page', semantic_scholar: 'offset', crossref: 'offset', arxiv: 'offset',
    uniprot: 'offset', ncbi_gene: 'offset', rcsb_pdb: 'offset', geo: 'offset', clinvar: 'offset', chembl: 'offset', opentargets: 'page', cellxgene: 'bounded',
    dbsnp: 'offset', gtex: 'page', jaspar: 'page', gnomad: 'bounded',
  })[id] || 'bounded',
}));

const byId = new Map(catalog.map((entry) => [entry.id, entry]));
const registry = new ConnectorRegistry();
for (const entry of catalog) {
  registry.register({
    ...entry,
    downloadFormats: entry.download_formats,
    search: (query, options) => searchPage(entry, query, options),
    fetch: (id, options) => fetchRecord(entry.id, id, options?.params),
  });
}

export function getCatalogEntry(source) {
  return byId.get(source);
}

function assertSource(source) {
  const entry = getCatalogEntry(source);
  if (!entry) throw new CliError('unknown-source', `Unknown science connector: ${source}.`, 2);
  return entry;
}

export class CliError extends Error {
  constructor(code, message, exitCode = 1, { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
  }
}

async function response(url, options = {}) {
  try {
    return await http.request(String(url), options);
  } catch (error) {
    const code = error instanceof HttpError && error.status === 404 ? 'not-found' : error instanceof HttpError && error.status ? 'upstream' : 'network';
    throw new CliError(code, error instanceof Error ? error.message : String(error), 1, { retryable: error instanceof HttpError ? error.retryable : true });
  }
}

async function json(url, options) {
  try {
    return await http.json(String(url), options);
  } catch (error) {
    const code = error instanceof HttpError && error.status === 404 ? 'not-found' : error instanceof HttpError && error.status ? 'upstream' : 'network';
    throw new CliError(code, error instanceof Error ? error.message : String(error), 1, { retryable: error instanceof HttpError ? error.retryable : true });
  }
}

async function text(url, options) {
  return response(url, options).then((value) => value.body);
}

function clean(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function year(value) {
  return String(value || '').match(/\b(?:19|20)\d{2}\b/)?.[0];
}

function authors(value) {
  return String(value || '').split(/,\s*|\s+and\s+/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

function labels(value) {
  return (Array.isArray(value) ? value : [value]).map((item) => typeof item === 'string' ? item : item?.label || item?.ontology_term_id || '').filter(Boolean);
}

function invertedAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  return Object.entries(index).flatMap(([word, positions]) => (positions || []).map((position) => [position, word]))
    .sort(([left], [right]) => left - right).map(([, word]) => word).join(' ');
}

function atomEntries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, block]) => {
    const value = (tag) => block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]?.replace(/\s+/g, ' ').trim() || '';
    const links = [...block.matchAll(/<link\s+([^>]+?)\/?>(?:<\/link>)?/g)];
    const pdf = links.map(([, attrs]) => attrs.match(/href="([^"]+)"/)?.[1]).find((href, index) => /title="pdf"/i.test(links[index][1]));
    return { id: value('id'), title: value('title'), summary: value('summary'), published: value('published'), doi: value('arxiv:doi'), category: block.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1], authors: [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((match) => match[1].trim()), pdf };
  });
}

function openTargetsSearch(query, limit, offset, entity) {
  const entityNames = entity ? [entity] : ['target', 'disease', 'drug'];
  return {
    query: 'query Search($q: String!, $entities: [String!]!, $page: Pagination!) { search(queryString: $q, entityNames: $entities, page: $page) { hits { id name entity description } } }',
    variables: { q: query, entities: entityNames, page: { index: Math.floor(offset / limit), size: Math.min(limit, 100) } },
  };
}

function openTargetsHits(data, source) {
  return (data?.data?.search?.hits || []).map((item) => {
    const entity = item.entity || 'target';
    return hit(item.id, item.name || item.id, item.description || entity, `https://platform.opentargets.org/${entity}/${item.id}`, { source, domain: 'clinical', entity });
  }).filter((item) => item.id);
}

function hit(id, title, summary, url, extra) {
  return { id: String(id), title: clean(title), summary: clean(summary), url, extra };
}

async function ncbiSearch(db, query, limit, offset = 0) {
  const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
  searchUrl.search = new URLSearchParams({ db, term: query, retmode: 'json', retmax: String(limit), retstart: String(offset) });
  const ids = (await json(searchUrl)).esearchresult?.idlist || [];
  if (!ids.length) return [];
  const summaryUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
  summaryUrl.search = new URLSearchParams({ db, id: ids.join(','), retmode: 'json' });
  return { ids, result: (await json(summaryUrl)).result || {} };
}

const GNOMAD_API = 'https://gnomad.broadinstitute.org/api';
const GNOMAD_REFERENCE_GENOMES = { gnomad_r4: 'GRCh38', gnomad_r3: 'GRCh38', gnomad_r2_1: 'GRCh37', exac: 'GRCh37' };
const GNOMAD_VARIANT_FIELDS = 'variant_id chrom pos ref alt caid rsids flags exome { ac an homozygote_count } genome { ac an homozygote_count } joint { ac an homozygote_count } transcript_consequences { gene_id gene_symbol hgvsc hgvsp consequence_terms is_canonical }';

function gnomadDataset(params = {}) {
  const dataset = params.dataset || 'gnomad_r4';
  const referenceGenome = GNOMAD_REFERENCE_GENOMES[dataset];
  if (!referenceGenome) throw new CliError('invalid-input', `gnomAD --param dataset must be one of ${Object.keys(GNOMAD_REFERENCE_GENOMES).join(', ')}.`, 2);
  return { dataset, referenceGenome };
}

async function gnomadQuery(query, variables = {}) {
  const payload = await json(GNOMAD_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    rateLimit: { maxConcurrent: 1, minIntervalMs: 500 },
  });
  const errors = (payload.errors || []).map((error) => error.message).filter(Boolean);
  const notFound = errors.length > 0 && errors.every((message) => /not found/i.test(message));
  if (errors.length && !notFound) throw new CliError('upstream', `gnomAD API error: ${errors.join('; ')}`);
  return { data: payload.data || {}, notFound };
}

function normalizeGnomadVariantId(value) {
  const match = /^(?:chr)?(\d+|x|y|m|mt)[-:./_|\s]?([\d,]+)[-:./_|\s]?([acgt]+)[-:./_|\s>]([acgt]+)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const chrom = match[1].toUpperCase().replace(/^chr/i, '');
  const chromNumber = Number(chrom);
  if (!Number.isNaN(chromNumber) && (chromNumber < 1 || chromNumber > 22)) return null;
  const pos = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(pos)) return null;
  return `${chrom}-${pos}-${match[3].toUpperCase()}-${match[4].toUpperCase()}`;
}

function isRsId(value) {
  return /^rs\d+$/i.test(String(value || '').trim());
}

function gnomadVariantDetailsQuery(argument) {
  return `query($value: String!, $dataset: DatasetId!) { variant(${argument}: $value, dataset: $dataset) { ${GNOMAD_VARIANT_FIELDS} } }`;
}

function gnomadVariantHit(variant, dataset) {
  if (!variant?.variant_id) return null;
  const consequences = variant.transcript_consequences || [];
  const consequence = consequences.find((item) => item.is_canonical) || consequences[0] || {};
  const frequencies = [variant.joint, variant.genome, variant.exome].find((value) => value && value.an);
  const af = frequencies?.an ? frequencies.ac / frequencies.an : undefined;
  const summary = [
    `${variant.chrom}:${variant.pos} ${variant.ref}>${variant.alt}`,
    consequence.gene_symbol,
    consequence.hgvsc || consequence.hgvsp,
    af !== undefined ? `AF ${af.toPrecision(3)}` : '',
  ].filter(Boolean).join(' | ');
  return hit(variant.variant_id, variant.variant_id, summary, `https://gnomad.broadinstitute.org/variant/${variant.variant_id}?dataset=${dataset}`, {
    source: 'gnomad', domain: 'genomics', dataset, chrom: variant.chrom, pos: variant.pos, ref: variant.ref, alt: variant.alt,
    rsids: variant.rsids || [], gene_symbol: consequence.gene_symbol, gene_id: consequence.gene_id,
    consequence: consequence.consequence_terms?.[0], hgvsc: consequence.hgvsc, hgvsp: consequence.hgvsp,
    ac: frequencies?.ac, an: frequencies?.an, af,
  });
}

function gnomadGeneHit(gene, dataset, referenceGenome) {
  const symbol = gene.symbol || gene.ensembl_id;
  return hit(gene.ensembl_id, `${symbol} ${gene.ensembl_id}`, [referenceGenome, `Ensembl ${gene.ensembl_id}${gene.ensembl_version ? `.${gene.ensembl_version}` : ''}`, dataset].filter(Boolean).join(' | '), `https://gnomad.broadinstitute.org/gene/${gene.ensembl_id}?dataset=${dataset}`, {
    source: 'gnomad', domain: 'genomics', dataset, reference_genome: referenceGenome, ensembl_id: gene.ensembl_id, ensembl_version: gene.ensembl_version, gene_symbol: symbol,
  });
}

function gtexOptions(params = {}) {
  const gencodeVersion = params.gencodeVersion || 'v26';
  const genomeBuild = gencodeVersion === 'v19' ? 'GRCh37/hg19' : 'GRCh38/hg38';
  return { gencodeVersion, genomeBuild };
}

function gtexGeneHit(gene) {
  const symbol = gene.geneSymbol || gene.gencodeId;
  const location = [gene.chromosome, gene.start && gene.end ? `${gene.start}-${gene.end}` : '', gene.strand].filter(Boolean).join(':');
  return hit(gene.gencodeId, `${symbol} ${gene.description || ''}`, [gene.description, gene.geneType, location, `Entrez ${gene.entrezGeneId ?? 'n/a'}`].filter(Boolean).join(' | '), `https://gtexportal.org/home/gene/${gene.gencodeId}`, {
    source: 'gtex', domain: 'omics', gene_symbol: symbol, gene_id: gene.gencodeId, entrez_gene_id: gene.entrezGeneId, chromosome: gene.chromosome, start: gene.start, end: gene.end, strand: gene.strand, gene_type: gene.geneType, genome_build: gene.genomeBuild, gencode_version: gene.gencodeVersion,
  });
}

async function searchOne(source, query, limit, organism, params, offset = 0) {
  switch (source) {
    case 'pubmed': {
      const data = await ncbiSearch('pubmed', query, limit, offset);
      return data.ids.map((id) => {
        const item = data.result[id] || {};
        const doi = item.articleids?.find((value) => value.idtype === 'doi')?.value;
        return hit(id, item.title, [item.source, item.pubdate].filter(Boolean).join(' | '), `https://pubmed.ncbi.nlm.nih.gov/${id}/`, { source, domain: 'literature', doi, pmid: id, year: year(item.pubdate), authors: item.authors?.map((author) => author.name).filter(Boolean), journal: item.source });
      });
    }
    case 'europepmc': {
      const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
      url.search = new URLSearchParams({ query, format: 'json', pageSize: String(limit), page: String(Math.floor(offset / limit) + 1) });
      return ((await json(url)).resultList?.result || []).map((item) => hit(item.id || item.pmid || item.doi, item.title, item.abstractText || [item.journalTitle, item.pubYear].filter(Boolean).join(' | '), item.doi ? `https://doi.org/${item.doi}` : `https://europepmc.org/article/${item.source || 'MED'}/${item.id}`, { source, domain: 'literature', doi: item.doi, pmid: item.pmid, year: item.pubYear, authors: authors(item.authorString), journal: item.journalTitle })).filter((item) => item.id && item.title);
    }
    case 'biorxiv': {
      const from = params.fromDate || dateDaysAgo(365);
      const to = params.toDate || today();
      const records = (await json(`https://api.biorxiv.org/details/biorxiv/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${Math.floor(offset / 100)}`)).collection || [];
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return records.filter((item) => words.every((word) => `${item.title || ''} ${item.abstract || ''} ${item.authors || ''}`.toLowerCase().includes(word))).slice(offset % 100, (offset % 100) + limit).map((item) => hit(item.doi, item.title, item.abstract, item.doi ? `https://doi.org/${item.doi}` : '', { source, domain: 'literature', doi: item.doi, year: year(item.date), authors: authors(item.authors), journal: item.server || 'bioRxiv' })).filter((item) => item.id && item.title);
    }
    case 'crossref': {
      const url = new URL('https://api.crossref.org/works');
      url.search = new URLSearchParams({ query, rows: String(Math.min(limit, 100)), offset: String(offset), select: 'DOI,title,abstract,author,container-title,URL,issued,is-referenced-by-count' });
      return ((await json(url)).message?.items || []).map((item) => hit(item.DOI, item.title?.[0], item.abstract || [item['container-title']?.[0], item.issued?.['date-parts']?.[0]?.[0]].filter(Boolean).join(' | '), item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''), { source, domain: 'literature', doi: item.DOI, year: item.issued?.['date-parts']?.[0]?.[0], authors: (item.author || []).map((author) => [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean), journal: item['container-title']?.[0], citation_count: item['is-referenced-by-count'] })).filter((item) => item.id && item.title);
    }
    case 'openalex': {
      const url = new URL('https://api.openalex.org/works');
      url.search = new URLSearchParams({ search: query, 'per-page': String(Math.min(limit, 100)), page: String(Math.floor(offset / limit) + 1), mailto: params.mailto || 'science-search@example.invalid' });
      return ((await json(url)).results || []).map((item) => hit(String(item.id || '').replace(/^https?:\/\/openalex\.org\//, ''), item.display_name || item.title, invertedAbstract(item.abstract_inverted_index) || [item.primary_location?.source?.display_name, item.publication_year].filter(Boolean).join(' | '), item.id || item.doi || item.primary_location?.landing_page_url || '', { source, domain: 'literature', doi: item.doi?.replace(/^https?:\/\/doi\.org\//, ''), year: item.publication_year, authors: (item.authorships || []).map((author) => author.author?.display_name).filter(Boolean), journal: item.primary_location?.source?.display_name, citation_count: item.cited_by_count, open_access: item.open_access?.is_oa })).filter((item) => item.id && item.title);
    }
    case 'semantic_scholar': {
      const fields = 'title,abstract,url,year,venue,citationCount,externalIds,authors.name';
      const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
      url.search = new URLSearchParams({ query, limit: String(Math.min(limit, 100)), offset: String(offset), fields });
      const key = params.apiKey || process.env.SEMANTIC_SCHOLAR_API_KEY;
      return ((await json(url, { headers: key ? { 'x-api-key': key } : {}, rateLimit: { minIntervalMs: 1_000 } })).data || []).map((item) => hit(item.paperId, item.title, item.abstract || [item.venue, item.year].filter(Boolean).join(' | '), item.url || `https://www.semanticscholar.org/paper/${item.paperId}`, { source, domain: 'literature', doi: item.externalIds?.DOI, pmid: item.externalIds?.PubMed, arxiv_id: item.externalIds?.ArXiv, year: item.year, authors: (item.authors || []).map((author) => author.name).filter(Boolean), journal: item.venue, citation_count: item.citationCount })).filter((item) => item.id && item.title);
    }
    case 'arxiv': {
      const expression = /^(ti|au|abs|co|jr|cat|rn|id|all):/i.test(query.trim()) ? query.trim() : `all:${query.trim()}`;
      const xml = await text(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(expression)}&start=${offset}&max_results=${Math.min(limit, 100)}&sortBy=relevance`, { rateLimit: { minIntervalMs: 3_000 }, looksValid: (body) => /<feed[\s>]/i.test(body) });
      if (!/<feed[\s>]/i.test(xml)) throw new CliError('upstream', 'arXiv returned a non-Atom response.');
      return atomEntries(xml).map((item) => hit(item.id.replace(/^https?:\/\/arxiv\.org\/abs\//, ''), item.title, item.summary, item.id, { source, domain: 'literature', doi: item.doi, arxiv_id: item.id.replace(/^https?:\/\/arxiv\.org\/abs\//, ''), year: year(item.published), authors: item.authors, journal: item.category, pdf: item.pdf })).filter((item) => item.id && item.title);
    }
    case 'uniprot': {
      const url = new URL('https://rest.uniprot.org/uniprotkb/search');
      url.search = new URLSearchParams({ query, format: 'json', size: String(Math.min(limit, 500)), offset: String(offset) });
      return ((await json(url)).results || []).map((item) => hit(item.primaryAccession, `${item.primaryAccession} ${item.proteinDescription?.recommendedName?.fullName?.value || ''}`, [item.organism?.scientificName, (item.genes || []).map((gene) => gene.geneName?.value).filter(Boolean).join(', ')].filter(Boolean).join(' | '), `https://www.uniprot.org/uniprotkb/${item.primaryAccession}/entry`, { source, domain: 'proteomics' }));
    }
    case 'ncbi_gene': {
      const data = await ncbiSearch('gene', query, limit, offset);
      return data.ids.map((id) => { const item = data.result[id] || {}; return hit(id, `${item.name || ''} ${item.description || ''}`, [item.organism?.scientificname, item.summary].filter(Boolean).join(' | '), `https://www.ncbi.nlm.nih.gov/gene/${id}`, { source, domain: 'genomics' }); });
    }
    case 'ensembl': {
      const species = organism || params.species || 'homo_sapiens';
      const data = await json(`https://rest.ensembl.org/xrefs/symbol/${encodeURIComponent(species)}/${encodeURIComponent(query)}?content-type=application/json`);
      return data.slice(0, limit).map((item) => hit(item.id, `${item.display_id || query} ${item.id || ''}`, [item.type, item.description, species].filter(Boolean).join(' | '), `https://www.ensembl.org/${species}/Gene/Summary?g=${item.id}`, { source, domain: 'genomics', species }));
    }
    case 'reactome': {
      const url = new URL('https://reactome.org/ContentService/search/query');
      url.search = new URLSearchParams({ query, cluster: 'true' });
      const entries = Object.values((await json(url)).results || {}).flatMap((group) => group?.entries || []);
      return entries.slice(0, limit).map((item) => hit(item.stId || item.dbId || item.id, item.name || item.displayName, [item.schemaClass, item.species?.[0]?.name].filter(Boolean).join(' | '), item.stId ? `https://reactome.org/content/detail/${item.stId}` : 'https://reactome.org/', { source, domain: 'pathways' })).filter((item) => item.id && item.title);
    }
    case 'kegg': {
      const db = params.db || 'genes';
      const data = await text(`https://rest.kegg.jp/find/${encodeURIComponent(db)}/${encodeURIComponent(query)}`);
      return data.split('\n').filter(Boolean).slice(0, limit).map((line) => { const [id, description] = line.split('\t'); return hit(id, description || id, `${db} | ${description || ''}`, `https://www.kegg.jp/entry/${encodeURIComponent(id)}`, { source, domain: 'pathways', db }); });
    }
    case 'rcsb_pdb': {
      const data = await json('https://search.rcsb.org/rcsbsearch/v2/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { type: 'terminal', service: 'text', parameters: { value: query } }, return_type: 'entry', request_options: { paginate: { start: offset, rows: limit } } }) });
      return (data.result_set || []).map((item) => hit(item.identifier, item.identifier, `RCSB PDB score ${item.score ?? ''}`, `https://www.rcsb.org/structure/${item.identifier}`, { source, domain: 'structure', score: item.score }));
    }
    case 'interpro': {
      const url = new URL('https://www.ebi.ac.uk/interpro/api/entry/interpro/');
      url.search = new URLSearchParams({ search: query, page_size: String(limit) });
      return ((await json(url)).results || []).map((item) => hit(item.metadata?.accession, item.metadata?.name || item.metadata?.accession, item.metadata?.type || item.metadata?.source_database, `https://www.ebi.ac.uk/interpro/entry/InterPro/${item.metadata?.accession}/`, { source, domain: 'proteomics' })).filter((item) => item.id && item.title);
    }
    case 'string': {
      const species = params.species || '9606';
      const url = new URL('https://string-db.org/api/json/get_string_ids');
      url.search = new URLSearchParams({ identifiers: query, species: String(species), limit: String(limit) });
      return (await json(url)).map((item) => hit(item.stringId, `${item.preferredName || query} ${item.annotation || ''}`, [item.ncbiTaxonId, item.annotation].filter(Boolean).join(' | '), `https://string-db.org/network/${item.stringId}`, { source, domain: 'biology', species }));
    }
    case 'geo': {
      const terms = [query, params.organism || organism, params.study_type].filter(Boolean).join(' AND ');
      const data = await ncbiSearch('gds', terms, limit, offset);
      return data.ids.map((id) => { const item = data.result[id] || {}; return hit(id, item.title || item.accession || id, [item.gdsType, item.summary].filter(Boolean).join(' | '), item.accession ? `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${item.accession}` : `https://www.ncbi.nlm.nih.gov/gds/?term=${id}`, { source, domain: 'omics', accession: item.accession, organism: item.taxon, study_type: item.gdsType, samples: item.n_samples, platform: item.pdattim }); });
    }
    case 'clinvar': {
      const data = await ncbiSearch('clinvar', query, limit, offset);
      return data.ids.map((id) => { const item = data.result[id] || {}; return hit(id, item.title || item.accession || id, [item.germline_classification?.description, item.trait_set?.map((trait) => trait.trait_name).join(', ')].filter(Boolean).join(' | '), `https://www.ncbi.nlm.nih.gov/clinvar/variation/${id}/`, { source, domain: 'clinical', clinvar_id: id, genes: item.genes, clinical_significance: item.germline_classification?.description, traits: item.trait_set }); });
    }
    case 'chembl': {
      const data = await json(`https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 100)}&offset=${offset}`);
      return (data.molecules || []).map((item) => hit(item.molecule_chembl_id, item.pref_name || item.molecule_chembl_id, [item.molecule_properties?.full_molformula && `Formula ${item.molecule_properties.full_molformula}`, item.molecule_properties?.full_mwt && `MW ${item.molecule_properties.full_mwt}`, item.max_phase != null && `Max phase ${item.max_phase}`].filter(Boolean).join(' | '), `https://www.ebi.ac.uk/chembl/explore/compound/${item.molecule_chembl_id}`, { source, domain: 'chemistry', smiles: item.molecule_structures?.canonical_smiles, max_phase: item.max_phase })).filter((item) => item.id);
    }
    case 'alphafold': {
      const accession = /^[A-Z0-9]{6,10}$/i.test(query) ? query : (await searchOne('uniprot', query, 1, organism, params, offset))[0]?.id;
      if (!accession) return [];
      const records = await json(`https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(accession)}`);
      return records.map((item) => hit(item.uniprotAccession || accession, item.uniprotDescription || item.uniprotAccession || accession, [item.gene, item.modelCreatedDate, item.globalMetricValue && `mean pLDDT ${item.globalMetricValue}`].filter(Boolean).join(' | '), item.entryId ? `https://alphafold.ebi.ac.uk/entry/${item.entryId}` : '', { source, domain: 'structure', structure_provenance: 'predicted', model_version: item.latestVersion, mean_plddt: item.globalMetricValue, cif_url: item.cifUrl, pdb_url: item.pdbUrl })).filter((item) => item.id);
    }
    case 'cellxgene': {
      const url = new URL('https://api.cellxgene.cziscience.com/curation/v1/datasets');
      if (query) url.searchParams.set('query', query);
      if (params.organism || organism) url.searchParams.set('organism', params.organism || organism);
      if (params.tissue) url.searchParams.set('tissue', params.tissue);
      if (params.disease) url.searchParams.set('disease', params.disease);
      const data = await json(url);
      const requestedTerms = [query, params.organism || organism, params.tissue, params.disease].filter(Boolean).map((value) => String(value).toLowerCase());
      return (data.datasets || data || []).filter((item) => {
        const searchable = [item.dataset_title, item.title, item.collection_name, ...labels(item.organism), ...labels(item.tissue), ...labels(item.disease), ...labels(item.assay)].join(' ').toLowerCase();
        return requestedTerms.every((term) => searchable.includes(term));
      }).slice(offset, offset + limit).map((item) => hit(item.dataset_id || item.id, item.dataset_title || item.title || item.dataset_id, [item.collection_name, item.cell_count && `${item.cell_count} cells`, labels(item.assay).join(', ')].filter(Boolean).join(' | '), item.explorer_url || `https://cellxgene.cziscience.com/e/${item.dataset_id || item.id}.cxg/`, { source, domain: 'omics', organism: item.organism, tissue: item.tissue, disease: item.disease, assay: item.assay, cell_count: item.cell_count, assets: item.assets })).filter((item) => item.id);
    }
    case 'opentargets': {
      const payload = openTargetsSearch(query, limit, offset, params.entity);
      const data = await json('https://api.platform.opentargets.org/api/v4/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return openTargetsHits(data, source);
    }
    case 'dbsnp': {
      const data = await ncbiSearch('snp', query, Math.min(limit, 100), offset);
      if (!data.ids) return [];
      return data.ids.map((uid) => {
        const item = data.result[uid] || {};
        // ESearch for dbSNP can also return submitted-SNP (ss) documents; keep refSNP records only.
        if (item.error || String(item.snp_id) !== String(uid)) return null;
        const genes = (item.genes || []).map((gene) => gene.name).filter(Boolean);
        const maf = (item.global_mafs || []).map((entry) => `${entry.study} ${entry.freq}`).filter(Boolean).slice(0, 4);
        return hit(`rs${uid}`, `rs${uid}${genes.length ? ` ${genes.join(', ')}` : ''}`, [item.chrpos, item.snp_class, genes.length ? `genes ${genes.join(', ')}` : '', item.clinical_significance ? `clinical ${item.clinical_significance}` : ''].filter(Boolean).join(' | '), `https://www.ncbi.nlm.nih.gov/snp/rs${uid}`, {
          source, domain: 'genomics', rsid: `rs${uid}`, chr: item.chr, chrpos: item.chrpos, spdi: item.spdi, genes, allele: item.allele, snp_class: item.snp_class, clinical_significance: item.clinical_significance, global_mafs: maf, validated: item.validated ? String(item.validated).split(',') : [],
        });
      }).filter((item) => item?.id && item.title);
    }
    case 'gnomad': {
      const { dataset, referenceGenome } = gnomadDataset(params);
      const trimmed = String(query || '').trim();
      const variantId = normalizeGnomadVariantId(trimmed);
      if (isRsId(trimmed) || variantId) {
        if (offset > 0) return [];
        const byRsid = isRsId(trimmed);
        const result = await gnomadQuery(gnomadVariantDetailsQuery(byRsid ? 'rsid' : 'variantId'), { value: byRsid ? trimmed.toLowerCase() : variantId, dataset });
        const variant = gnomadVariantHit(result.data.variant, dataset);
        return variant ? [variant] : [];
      }
      if (/^(?:ca\d+|\d+)$/i.test(trimmed)) {
        const search = await gnomadQuery('query($query: String!, $dataset: DatasetId!) { variant_search(query: $query, dataset: $dataset) { variant_id } }', { query: trimmed, dataset });
        const ids = (search.data.variant_search || []).map((item) => item.variant_id).filter(Boolean).slice(offset, offset + limit);
        if (!ids.length) return [];
        const detailsQuery = `query($dataset: DatasetId!, ${ids.map((_, index) => `$id${index}: String!`).join(', ')}) { ${ids.map((_, index) => `v${index}: variant(variantId: $id${index}, dataset: $dataset) { ${GNOMAD_VARIANT_FIELDS} }`).join(' ')} }`;
        const details = await gnomadQuery(detailsQuery, { dataset, ...Object.fromEntries(ids.map((id, index) => [`id${index}`, id])) });
        return ids.map((_, index) => gnomadVariantHit(details.data[`v${index}`], dataset)).filter(Boolean);
      }
      const genes = await gnomadQuery('query($query: String!, $genome: ReferenceGenomeId!) { gene_search(query: $query, reference_genome: $genome) { ensembl_id ensembl_version symbol } }', { query: trimmed, genome: referenceGenome });
      return (genes.data.gene_search || []).slice(offset, offset + limit).map((gene) => gnomadGeneHit(gene, dataset, referenceGenome)).filter((item) => item.id);
    }
    case 'gtex': {
      const { gencodeVersion, genomeBuild } = gtexOptions(params);
      const url = new URL('https://gtexportal.org/api/v2/reference/geneSearch');
      url.search = new URLSearchParams({ geneId: String(query || '').trim(), gencodeVersion, genomeBuild, page: String(Math.floor(offset / limit)), itemsPerPage: String(Math.min(limit, 250)) });
      const data = await json(url);
      return (data.data || []).map((gene) => gtexGeneHit(gene)).filter((item) => item.id);
    }
    case 'jaspar': {
      const url = new URL('https://jaspar.elixir.no/api/v1/matrix/');
      url.search = new URLSearchParams({ search: String(query || '').trim(), page: String(Math.floor(offset / limit) + 1), page_size: String(Math.min(limit, 100)) });
      if (params.collection) url.searchParams.set('collection', params.collection);
      if (params.tax_group) url.searchParams.set('tax_group', params.tax_group);
      const data = await json(url);
      return (data.results || []).map((item) => hit(item.matrix_id, `${item.matrix_id} ${item.name || ''}`, [item.collection, `base ${item.base_id}`, `v${item.version}`].filter(Boolean).join(' | '), `https://jaspar.elixir.no/matrix/${item.matrix_id}/`, {
        source, domain: 'biology', matrix_id: item.matrix_id, name: item.name, base_id: item.base_id, version: item.version, collection: item.collection, sequence_logo: item.sequence_logo,
      })).filter((item) => item.id && item.title);
    }
    default: throw new CliError('unknown-source', `Unknown science connector: ${source}.`, 2);
  }
}

function dedupe(hits) {
  const seen = new Set();
  return hits.filter((item) => { const key = String(item.extra?.doi || item.extra?.pmid || `${item.url || ''}:${item.id}`).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

async function searchPage(connector, query, { limit, cursor, organism, params }) {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new CliError('invalid-cursor', `Invalid cursor for ${connector.id}.`, 2);
  // Every connector adapter receives a source-level offset.  The composite
  // cursor only stores those source offsets and never replays a merged page.
  const requested = Math.min(limit + 1, 100);
  const sourcePage = await searchOne(connector.id, query, requested, organism, params, offset);
  // Keep the probe record in the connector buffer.  Advancing the upstream
  // offset before retaining it would silently skip one record per source page.
  return { items: sourcePage, nextCursor: sourcePage.length > limit || sourcePage.length === requested ? String(offset + sourcePage.length) : null };
}

export async function search({ query, sources, domains, limit = 10, cursor, organism, params = {}, registry: activeRegistry = registry }) {
  let selected;
  try {
    selected = activeRegistry.resolve({ sources, domains });
  } catch (error) {
    throw new CliError('unknown-source', error instanceof Error ? error.message : String(error), 2);
  }
  if (!selected.length) throw new CliError('no-sources', 'No connectors match the requested source or domain filter.', 2);
  let state;
  try {
    state = decodeCursor(cursor, query, selected.map((entry) => entry.id), limit);
  } catch (error) {
    throw new CliError('invalid-cursor', error instanceof Error ? error.message : String(error), 2);
  }
  const issues = [];
  const output = [];
  const seen = new Set();
  let sourceIndex = 0;

  while (output.length < limit) {
    const active = selected.filter((entry) => {
      const source = state.sources[entry.id];
      return source.buffer?.length || !source.done;
    });
    if (!active.length) break;
    const entry = active[sourceIndex % active.length];
    sourceIndex += 1;
    const source = state.sources[entry.id];
    if (!source.buffer?.length && !source.done) {
      try {
        const page = await entry.search(query, { limit: Math.min(limit, MAX_BUFFERED_HITS_PER_SOURCE), cursor: source.cursor, organism, params });
        source.buffer = page.items;
        source.cursor = page.nextCursor;
        source.done = !page.nextCursor;
      } catch (error) {
        issues.push({ source: entry.id, code: error.code || 'upstream', message: error.message || String(error), retryable: error.code !== 'invalid-input' });
        source.done = true;
        continue;
      }
    }
    const candidate = source.buffer?.shift();
    if (!candidate) continue;
    const key = String(candidate.extra?.doi || candidate.extra?.pmid || `${candidate.url || ''}:${candidate.id}`).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(candidate);
    }
  }
  if (!output.length && issues.length === selected.length) throw new CliError('upstream', issues.map((issue) => `${issue.source}: ${issue.message}`).join('; '), 1, { retryable: issues.some((issue) => issue.retryable) });
  const hasMore = selected.some((entry) => {
    const source = state.sources[entry.id];
    return source.buffer?.length || !source.done;
  });
  return { schema_version: 1, items: output, next_cursor: hasMore ? encodeCursor(state) : null, issues };
}

export async function fetchRecord(source, id, params = {}) {
  assertSource(source);
  switch (source) {
    case 'pubmed': { const [hits, xml] = await Promise.all([searchOne('pubmed', id, 1, undefined, {}), text(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${encodeURIComponent(id)}&retmode=xml`)]); if (!hits[0] && !/<PubmedArticle\b/i.test(xml)) return null; return { ...hits[0], abstract: xmlText(xml, 'AbstractText'), raw_xml: xml.slice(0, 12000) }; }
    case 'europepmc': return json(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:${encodeURIComponent(id)}&format=json&pageSize=1`).then((value) => value.resultList?.result?.[0] || { id, error: 'Record not found' });
    case 'biorxiv': return json(`https://api.biorxiv.org/details/biorxiv/${encodeURIComponent(id)}`).then((value) => value.collection?.[0] || { id, error: 'Record not found' });
    case 'uniprot': return json(`https://rest.uniprot.org/uniprotkb/${encodeURIComponent(id)}.json`);
    case 'ncbi_gene': return json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${encodeURIComponent(id)}&retmode=json`);
    case 'ensembl': return json(`https://rest.ensembl.org/lookup/id/${encodeURIComponent(id)}?expand=1;content-type=application/json`);
    case 'reactome': return json(`https://reactome.org/ContentService/data/query/${encodeURIComponent(id)}`);
    case 'kegg': return text(`https://rest.kegg.jp/get/${encodeURIComponent(id)}`);
    case 'rcsb_pdb': return json(`https://data.rcsb.org/rest/v1/core/entry/${encodeURIComponent(id)}`);
    case 'interpro': return json(`https://www.ebi.ac.uk/interpro/api/entry/interpro/${encodeURIComponent(id)}`);
    case 'string': return json(`https://string-db.org/api/json/network?identifiers=${encodeURIComponent(id)}&species=${encodeURIComponent(params.species || '9606')}`);
    case 'geo': return json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gds&id=${encodeURIComponent(id)}&retmode=json`);
    case 'crossref': return json(`https://api.crossref.org/works/${encodeURIComponent(id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''))}`).then((value) => value.message || null);
    case 'openalex': {
      const path = /^10\.\d/.test(id) ? `doi:${id}` : encodeURIComponent(id.replace(/^https?:\/\/openalex\.org\//, ''));
      return json(`https://api.openalex.org/works/${path}`);
    }
    case 'semantic_scholar': {
      const fields = 'title,abstract,url,year,venue,citationCount,externalIds,authors.name,references.title,citations.title';
      const key = params.apiKey || process.env.SEMANTIC_SCHOLAR_API_KEY;
      return json(`https://api.semanticscholar.org/graph/v1/paper/${id}?fields=${fields}`, { headers: key ? { 'x-api-key': key } : {}, rateLimit: { minIntervalMs: 1_000 } });
    }
    case 'arxiv': {
      const xml = await text(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`, { rateLimit: { minIntervalMs: 3_000 } });
      return atomEntries(xml)[0] || null;
    }
    case 'clinvar': return json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&id=${encodeURIComponent(id)}&retmode=json`);
    case 'chembl': return json(`https://www.ebi.ac.uk/chembl/api/data/molecule/${encodeURIComponent(id)}.json`);
    case 'alphafold': return json(`https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(id)}`).then((value) => value[0] || null);
    case 'cellxgene': return json(`https://api.cellxgene.cziscience.com/curation/v1/datasets/${encodeURIComponent(id)}`);
    case 'opentargets': {
      const payload = {
        query: 'query Fetch($id: String!) { target(ensemblId: $id) { id approvedSymbol approvedName biotype } disease(efoId: $id) { id name description } drug(chemblId: $id) { id name drugType } }',
        variables: { id },
      };
      const value = await json('https://api.platform.opentargets.org/api/v4/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return value.data?.target || value.data?.disease || value.data?.drug || null;
    }
    case 'dbsnp': {
      const rsid = String(id).trim().replace(/^rs/i, '');
      if (!/^\d+$/.test(rsid)) throw new CliError('invalid-input', `dbSNP record ids must be rsIDs, for example rs7412.`, 2);
      const value = await json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=snp&id=${encodeURIComponent(rsid)}&retmode=json`);
      const record = value.result?.[rsid];
      return record && !record.error ? record : null;
    }
    case 'gnomad': {
      const { dataset, referenceGenome } = gnomadDataset(params);
      const trimmed = String(id || '').trim();
      if (/^ENSG\d+/i.test(trimmed)) {
        const result = await gnomadQuery('query($id: String!, $genome: ReferenceGenomeId!) { gene(gene_id: $id, reference_genome: $genome) { gene_id gene_version symbol name chrom start stop strand hgnc_id omim_id ncbi_id canonical_transcript_id } }', { id: trimmed.toUpperCase(), genome: referenceGenome });
        return result.notFound ? null : result.data.gene || null;
      }
      if (isRsId(trimmed)) {
        const result = await gnomadQuery(gnomadVariantDetailsQuery('rsid'), { value: trimmed.toLowerCase(), dataset });
        return result.notFound ? null : result.data.variant || null;
      }
      const variantId = normalizeGnomadVariantId(trimmed);
      if (variantId) {
        const result = await gnomadQuery(gnomadVariantDetailsQuery('variantId'), { value: variantId, dataset });
        return result.notFound ? null : result.data.variant || null;
      }
      throw new CliError('invalid-input', `gnomAD record ids must be a variant id, an rsID, or an Ensembl gene id.`, 2);
    }
    case 'gtex': {
      const { gencodeVersion, genomeBuild } = gtexOptions(params);
      const url = new URL('https://gtexportal.org/api/v2/reference/gene');
      url.search = new URLSearchParams({ geneId: String(id || '').trim(), gencodeVersion, genomeBuild });
      const value = await json(url);
      return value.data?.[0] || null;
    }
    case 'jaspar': return json(`https://jaspar.elixir.no/api/v1/matrix/${encodeURIComponent(String(id).trim())}/`);
    default: throw new CliError('unknown-source', `Unknown science connector: ${source}.`, 2);
  }
}

export async function fetchMany(source, ids, { params = {}, fields, fetch = fetchRecord, concurrency = 4 } = {}) {
  assertSource(source);
  const requested = ids.map((id) => String(id).trim()).filter(Boolean);
  if (!requested.length) throw new CliError('missing-input', 'Provide at least one record id.', 2);
  const items = new Array(requested.length);
  const issues = [];
  let next = 0;

  async function worker() {
    while (next < requested.length) {
      const index = next++;
      const id = requested[index];
      try {
        const record = await fetch(source, id, params);
        if (isNotFound(record)) {
          items[index] = { id, status: 'not_found', record: null, field_status: fields ? unavailableFields(fields) : {} };
          continue;
        }
        const projected = projectRecord(record, fields);
        items[index] = { id, status: 'ok', record: projected.record, field_status: projected.field_status };
      } catch (error) {
        if (error instanceof CliError && error.code === 'not-found') {
          items[index] = { id, status: 'not_found', record: null, field_status: fields ? unavailableFields(fields) : {} };
          continue;
        }
        const retryable = error instanceof CliError ? error.retryable : true;
        items[index] = { id, status: 'error', record: null, field_status: fields ? unavailableFields(fields) : {} };
        issues.push({ source, id, code: error instanceof CliError ? error.code : 'internal', message: error instanceof Error ? error.message : String(error), retryable });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requested.length) }, worker));
  return { schema_version: 1, source, items, issues };
}

function isNotFound(record) {
  return record == null || (typeof record === 'object' && /^record not found$/i.test(String(record.error || '')));
}

function projectRecord(record, fields) {
  if (!fields?.length) return { record, field_status: {} };
  const projected = {};
  const field_status = {};
  for (const field of fields) {
    const value = field.split('.').reduce((current, key) => current != null && Object.prototype.hasOwnProperty.call(Object(current), key) ? current[key] : undefined, record);
    const available = value !== undefined && value !== null && value !== '';
    projected[field] = available ? value : null;
    field_status[field] = available ? 'available' : 'unavailable';
  }
  return { record: projected, field_status };
}

function unavailableFields(fields) {
  return Object.fromEntries(fields.map((field) => [field, 'unavailable']));
}

function safeName(value) { return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'science_record'; }

function xmlText(xml, tag) { return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => clean(match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))).filter(Boolean).join('\n'); }

function today() { return new Date().toISOString().slice(0, 10); }
function dateDaysAgo(days) { const value = new Date(); value.setDate(value.getDate() - days); return value.toISOString().slice(0, 10); }

export function planDownload({ source, id, format }) {
  const entry = assertSource(source);
  const selectedFormat = String(format || entry.download_formats[0]).toLowerCase();
  if (!entry.download_formats.includes(selectedFormat)) throw new CliError('unsupported-format', `${entry.name} does not support "${selectedFormat}". Supported formats: ${entry.download_formats.join(', ')}.`, 2);
  return { source, id, format: selectedFormat, connector: entry.name };
}

export async function download({ source, id, format, params = {}, acceptLarge = false }) {
  const plan = planDownload({ source, id, format });
  const selectedFormat = plan.format;
  const name = safeName(id);
  let url;
  let file_name;
  let mime_type = 'application/json';
  let content;
  if (source === 'pubmed' && selectedFormat === 'abstract.txt') {
    const record = await fetchRecord(source, id, params);
    content = record.abstract || record.summary || '';
    file_name = `PMID_${id}_abstract.txt`; mime_type = 'text/plain';
  } else if (source === 'pubmed' && selectedFormat === 'json') {
    const record = await fetchRecord(source, id, params);
    content = JSON.stringify(record, null, 2);
    file_name = `PMID_${id}.json`; mime_type = 'application/json';
  } else if (source === 'biorxiv' && selectedFormat === 'pdf-link') {
    content = `DOI: ${id}\nPDF URL: https://www.biorxiv.org/content/${id}v1.full.pdf\nLanding page: https://doi.org/${id}\n\nThis manifest stores download links instead of fetching the PDF binary.\n`;
    file_name = `biorxiv_${name}_links.txt`; mime_type = 'text/plain';
  } else if (source === 'geo' && selectedFormat === 'links') {
    const record = await fetchRecord(source, id, params); const first = record.result?.[id] || Object.values(record.result || {}).find((item) => item?.accession) || {}; const accession = first.accession || id;
    content = `GEO record: ${id}\nAccession: ${accession}\nLanding page: https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${accession}\nFTP series directory pattern: https://ftp.ncbi.nlm.nih.gov/geo/series/${String(accession).slice(0, -3)}nnn/${accession}/\n\nThis manifest stores GEO links. Download large supplementary/SRA files selectively.\n`;
    file_name = `geo_${safeName(accession)}_links.txt`; mime_type = 'text/plain';
  } else if (['crossref', 'openalex', 'semantic_scholar', 'arxiv', 'clinvar', 'opentargets', 'chembl', 'alphafold', 'cellxgene', 'gnomad', 'gtex', 'jaspar'].includes(source) && selectedFormat === 'json') {
    content = JSON.stringify(await fetchRecord(source, id, params), null, 2);
    file_name = `${name}.${source}.json`; mime_type = 'application/json';
  } else if (source === 'alphafold' && (selectedFormat === 'cif' || selectedFormat === 'pdb')) {
    const record = await fetchRecord(source, id, params);
    url = selectedFormat === 'cif' ? record?.cifUrl : record?.pdbUrl;
    if (!url) throw new CliError('unsupported-format', `AlphaFold record ${id} does not expose a ${selectedFormat} file.`, 2);
    content = await text(url, { maxBytes: acceptLarge ? 250 * 1024 * 1024 : undefined });
    file_name = `${name}.${selectedFormat}`; mime_type = selectedFormat === 'cif' ? 'chemical/x-mmcif' : 'chemical/x-pdb';
  } else if (source === 'cellxgene' && selectedFormat === 'links') {
    const record = await fetchRecord(source, id, params);
    const assets = record?.assets || [];
    content = JSON.stringify({ dataset_id: id, assets, note: 'Review asset metadata before downloading large h5ad files.' }, null, 2);
    file_name = `${name}.cellxgene-links.json`; mime_type = 'application/json';
  } else {
    ({ url, file_name, mime_type } = downloadTarget(source, id, selectedFormat, params));
    content = await text(url, { maxBytes: acceptLarge ? 250 * 1024 * 1024 : undefined });
  }
  return { source, id, format: selectedFormat, file_name, mime_type, content, url };
}

function downloadTarget(source, id, format, params) {
  const name = safeName(id); const e = encodeURIComponent(id);
  switch (source) {
    case 'pubmed': return { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${e}&retmode=xml`, file_name: `PMID_${id}.xml`, mime_type: 'application/xml' };
    case 'europepmc': return format === 'xml' ? { url: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:${e}&format=xml&pageSize=1`, file_name: `europepmc_${name}.xml`, mime_type: 'application/xml' } : { url: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:${e}&format=json&pageSize=1`, file_name: `europepmc_${name}.json`, mime_type: 'application/json' };
    case 'biorxiv': return { url: `https://api.biorxiv.org/details/biorxiv/${e}`, file_name: `biorxiv_${name}.json`, mime_type: 'application/json' };
    case 'uniprot': return { url: `https://rest.uniprot.org/uniprotkb/${e}.${format}`, file_name: `${name}.${format === 'json' ? 'uniprot.json' : format}`, mime_type: format === 'fasta' ? 'text/x-fasta' : format === 'json' ? 'application/json' : 'text/plain' };
    case 'ncbi_gene': return format === 'xml' ? { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=gene&id=${e}&retmode=xml`, file_name: `ncbi_gene_${name}.xml`, mime_type: 'application/xml' } : { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${e}&retmode=json`, file_name: `ncbi_gene_${name}.json`, mime_type: 'application/json' };
    case 'ensembl': return format === 'fasta' ? { url: `https://rest.ensembl.org/sequence/id/${e}?type=${encodeURIComponent(params.seqType || params.type || 'genomic')}`, file_name: `${name}.${params.seqType || params.type || 'genomic'}.fasta`, mime_type: 'text/x-fasta' } : { url: `https://rest.ensembl.org/lookup/id/${e}?expand=1;content-type=application/json`, file_name: `${name}.ensembl.json`, mime_type: 'application/json' };
    case 'reactome': return format === 'sbml' ? { url: `https://reactome.org/ContentService/exporter/sbml/${e}.xml`, file_name: `${name}.sbml.xml`, mime_type: 'application/xml' } : { url: `https://reactome.org/ContentService/data/query/${e}`, file_name: `${name}.reactome.json`, mime_type: 'application/json' };
    case 'kegg': return format === 'kgml' ? { url: `https://rest.kegg.jp/get/${e}/kgml`, file_name: `${name}.kgml`, mime_type: 'application/xml' } : { url: `https://rest.kegg.jp/get/${e}`, file_name: `${name}.kegg.txt`, mime_type: 'text/plain' };
    case 'rcsb_pdb': return format === 'json' ? { url: `https://data.rcsb.org/rest/v1/core/entry/${e}`, file_name: `${name}.rcsb.json`, mime_type: 'application/json' } : format === 'fasta' ? { url: `https://www.rcsb.org/fasta/entry/${e}`, file_name: `${name}.fasta`, mime_type: 'text/x-fasta' } : { url: `https://files.rcsb.org/download/${e}.${format}`, file_name: `${name}.${format}`, mime_type: format === 'cif' ? 'chemical/x-mmcif' : 'chemical/x-pdb' };
    case 'interpro': return { url: `https://www.ebi.ac.uk/interpro/api/entry/interpro/${e}`, file_name: `${name}.interpro.json`, mime_type: 'application/json' };
    case 'string': return { url: `https://string-db.org/api/${format === 'tsv' ? 'tsv' : 'json'}/network?identifiers=${e}&species=${encodeURIComponent(params.species || '9606')}`, file_name: `${name}.string_network.${format}`, mime_type: format === 'tsv' ? 'text/tab-separated-values' : 'application/json' };
    case 'geo': return format === 'xml' ? { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=gds&id=${e}&retmode=xml`, file_name: `geo_${name}.xml`, mime_type: 'application/xml' } : { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gds&id=${e}&retmode=json`, file_name: `geo_${name}.json`, mime_type: 'application/json' };
    case 'crossref': return { url: `https://api.crossref.org/works/${e}`, file_name: `${name}.crossref.json`, mime_type: 'application/json' };
    case 'openalex': return { url: `https://api.openalex.org/works/${e}`, file_name: `${name}.openalex.json`, mime_type: 'application/json' };
    case 'semantic_scholar': return { url: `https://api.semanticscholar.org/graph/v1/paper/${e}`, file_name: `${name}.semantic-scholar.json`, mime_type: 'application/json' };
    case 'arxiv': return { url: `https://export.arxiv.org/api/query?id_list=${e}`, file_name: `${name}.arxiv.xml`, mime_type: 'application/xml' };
    case 'clinvar': return format === 'xml' ? { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=clinvar&id=${e}&retmode=xml`, file_name: `clinvar_${name}.xml`, mime_type: 'application/xml' } : { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&id=${e}&retmode=json`, file_name: `clinvar_${name}.json`, mime_type: 'application/json' };
    case 'chembl': return { url: `https://www.ebi.ac.uk/chembl/api/data/molecule/${e}.json`, file_name: `${name}.chembl.json`, mime_type: 'application/json' };
    case 'dbsnp': {
      const rsid = encodeURIComponent(String(id).trim().replace(/^rs/i, ''));
      return format === 'xml'
        ? { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=snp&id=${rsid}&retmode=xml`, file_name: `dbsnp_${name}.xml`, mime_type: 'application/xml' }
        : { url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=snp&id=${rsid}&retmode=json`, file_name: `dbsnp_${name}.json`, mime_type: 'application/json' };
    }
    case 'jaspar': {
      const matrix = encodeURIComponent(String(id).trim());
      return format === 'jaspar'
        ? { url: `https://jaspar.elixir.no/api/v1/matrix/${matrix}.jaspar`, file_name: `${name}.jaspar`, mime_type: 'text/plain' }
        : { url: `https://jaspar.elixir.no/api/v1/matrix/${matrix}.pfm`, file_name: `${name}.pfm`, mime_type: 'text/plain' };
    }
    default: throw new CliError('unknown-source', `Unknown science connector: ${source}.`, 2);
  }
}
