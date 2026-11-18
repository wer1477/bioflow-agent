---
name: "Single-Cell Transcriptomics Overview"
description: "Key steps and caveats in scRNA-seq analysis, from quality control and normalization to clustering, annotation, and differential expression."
---

# Single-Cell Transcriptomics Overview

## 适用场景

规划或复核 10x 等平台的 scRNA-seq 分析，判断质控、整合、聚类与注释参数是否合理。

## 上游

- 10x Genomics：Cell Ranger；也可用 STARsolo、alevin 等替代方案。
- 输出是 barcode × gene 的计数矩阵；多样本需分别定量后再合并。

## 质控与过滤

- 每个 barcode 的 UMI 总数、检出基因数、线粒体 reads 比例、核糖体比例。
- 空液滴：EmptyDrops 等方法区分真实细胞与背景 RNA。
- 双细胞（doublet）：Scrublet、DoubletFinder 等检测，尤其在同型细胞比例高的组织。
- 阈值应结合组织与数据分布确定；不同样本可用自适应阈值，但要在方法中说明。

## 标准化与降维

- logNormalize 或 SCTransform；**不要**用 TPM/CPM 做单细胞标准化。
- 选择高变基因（HVG）时注意剔除线粒体、核糖体与已知批次相关基因。
- PCA 取前若干个主成分，数量可由碎石图/稳定性决定。

## 批次整合

- Harmony、scVI、CCA/Seurat integration 等；整合后检查是否过度整合（生物学差异被抹平）。
- 样本分组若与批次完全混杂，任何整合都无法补救；应回到实验设计层面。

## 聚类与注释

- Leiden/Louvain 的分辨率参数直接决定簇数；用多个分辨率与稳定性指标确认。
- 注释依据 marker 基因、参考图谱映射（如 Azimuth、CellTypist）与人工复核。
- 注意不要用同一批数据既定义簇又「独立验证」注释。

## 差异表达与下游

- 单细胞层面的 Wilcoxon/MAST 等检验容易因细胞数巨大而过度显著；建议聚合为 pseudo-bulk 后按样本做差异分析。
- 轨迹/RNA velocity、细胞通讯、inferCNV 等分析按问题选用，不要为了「完整」而堆流程。

## 常见陷阱

- 未去 doublet、空液滴，导致簇数虚高。
- 把细胞数当生物学重复（pseudo-replication）。
- 批次与条件混杂，整合后错误解读。
- 注释循环论证；只报告簇数不报告稳定性。
- 过度过滤低质量细胞，丢掉真实但转录本少的细胞类型。

## 报告建议

记录平台、上游版本、QC 阈值、整合方法、聚类参数、注释依据与参考图谱版本；保留可复现的 Seurat/Scanpy 脚本。
