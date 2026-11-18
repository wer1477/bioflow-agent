# bio-fetch

`bio-fetch` is a machine-first CLI for reproducible, file-producing biological data retrieval. It is deliberately separate from `science-search`: the latter discovers records and retrieves small connector artifacts; this tool manages explicit large-file targets, external download clients, provenance manifests and SRA-to-FASTQ conversion.

It implements the CLI boundary in [clitool development and integration boundary](../docs/clitool-development-boundary.md). It does not automatically integrate with the Agent runtime, coretools, MCP, prompts or any installed skill.

## Requirements

- Node.js 20+
- `datasets` from the [NCBI Datasets command-line tools](https://www.ncbi.nlm.nih.gov/datasets/docs/v2/command-line-tools/download-and-install/) for `genome`
- `prefetch` and `fasterq-dump` from the [SRA Toolkit](https://www.ncbi.nlm.nih.gov/sra/docs/sradownload/) for `sra`

Run locally with `node bin/bio-fetch.js`, or install from this directory with `npm link`.

```bash
bio-fetch --describe --format json
bio-fetch genome --accession GCF_000001405.40 --output ./GRCh38.zip --dry-run
bio-fetch genome --accession GCF_000001405.40 --include genome,gff3,protein,cds --output ./GRCh38.zip
bio-fetch sra --accession SRR11180057 --output ./SRR11180057 --threads 4 --max-disk-gib 100 --dry-run
bio-fetch sra --accession SRR11180057 --output ./SRR11180057 --threads 4 --max-disk-gib 100
```

All successful commands emit one JSON document to stdout. Errors emit one JSON document to stderr. `--describe` publishes the schema and command registry.

## Artifacts and safety

`genome` writes the requested ZIP plus `<output>.bio-fetch.json`, an adjacent manifest containing the command, tool version, SHA-256 and timestamp. NCBI packages include their own post-extraction checksums.

`sra` writes a new output directory containing `sra/`, `fastq/` and `manifest.json`. It records the two tool versions, exact commands and SHA-256 hashes of the FASTQ files. It refuses an existing output path, stages output under a sibling temporary directory and only publishes after every step succeeds. `--max-disk-gib` requires at least that much free space before conversion and checks generated data after each stage; it is a guardrail, not an operating-system quota.

`--dry-run` validates the full plan without invoking external tools, contacting upstream services or writing files. Do not use this CLI for controlled-access data; it supports public NCBI resources only.

## Agent adoption

[`SKILL.md`](SKILL.md) is a distribution template only. An operator must separately install the command and deliberately copy/install that skill into an Agent environment; this package performs neither step automatically.
