# bio-bulk

Bulk RNA-seq differential expression behind one command. Wraps pydeseq2 (a
DESeq2-compatible Python implementation) and can call R DESeq2 when that engine
is requested. Result columns match DESeq2: `baseMean`, `log2FoldChange`,
`lfcSE`, `stat`, `pvalue`, `padj`.

```bash
bio-bulk check --format json
bio-bulk run --counts data/counts.tsv --samples data/samples.csv \
  --design "~batch+condition" --contrast condition:treated:control \
  --output results/de
```

Contract:

- `--describe --format json` is the runtime parameter contract.
- stdout is JSON; stderr is diagnostics; exit 0/1/2.
- `run` writes `de_results.csv`, `normalized_counts.tsv`, `volcano.{png,pdf}`,
  `ma.{png,pdf}`, `pca.png`, `manifest.json`.
- `--engine pydeseq2` is the default; `--engine deseq2-r` uses the `.bioenv` R
  DESeq2 when available.
- The Python interpreter is resolved as `$BIOAGENT_ENV_BIN/python3` →
  `<repo>/.bioenv/bin/python` → `python3`; Rscript follows the same pattern.

Design notes: see `clitool/docs/ai-friendly-cli-design.md`. The output contract
follows Bioconductor DESeq2 and nf-core/differentialabundance conventions; the
CLI does not implement its own statistics.
