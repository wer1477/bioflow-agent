---
name: bio-regulatory
description: Prepare versioned CpG-island, ChromHMM, ENCODE peak, or ReMap TF-binding evidence datasets, then query them by gene or genomic region. Use for coordinate-level regulatory context; do not interpret an overlap as proof of functional regulation.
---

# Bio Regulatory Evidence CLI

Use `bio-regulatory` for local, versioned coordinate evidence. It reports CpG
islands, chromatin-state segments, ENCODE peaks, or TF ChIP-seq binding files
only when the caller has selected and prepared explicit source files.

Confirm the command and inspect its live contract first:

```bash
command -v bio-regulatory
bio-regulatory --describe --format json
bio-regulatory sources --format json
```

Reference data is local state and may be large. Always inspect a preparation
plan before downloading or copying data:

```bash
bio-regulatory prepare \
  --source cpg-island \
  --assembly GRCh38 \
  --version hg38-cpgIslandExt \
  --data-dir ./regulatory-reference \
  --dry-run \
  --format json
```

Only after the caller confirms the selected source, version, output location,
and expected disk/network use should the same command be run without `--dry-run`.
For ENCODE, ChromHMM, and ReMap, require an explicit provider URL or local file,
plus the relevant biosample/assay or epigenome metadata.

Then query exactly one gene or one one-based inclusive region. Validate the
selection first:

```bash
bio-regulatory query \
  --region chr17:7661779-7687550 \
  --assembly GRCh38 \
  --data-dir ./regulatory-reference \
  --output results/tp53-evidence.json \
  --dry-run \
  --format json
```

The real command writes evidence JSON and an adjacent manifest with source
versions, hashes, query parameters, and—when a gene symbol is used—the Ensembl
coordinate-resolution record. Report an overlap as coordinate-level evidence,
not as proof of a functional regulatory relationship, direct TF binding, or
causality.
