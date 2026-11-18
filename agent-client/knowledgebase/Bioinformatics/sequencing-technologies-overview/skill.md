---
name: "Sequencing Technologies Overview"
description: "Characteristics, error modes, and selection criteria for Sanger, Illumina short reads, PacBio HiFi, and Nanopore."
---

# Sequencing Technologies Overview

## 适用场景

为研究问题选择测序平台与读长策略，或解读数据中的平台相关偏差。

## 平台特点

| 平台 | 读长 | 典型准确率 | 主要错误 | 典型用途 |
| --- | --- | --- | --- | --- |
| Sanger | ~500–1000 bp | 很高 | 低 | 单克隆验证、克隆序列确认 |
| Illumina 短读 | 50–300 bp | Q30 以上很常见 | 以替换为主 | WGS/WES、RNA-seq、ChIP-seq、单细胞 |
| PacBio HiFi | 10–25 kb | 99% 以上（环形一致性） | 低，随机 | 组装、结构变异、定相、重复区 |
| Oxford Nanopore | 可达数十至上百 kb | 随版本提升，仍以 indel 为主 | indel、同聚物 | 超长组装、结构变异、直接甲基化、便携场景 |

## 关键指标

- **覆盖度**：测序深度与均匀性共同决定能否可靠检出变异；高深度不能弥补严重偏倚。
- **读长**：短读擅长精确定位与定量，长读擅长跨重复区、结构变异与单倍型定相。
- **文库类型**：PCR-free、链特异性、UMI、扩增子等会改变偏差与可用分析。
- **成本与通量**：按项目规模、周转时间与数据量权衡，不要只看单碱基价格。

## 选型建议

- 胚系小变异：短读 WGS/WES 是常规选择；重复区、结构变异或需要定相时补长读长。
- 转录组：短读用于表达定量与差异分析；长读长用于异构体与融合基因。
- 宏基因组：短读用于分类与丰度，长读长改善组装与完整基因组恢复。
- 单细胞：以 10x 等短读平台为主，配合 UMI 定量。
- 表观遗传：WGBS/ONT 直接检测甲基化；ChIP-seq/ATAC-seq 以短读为主。

## 常见陷阱

- 用错参考基因组组装版本（如 GRCh37 与 GRCh38 混用）。
- 忽略 PCR duplicates、批次与 lane 效应。
- 把测序深度当作生物学重复。
- 对不同平台数据套用同一套错误模型与过滤阈值。
