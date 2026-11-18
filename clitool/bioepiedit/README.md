# bio-epiedit

`bio-epiedit rank` deterministically prioritizes supplied CRISPR epigenetic-editing guide candidates. It consumes—not generates—guide and off-target scores, and may add coordinate support from `bio-regulatory` evidence and `bio-peak link` output.

```bash
bio-epiedit rank --guides guides.tsv --target-gene TP53 --assembly GRCh38 \
  --editor crispri --regulatory-evidence tp53-evidence.json \
  --peak-links peak-gene-links.tsv --output results/tp53-guides.tsv --dry-run --format json
```

The guide table requires `guide_id`, `sequence`, `chrom`, `start`, `end`,
`strand`, `pam`, and `on_target_score` (all scores range from 0 to 1). Ranking
is experimental prioritization only; it does not predict editing efficacy,
cell-context effects, or safety. Every actual result has an adjacent manifest
with scoring policy, source hashes, declared assembly, and evidence counts.
