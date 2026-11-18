---
name: "RNA-seq Analysis Workflow Overview"
description: "The standard workflow from raw reads to differential expression and enrichment analysis, including key decision points and common pitfalls."
---

# RNA-seq Analysis Workflow Overview

## 适用场景

规划或复核 bulk RNA-seq 分析：QC、定量、差异表达与功能富集。

## 流程与关键决策

1. **实验设计**：生物学重复通常至少 3 个；记录批次、建库方式与链特异性；明确主要比较。
2. **QC**：FastQC + MultiQC 看质量分布、接头、rRNA 污染与重复率。是否需要 trim 取决于数据质量；过度修剪会引入偏差。
3. **定量**：
   - 基因组比对 + 计数：STAR/HISAT2 → featureCounts/HTSeq（需要注释 GTF）。
   - 伪比对/选择性比对：Salmon/kallisto → tximport（转录本层面到基因层面）。
   两种路线都可，关键是全项目一致并记录版本。
4. **计数矩阵**：差异表达使用 **raw counts**，不要用 TPM/FPKM 直接做统计检验。
5. **归一化**：DESeq2 的 size factor、edgeR 的 TMM、limma-voom 的 voom；CPM/TPM/FPKM 适合展示与样本内比较，不适合直接做组间统计。
6. **差异表达**：DESeq2 / edgeR / limma-voom；设计公式中加入批次等协变量；先过滤低表达基因。
7. **多重校正**：BH 控制 FDR；报告效应量（log2FC、shrink 后估计）与校正后 P 值。
8. **可视化与富集**：PCA、MA/volcano、热图；ORA（GO/KEGG）或 GSEA/ssGSEA；注意背景基因集与多重校正。

## 常见陷阱

- 用 TPM 做差异表达，或把归一化后的值当原始计数输入 DESeq2。
- 生物学重复不足，却用技术重复凑 n。
- 忽略批次，或在模型外做批次校正导致统计量失真（ComBat 结果更适合可视化）。
- 低表达过滤阈值过高或过低，影响 FDR 与结果稳定性。
- 混用参考基因组/注释版本；不同样本用不同流程版本。
- 只报告显著基因列表，不报告设计、软件版本与参数。

## 报告建议

记录参考基因组与注释版本、比对/定量软件版本、过滤与阈值、设计公式、随机种子，以及可复现的脚本入口。
