---
name: "Biological Data File Formats"
description: "Meaning, indexing, and 0/1-based pitfalls of common formats such as FASTA/FASTQ/BAM/CRAM/VCF/GFF/BED."
---

# Biological Data File Formats

## 适用场景

读写、转换、排查与格式相关的分析错误，尤其是坐标与索引问题。

## 序列与 reads

- **FASTA**：`>` 开头的标题行 + 序列行；核苷酸或蛋白序列。`.fai` 是索引，支持随机访问。
- **FASTQ**：每个 read 四行——标题、序列、`+`、质量字符串。质量值通常为 Phred+33（Sanger/Illumina 1.8+），个别旧数据是 Phred+64，混用会算出错误质量。

## 比对结果

- **SAM** 是文本格式，**BAM** 是其二进制压缩版，**CRAM** 进一步参考压缩（需要对应参考序列）。
- 常用字段：FLAG（比对状态）、CIGAR（比对路径）、MAPQ（比对质量）、RNEXT/PNEXT（配对信息）。
- 下游分析前必须**排序**（如 `samtools sort`），并建立索引 `.bai`/`.crai`；未排序或无索引是「工具报错/结果异常」的常见根因。

## 变异

- **VCF**：表头 + 每个位点一行；`CHROM POS ID REF ALT QUAL FILTER INFO FORMAT`，其后是各样本基因型。**BCF** 是其二进制版。
- 索引 `.tbi`（较小区域）或 `.csi`（大区域/大 contig）；压缩需用 bgzip，普通 gzip 不能随机访问。
- VCF 坐标是 **1-based**。

## 注释与区间

- **GFF3/GTF**：基因/转录本/外显子注释，1-based，属性列用 `key=value`（GFF3）或 `key "value"`（GTF）。
- **BED**：区间文件，至少三列 `chrom start end`，坐标为 **0-based、半开区间**；与 VCF/GFF 混用时会差 1 个碱基。
- **BigWig/BedGraph**：连续信号（覆盖度、ChIP 信号）；BigWig 支持随机访问，适合浏览器展示。

## 单细胞与对象格式

- **Matrix Market**：`matrix.mtx` + `barcodes.tsv` + `features.tsv`（10x 输出）。
- **h5ad**（AnnData）、**.rds**（Seurat/单细胞对象）：整包保存表达矩阵与元数据，注意版本兼容。

## 常见错误清单

1. 把 BED 的 0-based 坐标直接当 VCF 坐标使用。
2. BAM 未排序、无索引，或索引与文件版本不匹配。
3. 用普通 gzip 压缩 VCF 后期望 tabix 可随机访问。
4. 参考基因组与注释版本不一致（如 hg19 坐标配 GRCh38 注释）。
5. 混用不同来源的染色体命名（`chr1` 与 `1`）。
