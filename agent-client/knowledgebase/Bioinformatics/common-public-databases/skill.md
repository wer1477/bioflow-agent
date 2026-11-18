---
name: "Common Public Databases"
description: "Purpose, versioning, and access considerations for databases such as NCBI, Ensembl, UCSC, UniProt, PDB, and GEO/SRA."
---

# Common Public Databases

## 适用场景

查找参考序列与注释、下载公开组学数据、获取蛋白结构或变异频率，以及核对数据库版本差异。

## 核酸序列与注释

- **NCBI**：GenBank/Nucleotide 存原始提交；RefSeq 提供非冗余参考序列与注释；SRA 存原始测序 reads；GEO 存表达与组学数据集。
- **Ensembl**：脊椎动物等基因组的自动化注释，提供 REST API 与 BioMart。
- **UCSC Genome Browser**：基因组浏览器与大量 track（保守性、调控、变异），下载方便。
- **ENA**：欧洲核酸存档，与 SRA 类似，提供原始 reads 与元数据。

三个注释源（RefSeq、Ensembl、UCSC）的转录本集合与坐标并不完全相同；跨库分析前必须固定一个版本，并记录下载日期。

## 高通量数据

- **GEO / ArrayExpress（BioStudies）**：芯片、RNA-seq、单细胞等数据集的入口；下载前读清样本表与处理协议。
- **SRA / ENA**：原始 reads；常用 SRA Toolkit 或 `fasterq-dump`/`prefetch` 下载。
- **EGA / dbGaP**：人类受控访问数据，需要数据访问委员会（DAC）审批。

## 蛋白与功能

- **UniProt**：蛋白序列与功能注释（Swiss-Prot 人工审阅，TrEMBL 自动注释）。
- **PDB**：实验解析的蛋白/核酸结构。
- **InterPro/Pfam**：蛋白家族与结构域。
- **KEGG / Reactome / GO**：通路与基因本体注释，用于富集分析；注意各库的许可与版本。

## 变异与临床

- **dbSNP**：变异登记；**gnomAD**：人群等位基因频率；**ClinVar**：临床意义解读；**COSMIC**：肿瘤体细胞变异（部分需授权）。
- 做肿瘤/遗传分析时，人群频率过滤与临床解读要区分胚系与体细胞场景。

## 单细胞数据

- **GEO**、**CELLxGENE**、**Human Cell Atlas** 是单细胞数据集的主要来源；注意细胞注释版本与元数据字段差异。

## 使用要点

1. 记录数据库名称、版本/快照日期、基因组组装版本。
2. 坐标转换（如 hg19 → GRCh38）用 liftOver，并检查转换失败区间。
3. 受控访问数据不得绕过审批，也不要把受限数据写入公开仓库。
4. 引用数据库与原始数据集时遵循各自的引用与许可要求。
