---
name: "bio-sc"
description: "Standard single-cell RNA-seq pipeline: QC, normalization, HVG, PCA, Leiden clustering, UMAP, Wilcoxon marker DE, and optional sample-level pseudobulk DE. Use for a reproducible scRNA-seq pass; use the scanpy skill when the analysis needs custom steps."
---

# bio-sc：单细胞标准流程

用 `bio-sc` 跑标准 scRNA-seq 流程；需要自定义分析（轨迹、CNV、多模态整合）时再读 `scanpy` skill 自己写代码。

## 何时用

- 输入是 `.h5ad`、10x `.h5` 或 10x matrix 目录；
- 任务要求 QC → 聚类 → marker/差异表达 → 导出；
- 需要可复现的 manifest（参数、版本、输入/输出 sha256）。

不适用：多模态整合、轨迹推断、CNV、需要 Harmony/scVI 批次校正的定制流程。

## 顺序

1. `bio-sc check --format json`：确认 Python 与 scanpy 栈可用。
2. `bio-sc run ... --dry-run`：核对输入、输出与阈值。
3. 正式跑：`bio-sc run --input <h5ad|mtx-dir> --output <dir>`。
4. 读 `manifest.json` 的 `warnings` 与 `pca_genes`；再读表。

常用参数：

- `--min-genes 200`、`--max-pct-mt 20`：QC 阈值；按组织/数据质量调整，不要照搬。
- `--n-hvg 2000`、`--n-pcs 30`、`--resolution 0.5`：聚类粒度；分辨率要试着换。
- `--sample-key` + `--group-key`：做样本级 pseudobulk DE（每组至少 2 个样本）；没有重复时不要硬做。

## 风险

- 本流程不做双细胞去除、环境 RNA 校正、批次校正；需要时在 `out.h5ad` 上另做，并在报告里写明。
- pseudobulk 只在每组 ≥2 样本时运行；不足时 manifest 会写 `pseudobulk skipped`。
- PCA 的 HVG mask 在 scanpy 1.12 + anndata 0.13 下可能触发 DLPack `BufferError`；CLI 会自动回退到全基因并在 `warnings` 记录，看到回退要说明。
- marker DE 是 Wilcoxon（cluster vs rest），不是样本级差异分析。

## 怎么读输出

- `qc_metrics.csv`：过滤前每个细胞的 `n_genes_by_counts`、`total_counts`、`pct_counts_mt`。
- `clusters.csv`：cell、leiden、UMAP 坐标。
- `de.csv`：cluster、gene、score、logfoldchange、pval、pval_adj（Wilcoxon）。
- `de_pseudobulk.csv`：基因级 DESeq2 结果（baseMean/log2FoldChange/lfcSE/stat/pvalue/padj）。
- `manifest.json`：参数、版本、输入/输出 sha256、warnings，方法节直接引用。
