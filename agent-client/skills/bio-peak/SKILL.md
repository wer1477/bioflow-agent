---
name: bio-peak
description: Call peaks with MACS2, discover motifs with HOMER, and create transparent promoter/nearest-TSS peak-to-gene candidates. Use only with an explicit genome assembly and interpret all results as candidate evidence rather than validated regulation.
---

# Bio Peak CLI

Use `bio-peak` to work at the chromatin-accessibility or TF/chromatin-binding
interval layer. It is deliberately separate from `bio-regulatory` (versioned
external evidence lookup) and `bio-grn` (expression-derived network inference).

Inspect its live interface and external-tool availability before planning a
non-dry run:

```bash
command -v bio-peak
bio-peak --describe --format json
bio-peak tools --format json
```

Treat `bio-peak tools` as a gate, not a formality. If `macs2.available` is false,
stop and report the missing executable: `--dry-run` still prints a valid macs2
command line in that state, so a successful dry-run does not prove that `call`
can run. The same rule applies to `findMotifsGenome.pl` before `motif`.

`call` needs a treatment BAM, optional control BAM, explicit assay preset,
explicit MACS2 genome-size value, and a new output directory. Always first
return the command plan for confirmation; this is especially important for the
ATAC-seq shift/extension preset.

```bash
bio-peak call \
  --treatment treatment.bam --control input.bam \
  --assay chip-seq --genome-size hs \
  --output results/chip-peaks --dry-run --format json
```

Run without `--dry-run` only after confirming the assay, assembly/genome-size,
inputs, output directory, and that `macs2` is available. The output manifest
records the MACS2 command and preset. Called peaks are candidate enriched
regions, not validated regulatory elements.

For motif discovery, require a caller-provided matched background BED and a
HOMER genome identifier. Do not silently substitute a background.

```bash
bio-peak motif \
  --peaks results/chip-peaks/bio-peak_peaks.narrowPeak \
  --background matched-background.bed --genome hg38 \
  --output results/motifs --dry-run --format json
```

For peak–gene candidates, use the same declared assembly for the BED/narrowPeak
and GTF. `link` gives promoter overlaps priority; peaks without one receive at
most one nearest-TSS link inside `--max-distance`. State the promoter and
distance rules in any result summary.

```bash
bio-peak link \
  --peaks results/chip-peaks/bio-peak_peaks.narrowPeak \
  --annotation Homo_sapiens.GRCh38.gtf --assembly GRCh38 \
  --output results/peak-gene-links.tsv \
  --dry-run --format json
```

The link table and adjacent manifest are reproducible rule-based candidates;
they do not establish enhancer-promoter contacts, direct TF binding, or
causality. Combine them with prepared `bio-regulatory` evidence and `bio-grn`
candidate edges only while preserving each method's provenance and limitations.
