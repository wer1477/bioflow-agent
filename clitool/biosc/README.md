# bio-sc

Single-cell RNA-seq pipeline behind one command: QC, normalization, HVG, PCA,
neighbors, Leiden, UMAP, Wilcoxon marker DE, and optional pseudobulk DE with
pydeseq2. It wraps Scanpy and follows the Scanpy PBMC3k tutorial order; it does
not reimplement clustering or differential expression.

```bash
bio-sc check --format json
bio-sc run --input data/pbmc3k.h5ad --output results/sc --min-genes 200 --max-pct-mt 20
bio-sc run --input data/counts.h5ad --output results/sc \
  --sample-key sample --group-key condition
```

Contract:

- `--describe --format json` is the runtime parameter contract.
- stdout is JSON; stderr is diagnostics; exit 0/1/2.
- `run` writes `out.h5ad`, `qc_metrics.csv`, `clusters.csv`, `de.csv`,
  `umap.png`, `umap.pdf`, `manifest.json`; pseudobulk adds `de_pseudobulk.csv`.
- The Python interpreter is resolved as `$BIOAGENT_ENV_BIN/python3` →
  `<repo>/.bioenv/bin/python` → `python3`.

Design notes: see `clitool/docs/ai-friendly-cli-design.md`. The PCA fallback
(`mask_var=None`) exists because scanpy 1.12 + anndata 0.13 can trip the
readonly-mask DLPack bug; the manifest records which gene set was used.
