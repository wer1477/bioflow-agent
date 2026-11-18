# bio-regulatory

`bio-regulatory` prepares explicit, versioned regulatory-evidence files and
queries them by gene or genomic region. It normalizes overlap evidence from
CpG-island, ChromHMM, ENCODE peak, and ReMap TF-binding datasets into one JSON
shape with an adjacent provenance manifest.

An overlap is evidence of co-location, not proof of functional regulation,
direct TF binding, or causality.

## Run locally

This CLI needs Node.js 20+ and has no package runtime dependencies. It reads
and writes only paths supplied by the caller.

```bash
cd clitool/bioregulatory
npm link
command -v bio-regulatory
bio-regulatory --describe --format json
bio-regulatory sources --format json
```

## Prepare an explicit dataset

Reference data is local state: choose a directory outside tracked source files.
Use `--dry-run` before a download. Every preparation records the source URL or
input path, assembly, version, SHA-256, biosample/assay metadata, and timestamp
in `<data-dir>/catalog.json`.

```bash
bio-regulatory prepare \
  --source cpg-island \
  --assembly GRCh38 \
  --version hg38-cpgIslandExt \
  --data-dir ./regulatory-reference \
  --dry-run \
  --format json
```

For ENCODE, ChromHMM, and ReMap, select a concrete provider file and add its
release metadata. For example:

```bash
bio-regulatory prepare \
  --source encode-peak \
  --assembly GRCh38 \
  --version ENCFF000ABC \
  --url https://example.org/ENCFF000ABC.bed.gz \
  --biosample HepG2 \
  --assay ATAC-seq \
  --data-dir ./regulatory-reference \
  --checksum-sha256 <expected-sha256> \
  --dry-run \
  --format json
```

The built-in `cpg-island` GRCh38 source has an official UCSC URL. Other sources
intentionally require an explicit URL or local input: their study, biosample,
release, and file selection are scientific choices that must be recorded.

## Query evidence

Provide exactly one one-based inclusive genomic region or one human gene symbol.
Gene symbols are resolved through Ensembl REST and the resolved record is saved
in the query manifest. The assembly must match the prepared dataset.

```bash
bio-regulatory query \
  --region chr17:7661779-7687550 \
  --assembly GRCh38 \
  --data-dir ./regulatory-reference \
  --output results/tp53-evidence.json \
  --dry-run \
  --format json
```

The real command writes `tp53-evidence.json` plus
`tp53-evidence.json.manifest.json`, refusing existing files unless `--force` is
provided. The manifest records the query, selected dataset versions and hashes,
and a SHA-256 of the evidence JSON.

This CLI is standalone. It does not register an Agent core tool or MCP server;
the separately installed `bio-regulatory` Skill tells an Agent how to invoke it.
See the shared [CLI development and integration boundary](../docs/clitool-development-boundary.md).
