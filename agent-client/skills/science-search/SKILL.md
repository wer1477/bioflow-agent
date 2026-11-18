---
name: science-search
description: Search, retrieve, and download biomedical literature, clinical variant, chemistry, protein-structure, and omics records through the Science Connectors CLI. Use for PubMed, Europe PMC, bioRxiv, OpenAlex, Semantic Scholar, Crossref, arXiv, UniProt, ClinVar, Open Targets, ChEMBL, AlphaFold DB, GEO, CELLxGENE, dbSNP, gnomAD, GTEx, JASPAR, and the other sources reported by the runtime registry.
---

# Science Search CLI

This Skill invokes the independently packaged CLI. Verify `command -v
science-search` from the Agent Shell before use. It does not register a core
tool.

## Workflow

Start by discovering the installed connector ids, accepted parameters, record-id formats, output schemas, and side effects:

```bash
science-search --describe --format json
science-search databases --format json
```

Search requires exactly one explicit scope: `--source`, `--domain`, or `--all`. Prefer a known source; use a domain for bounded discovery; use `--all` only when every connector is intended. Read `items`, `next_cursor`, and any partial `issues` from the JSON result. `next_cursor` is opaque: return it unchanged with the same query, connector selection, and limit. Fetch a detailed record only after selecting its `source` and `id`.

```bash
science-search search --query 'TP53' --source pubmed --limit 5 --format json
science-search fetch --source pubmed --id 12345678 --format json
science-search fetch --source pubmed --ids 12345678,23456789 --fields title,abstract --format json
```

Variant and expression sources accept their natural identifiers:

```bash
science-search search --query BRCA1 --source gnomad --format json
science-search search --query rs80357906 --source gnomad --format json
science-search search --query 17-43057062-T-TG --source gnomad --format json
science-search fetch --source gnomad --id ENSG00000012048 --format json
science-search search --query rs7412 --source dbsnp --format json
science-search search --query TP53 --source gtex --limit 5 --format json
science-search fetch --source gtex --id ENSG00000141510 --format json
science-search search --query TP53 --source jaspar --param collection=CORE --format json
science-search fetch --source jaspar --id MA0106.1 --fields name,collection,pfm --format json
```

For file artifacts, first run the write operation in preview mode, then call it with the same explicit output path:

```bash
science-search download --source uniprot --id P04637 --format fasta --output ./P04637.fasta --dry-run
science-search download --source uniprot --id P04637 --format fasta --output ./P04637.fasta
science-search download --source jaspar --id MA0106.1 --format pfm --output ./MA0106.1.pfm
```

Use `--ids` when several records are needed: it preserves input order and returns per-record `ok`, `not_found`, or `error` statuses plus structured `issues`, so one failed record does not stop the batch. Use `--fields title,abstract` (or other source-record property paths) to control context size; missing requested values are `null` and explicitly marked unavailable. Check the process exit code. On failure stdout is empty and stderr contains one machine-readable `Error` JSON envelope with `code`, `message`, `hint`, and `retryable`.

Use `--param KEY=VALUE` only for source-specific options, such as `--param species=9606` for STRING, `--param entity=disease` for Open Targets, `--param tissue=lung` for CELLxGENE, `--param study_type=expression profiling` for GEO, `--param dataset=gnomad_r4` for gnomAD, `--param gencodeVersion=v26` for GTEx, and `--param collection=CORE` or `--param tax_group=vertebrates` for JASPAR. The runtime registry and `--help` are authoritative for formats and current options; do not infer them from this skill. Downloads reject overwrite unless given `--force`; use `--accept-large` only when the selected artifact is expected to exceed the default 10 MiB safety cap.
