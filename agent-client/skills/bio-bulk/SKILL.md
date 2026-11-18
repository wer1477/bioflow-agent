---
name: "bio-bulk"
description: "Bulk RNA-seq differential expression with DESeq2 semantics: counts + sample sheet -> DE table, normalized counts, volcano/MA/PCA plots, and a manifest. Use for gene-level bulk counts; for single-cell clustering use bio-sc."
---

# bio-bulk：bulk RNA-seq 差异表达

用 `bio-bulk` 跑标准 bulk DE；它是 DESeq2 的编排层，不重新实现统计方法。

## 何时用

- 输入是基因 × 样本的原始 counts（不是 TPM/FPKM）；
- 有样本表：`sample,condition[,batch,...]`；
- 需要 `baseMean / log2FoldChange / lfcSE / stat / pvalue / padj` 和可复现 manifest。

不适用：单细胞（用 `bio-sc` 的 pseudobulk）、芯片/质谱的连续值矩阵、交互项设计（本版只支持主效应）。

## 顺序

1. `bio-bulk check --format json`：确认 pydeseq2 或 R DESeq2 可用。
2. `bio-bulk run ... --dry-run`：核对 counts 列名与样本表、design、contrast。
3. 正式跑：`bio-bulk run --counts ... --samples ... --design "~batch+condition" --contrast condition:treated:control --output results/de`。
4. 先读 `manifest.json` 的 warnings，再读 `de_results.csv` 与图。

## 风险

- 不要对 TPM/FPKM 直接跑 DESeq2；先拿到原始 counts。
- `--design` 只支持主效应（`~batch+condition`）；交互项/嵌套设计需要自己写 R。
- 每组重复少于 3 时，离散度估计不稳定；manifest 会警告，结论要保守。
- `padj` 是 BH 校正并经过独立过滤；`padj < 0.05` 不等于生物学显著。
- `log2FoldChange` 是未收缩值；做图/排序时注意大 LFC 的低表达基因。

## 怎么读输出

- `de_results.csv`：`gene, baseMean, log2FoldChange, lfcSE, stat, pvalue, padj`。
- `normalized_counts.tsv`：DESeq2 归一化 counts（基因 × 样本）。
- `volcano.*` / `ma.*` / `pca.png`：QC 与差异概览；PCA 按 contrast 变量着色。
- `manifest.json`：design/contrast、输入与输出 sha256、pydeseq2/R 版本、warnings。
