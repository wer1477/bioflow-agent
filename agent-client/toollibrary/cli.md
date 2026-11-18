# Installed CLI capabilities

These commands ship with the repository and are already on PATH in the agent shell.
The one-line description is the advertisement; `toolload` the matching skill for the
workflow, risks, and output interpretation.

- bio-fetch（skill：bio-fetch）：下载 NCBI 基因组包或把 SRA run 转成 FASTQ，输出 manifest
- bio-seq（skill：bio-seq）：校验/翻译 DNA、RNA、蛋白序列，单序列远程 BLAST
- bio-variant（skill：bio-variant）：用 Ensembl VEP 注释小批量人类 SNV/indel
- bio-sc（skill：bio-sc）：单细胞 QC、聚类、marker/pseudobulk 差异表达与导出（h5ad）
- bio-bulk（skill：bio-bulk）：bulk RNA-seq 差异表达：counts + 样本表 → DE 表、QC 与火山/MA 图
- bio-report（skill：bio-report）：把 manifest、结果表、图与方法段拼成可复现的 Markdown/PDF 报告
- bio-enrich（skill：bio-enrich）：用 g:Profiler 或 Enrichr 做基因列表富集（GO/Reactome/KEGG）
- bio-peak（skill：bio-peak）：MACS2 峰调用、HOMER motif、promoter/TSS 映射
- bio-qc（skill：bio-qc）：FASTQ/BAM/表达矩阵 QC：reads、Q20/Q30、GC、重复、比对率与 manifest
- bio-align（skill：bio-align）：比对/定量计划与执行（fastp → STAR/HISAT2/BWA/Salmon → featureCounts），依赖先 check
- bio-metagenomics（skill：bio-metagenomics）：宏基因组 QC→去宿主→组装→Kraken2/Kaiju→Taxpasta，依赖先 check
- bio-workflow（skill：bio-workflow）：规划 RNA-seq/CUT&Tag/DNA-seq 流程（只规划，不执行）
- bio-doctor（skill：bio-doctor）：检查本地/实验室服务器能力画像与外部依赖
- bio-regulatory（skill：bio-regulatory）：准备/查询 CpG、ChromHMM、ENCODE、ReMap 调控证据
- bio-grn（skill：bio-grn）：从 bulk/单细胞表达推断 TF→靶基因候选网络
- bio-multiome（skill：bio-multiome）：校验 scRNA/scATAC TSV 并推导 peak-gene 候选边
- bio-epiedit（skill：bio-epiedit）：对 CRISPRi/a/off guide 候选排序（序列/脱靶/调控坐标）
- science-search（skill：science-search）：检索 PubMed、Europe PMC、bioRxiv 等 30+ 生物医学源
