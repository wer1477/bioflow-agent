# bio-peak

`bio-peak` is a machine-friendly adapter for three bounded analysis seams:

- `call` invokes externally installed MACS2 on BAM input;
- `motif` invokes externally installed HOMER with an explicit background BED;
- `link` deterministically links BED/narrowPeak intervals to promoter-overlapping
  genes, or otherwise to the nearest GTF TSS within a declared threshold.

It does not treat peaks, motifs, or distance-based links as validated regulatory
elements, direct TF binding, or causal target-gene relationships. Each real
command writes a manifest next to its output.

```bash
bio-peak tools --format json

bio-peak call --treatment treatment.bam --control input.bam \
  --assay chip-seq --genome-size hs --output results/chip-peaks --dry-run --format json

bio-peak motif --peaks results/chip-peaks/bio-peak_peaks.narrowPeak \
  --background matched-background.bed --genome hg38 \
  --output results/motifs --dry-run --format json

bio-peak link --peaks results/chip-peaks/bio-peak_peaks.narrowPeak \
  --annotation Homo_sapiens.GRCh38.gtf --assembly GRCh38 \
  --output results/peak-gene-links.tsv --dry-run --format json
```

`call` and `motif` require `macs2` and `findMotifsGenome.pl` on `PATH` when not
using `--dry-run`. `link` has no external executable dependency. Inputs must
use the same declared genome assembly; this CLI records that assertion but
cannot infer assembly from generic BED/BAM files.
