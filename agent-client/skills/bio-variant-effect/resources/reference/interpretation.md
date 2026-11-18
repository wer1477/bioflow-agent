# Reading AlphaGenome variant scores

Official basis: "How variant scoring works"
<https://www.alphagenomedocs.com/variant_scoring.html> and the FAQ
<https://www.alphagenomedocs.com/user_guides/faq.html> (snapshot 2026-10-20).

## What a score is

For one variant, the model predicts the REF and ALT sequences, applies a spatial mask
(the variant-centered window or a gene/exon/TSS region), aggregates spatially, and
reports `ALT - REF` as one scalar per track. Indels are aligned back to REF coordinates
before comparison. Scores therefore describe a predicted molecular change for a track,
not a clinical effect.

## Differential scorers (REF vs ALT)

| Scorer key | Mask | Aggregation |
| --- | --- | --- |
| `RNA_SEQ` | gene exons | log-fold change of gene expression: log(mean(ALT)+0.001) - log(mean(REF)+0.001) |
| `ATAC`, `DNASE`, `CAGE`, `PROCAP`, `CHIP_TF` | 501 bp centered on variant | log2((sum(ALT)+1)/(sum(REF)+1)) |
| `CHIP_HISTONE` | 2001 bp centered on variant | log2((sum(ALT)+1)/(sum(REF)+1)) |
| `SPLICE_SITES`, `SPLICE_SITE_USAGE` | gene body | max(abs(ALT - REF)) over splice sites |
| `SPLICE_JUNCTIONS` | top splice sites of a gene | max(abs(log(ALT) - log(REF))) over junctions |
| `POLYADENYLATION` | local 400 bp around 3' cleavage junctions | max abs log-fold change of isoform ratio |
| `CONTACT_MAPS` | local 1 MB | mean abs difference for the variant-containing bin |

`*_ACTIVE` scorers report the absolute activity of the stronger allele
(`max(sum(ALT), sum(REF))` or `max(mean(ALT), mean(REF))`), not a direction of change.

## raw_score vs quantile_score

- `raw_score` is the scorer output; its scale differs by modality and track.
- `quantile_score` ranks the raw score against scores of common variants (MAF > 0.01 in
  any gnomAD v3 population). `0.99` means the 99th percentile; extremes are capped near
  ±0.999990 because the background holds ~300K variants. Signed scores map quantiles to
  [-1, 1] so direction is preserved.
- Use `quantile_score` to ask "is this unusually large?" and `raw_score` to compare
  magnitudes within the same scorer and track. Quantiles exist only for the recommended
  scorers.

## Constraints to state in every report

- Human hg38 (GRCh38.p13) or mouse mm10 only; liftover other builds and say so.
- Evaluated on SNVs and small indels; structural variants and large events are out of
  scope, and arbitrary/synthetic sequences are less reliable.
- Research use only, non-commercial; predictions must not drive clinical decisions.
- Record model version, address, sequence length, scorers, ontology terms, and the
  command so scores are reproducible.
