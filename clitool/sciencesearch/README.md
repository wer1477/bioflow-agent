# science-search

`science-search` is a standalone, machine-first CLI for biomedical literature and biological databases. It exposes 25 public sources through one stable JSON interface, including literature graphs (OpenAlex, Semantic Scholar, Crossref, arXiv), clinical and chemistry sources (ClinVar, Open Targets, ChEMBL), variation and expression resources (dbSNP, gnomAD, GTEx, JASPAR), predicted structures (AlphaFold DB), and single-cell dataset discovery (CELLxGENE).

It has no runtime package dependencies and requires Node.js 20 or newer.

## Scope and integration boundary

This project follows the shared [clitool development and integration boundary](../docs/clitool-development-boundary.md). All implementation lives in this directory. The CLI does not read or modify Agent configuration, register an MCP server, or add a core tool. It must be installed as a global command before an Agent can invoke it.

`SKILL.md` is a distribution artifact for an operator to copy into an Agent's skills directory when desired. That deployment is intentionally separate from this project: an Agent only learns about this CLI after the operator installs that skill and makes the command available in its environment.

## Run locally

From this directory:

```bash
# 从仓库根目录执行
cd clitool/sciencesearch
npm link
command -v science-search
science-search --describe --format json

# Or invoke directly during development before linking.
node bin/science-search.js --describe --format json
node bin/science-search.js databases --format json
node bin/science-search.js search --query TP53 --source pubmed,uniprot --limit 5 --format json
node bin/science-search.js fetch --source uniprot --id P04637 --format json
```

For a non-development installation, run `npm install -g /absolute/path/to/sciencesearch`.
The Agent backend must be restarted after installation if it was started before the
Node global bin directory was added to PATH.

The package exposes the `science-search` bin name when installed or linked by the operator. Until then, invoke the local `node bin/science-search.js` entry point directly.

## Commands

| Command | Purpose | Write behavior |
| --- | --- | --- |
| `databases` | Discover source ids, domains, descriptions, and supported download formats. | None |
| `search` | Search one or more sources and return normalized result summaries. | None |
| `fetch` | Retrieve one or more detailed source records by `source` and record id. | None |
| `download` | Retrieve a text/structured artifact and write it to an explicit path. | Writes only with `--output`; supports `--dry-run`. |

Use `--describe --format json` as the source of truth for commands, option types, defaults, output schemas, error schema, and each connector's record-id and parameter contract. Use `databases` when an Agent needs a smaller paged view of that live connector registry. Use `<command> --help` for copyable command syntax.

### Search and pagination

```bash
science-search search --query 'TP53' --source pubmed --limit 5 --format json
science-search search --query 'single-cell RNA-seq' --domain literature,omics --limit 10 --format json
science-search search --query TP53 --source string --param species=9606 --format json
science-search search --query BRCA1 --source clinvar --limit 5 --format json
science-search search --query 'lung cancer' --source opentargets --param entity=disease --format json
science-search search --query 'human lung cell atlas' --source cellxgene --param tissue=lung --format json
science-search search --query BRCA1 --source gnomad --param dataset=gnomad_r4 --format json
science-search search --query rs7412 --source dbsnp --limit 5 --format json
science-search search --query TP53 --source gtex --limit 5 --format json
science-search search --query TP53 --source jaspar --param collection=CORE --format json
science-search search --query 17-43057062-T-TG --source gnomad --format json
```

Every search must select exactly one scope: use `--source ID[,ID]` when the target database is known, `--domain` for a bounded discovery pass, or explicit `--all` only when contacting every installed connector is intended. Search returns `items`, an opaque `next_cursor` when another page is available, and `issues` for source-level partial failures. Pass `next_cursor` back unchanged with the same query, source/domain selection, and limit; it stores source-level continuation state and is intentionally not numeric. A completely unavailable requested source returns a non-zero exit code.

Connector-specific options are repeated as `--param KEY=VALUE`. Common examples are `species=9606` for STRING, `species=homo_sapiens` or `seqType=cdna` for Ensembl, `db=pathway` for KEGG, and `fromDate=YYYY-MM-DD` / `toDate=YYYY-MM-DD` for bioRxiv. Literature connectors accept `mailto` (OpenAlex) and `apiKey` (Semantic Scholar, alternatively `SEMANTIC_SCHOLAR_API_KEY`). GEO accepts `organism` and `study_type`; CELLxGENE accepts `organism`, `tissue`, and `disease`; Open Targets accepts `entity=target|disease|drug`. gnomAD accepts `dataset=gnomad_r4|gnomad_r3|gnomad_r2_1|exac` (GRCh38 for the r4/r3 datasets, GRCh37 for r2.1/exac); GTEx accepts `gencodeVersion=v39|v26|v19` (`v19` selects the GRCh37/hg19 annotation); JASPAR accepts `collection` (`CORE`, `CNE`, `PHYLOFACTS`, `SPLICE`, `POLYA`, `UNVALIDATED`) and `tax_group`.

The registry reports each source's pagination capability. `offset` and `page` sources have genuine upstream continuation; `bounded` sources return their public API's bounded result window and therefore may not yield a `next_cursor`.

### Network behavior

All connector traffic goes through one shared transport boundary. It identifies the CLI with a User-Agent, applies a 30-second timeout, retries transient `408`, `429`, and `5xx` responses with `Retry-After`/exponential backoff, and paces each host by default (with stricter source-specific limits for Semantic Scholar, arXiv, and the gnomAD GraphQL endpoint). Successful GETs are cached for five minutes in both the process and a small temporary cache, so repeated CLI invocations can reuse them. Set `SCIENCE_SEARCH_CACHE_DIR` to relocate that cache. A malformed arXiv response is rejected rather than cached. The public gnomAD GraphQL endpoint additionally enforces its own gateway rate limit; repeated gnomAD searches from one client can return `HTTP 429`, which the CLI reports as a retryable `upstream` issue.

### Fetch and download

```bash
science-search fetch --source pubmed --id 12345678 --format json
science-search fetch --source pubmed --ids 12345678,23456789 --fields title,abstract --format json
science-search fetch --source gnomad --id 17-43057062-T-TG --format json
science-search fetch --source gnomad --id ENSG00000012048 --format json
science-search fetch --source gtex --id ENSG00000141510 --format json
science-search fetch --source jaspar --id MA0106.1 --format json
science-search fetch --source dbsnp --id rs7412 --format json
science-search download --source uniprot --id P04637 --format fasta --output ./P04637.fasta --dry-run
science-search download --source uniprot --id P04637 --format fasta --output ./P04637.fasta
science-search download --source alphafold --id P04637 --format cif --output ./P04637.cif --accept-large
science-search download --source jaspar --id MA0106.1 --format pfm --output ./MA0106.1.pfm
science-search download --source dbsnp --id rs7412 --format xml --output ./rs7412.xml
```

`fetch` accepts exactly one of `--id` and `--ids`. The existing single-record `--id` envelope is retained and adds explicit `status` and `field_status`; `--ids` returns ordered `items` and `issues`, so a bad record does not discard a batch. Each batch item carries an explicit `ok`, `not_found`, or `error` status. Use `--fields` with comma-separated source-record property paths (for example `title,abstract`) to return a compact projection. Requested but absent values are emitted as `null` with `field_status: "unavailable"`; without `--fields`, the full source-specific record is retained.

`download --format` selects the connector artifact format such as `fasta`, `cif`, `xml`, `kgml`, `pfm`, or `jaspar`; the command result itself is always JSON. `--output` is required. `--dry-run` validates the source and format but performs neither a network request nor a file write. Real writes are atomic and refuse to replace an existing file unless `--force` is supplied. Responses are capped at 10 MiB by default; use `--accept-large` only for a consciously selected artifact (up to 250 MiB).

Some large or binary-adjacent resources are represented by link manifests rather than downloaded payloads. Inspect `databases` for each connector's `download_formats`.

## Machine contract

- Successful commands write exactly one JSON document to stdout. Logs, warnings, and diagnostics never share stdout.
- Errors write exactly one JSON `Error` envelope to stderr; stdout remains empty. Every error includes a boolean `retryable` signal.
- Exit code `0` means success, `2` means usage/input error, and `1` means upstream or system failure.
- All result envelopes have `schema_version: 1`. Search/list responses use stable `items` and `next_cursor` fields.
- JSON is the only output format. Do not scrape help text or presentation output; use `--describe --format json` and the connector metadata it returns.

## Available sources

| Domain | Sources |
| --- | --- |
| Literature | `pubmed`, `europepmc`, `biorxiv`, `openalex`, `semantic_scholar`, `crossref`, `arxiv` |
| Genomics | `ncbi_gene`, `ensembl`, `dbsnp`, `gnomad` |
| Proteomics | `uniprot`, `interpro` |
| Pathways | `reactome`, `kegg` |
| Structure | `rcsb_pdb`, `alphafold` |
| Biology | `string`, `jaspar` |
| Omics | `geo`, `cellxgene`, `gtex` |
| Clinical | `clinvar`, `opentargets` |
| Chemistry | `chembl` |
