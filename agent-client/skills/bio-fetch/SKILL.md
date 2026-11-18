---
name: bio-fetch
description: Fetch public NCBI genome packages or an SRA run converted to FASTQ with explicit output paths and reproducibility manifests. Use after an accession is known; use science-search first when discovery or metadata lookup is needed.
---

# bio-fetch

Use this CLI for public, file-producing biological retrieval. It is separate from `science-search`: first discover a GEO, Ensembl, Assembly, BioProject or SRA identifier there, then provide the selected identifier and a user-approved output path here.

Always begin with `--dry-run`. The real commands create files and may consume substantial disk and network resources.

```bash
bio-fetch genome --accession GCF_000001405.40 --include genome,gff3,protein,cds --output ./GRCh38.zip --dry-run --format json
bio-fetch sra --accession SRR11180057 --output ./SRR11180057 --threads 4 --max-disk-gib 100 --dry-run --format json
```

After the operator confirms the exact output path and disk budget, omit `--dry-run`.

```bash
bio-fetch genome --accession GCF_000001405.40 --include genome,gff3,protein,cds --output ./GRCh38.zip --format json
bio-fetch sra --accession SRR11180057 --output ./SRR11180057 --threads 4 --max-disk-gib 100 --format json
```

`genome` needs NCBI `datasets`; `sra` needs SRA Toolkit `prefetch` and `fasterq-dump`. Never claim a download succeeded until the JSON result reports `planned: false` and inspect its manifest path. This tool supports public resources only.
