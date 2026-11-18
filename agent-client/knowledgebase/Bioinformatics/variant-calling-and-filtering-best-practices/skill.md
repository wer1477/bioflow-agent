---
name: "Variant Calling and Filtering Best Practices"
description: "Decision-level guidance on engine selection, filtering strategies, VCF normalization, sample QC, and benchmarking for germline, somatic, and long-read variant calling."
---

# Variant Calling and Filtering Best Practices

## 适用场景

从比对后的 BAM/CRAM 产出可信的 SNV/indel 调用集，或复核既有 callset 的检测与过滤参数是否合理。涵盖胚系单样本/家系/队列、肿瘤体细胞、低 VAF 与长读长，以及 VCF 归一化和样本质控。SV/CNV 只在衔接处提及；下游注释见 bio-variant 说明，临床分类见「临床变异解读」。

## 第一步：定场景再选引擎

| 场景 | 默认路线 | 关键决策 |
|---|---|---|
| 单样本 germline（WGS/WES/panel） | GATK HaplotypeCaller 或 DeepVariant，直接出 VCF | 是否进入队列；过滤方式随队列规模变化 |
| 队列 germline | 每样本 gVCF → joint genotyping → 队列级过滤 | 绝不能用单样本 VCF 直接 merge 代替联合基因分型 |
| 体细胞 tumor-normal | Mutect2（或 Strelka2/DeepSomatic）→ 体细胞专用过滤 | 是否有配对正常样本；PoN 与污染表 |
| 体细胞 tumor-only / ctDNA | Mutect2 + germline resource + PoN + 方向偏倚模型 | 胚系与克隆性造血难以排除，必须披露 |
| 长读长（ONT/HiFi） | Clair3 / DeepVariant 对应化学模型 | 模型必须匹配测序化学；SV 用专门 caller |
| 非模式生物 / 小 panel | HaplotypeCaller + 硬过滤 | 无 VQSR 训练资源 |

## germline 检测

### 为什么不用 pileup 思路

按位点逐列基因分型（bcftools mpileup、旧 UnifiedGenotyper）默认信任比对器对每条 read 的独立放置；在 indel 与聚集变异附近，这种放置是逐 read 的贪心最优而非位点一致解，同一个 indel 会在不同 read 上被错放。HaplotypeCaller 在活跃区做局部从头组装候选单倍型，再把每条 read 比对回单倍型（PairHMM 对所有比对路径积分），因此 indel 在组装出的单倍型里只出现一次。这是它在 indel 与复杂位点优于 pileup 的根本原因，也是 DeepVariant/DRAGEN 同样采用「重推断」思路的原因。

### GVCF 与联合基因分型

- `-ERC GVCF` 在每个位点记录「支持纯合参考的置信度」，用符号等位 `<NON_REF>` 表示「尚未观察到的任意等位」；联合基因分型时，别的样本发现的变异可以在本样本被重新评估（即使本样本当时看似参考）。
- GVCF 用 GQ 分带压缩连续非变异位点；`-ERC BP_RESOLUTION` 关闭分带、每碱基一行。
- 联合基因分型会**借信息**：某样本只有 2–3 条支持 read 的低覆盖 het，在队列里其他样本携带该变异时会被显著救回，因此队列 callset 比 N 个独立 callset 更敏感。
- 联合结果是「补齐的方阵」：每个样本在每个变异位点都有基因型，能区分确信的 `0/0` 与无数据 `./.`。把单样本 VCF 用 `bcftools merge` 合并时，缺失位点会变成 `./.` 而不是 `0/0`，`./.` 与 `0/0` 混淆会直接算错等位基因频率与关联统计。
- N+1 问题：gVCF 把昂贵的发现步骤固化在每样本一次，新增样本只需再跑该样本 gVCF 与廉价的合并+基因分型；这是 gVCF 工作流的核心价值。

| 队列规模 | 合并方式 |
|---|---|
| <100 | CombineGVCFs 或 GenomicsDB 均可；前者更简单 |
| 100–10,000 | GenomicsDBImport + GenotypeGVCFs，按染色体分片 |
| 10,000–100,000 | GATK Biggest Practices，重度分片并行 |
| >100,000 | DeepVariant + GLnexus，或 Hail VDS |

GenomicsDB 可增量更新样本（N+1 落地），但导入时的 interval 锁定，扩区间需重新导入；其重任在 native 层，JVM 堆要留出余量，否则会出现看似无关的原生内存溢出。

### DeepVariant

DeepVariant 用 CNN 对 pileup 图像做三分类（hom-ref/het/hom-alt），三阶段为 make_examples（CPU 瓶颈，可分片）、call_variants（唯一可 GPU 加速）、postprocess_variants。

- **模型必须匹配平台**：`WGS`、`WES`、`PACBIO`（HiFi）、`ONT_R104`、`HYBRID_PACBIO_ILLUMINA`。用错模型不会报错，只会静默降低精度；WES 模型必须配 `--regions`，否则会在全基因组上空扫。
- 输出已带校准的 FILTER（PASS/RefCall），**不要**再叠加 GATK 硬过滤或 VQSR——这些注释在 DeepVariant VCF 里往往不存在或分布不同。
- 输入是排序、去重、建索引的 BAM/CRAM；DeepVariant 官方建议**不要**在上游跑 BQSR，BQSR 会消耗时间并略降精度。
- 队列联合分型用 GLnexus，其预置配置已编码 DeepVariant 的 GQ 与多等位处理习惯。

### BQSR 的争议与 DRAGEN-GATK

BQSR 用经验误差模型校正碱基质量；在旧式四色连续质量仪器上有价值。现代双色化学（NovaSeq/NextSeq）质量值只有约 4 个粗分箱，可校正的平滑结构很少，实际 callset 差异集中在边缘 GQ 位点。Broad 为流程一致性保留 BQSR，若干大流程在分箱数据上直接省略。**把 BQSR 当作仪器/化学依赖的可选项，而不是无条件步骤**，并在方法中写明是否使用。

若追求 indel 精度，真正的杠杆是 STR 感知建模：DRAGEN-GATK 的 DRAGSTR 按重复单元长度与拷贝数调整 PairHMM 的 indel 先验；`--dragen-mode` 还启用 BQD（碱基质量骤降）与 FRD（外源 read 检测），并用内部误差建模取代 BQSR，QUAL 已校准，按 QUAL 硬过滤即可（参考其文档给出的阈值）。DRAGEN-ML 的 FP/FN 与速度数字多为厂方基于 GIAB 报告，需保留过拟合 GIAB 的怀疑。

## 过滤：位点与基因型是两件事

过滤决定「留下哪些错误」，不改变错误是否存在。三条基本原则：

1. 位点级过滤（这个位点是否真实）与基因型级过滤（这个样本在此位点的基因型是否可信）正交，两者都需要，且位点在前。
2. SNP 与 indel 的误差过程不同（碱基/链偏好 vs 重复区比对歧义），必须分别过滤再合并。
3. 过滤选择取决于队列规模、平台与物种，没有通用最优方法；写错不会报错，VCF 结构仍然合法，只是数字静默出错。

### 方法选择

| 方法 | 适用 | 失效场景 |
|---|---|---|
| 硬过滤（VariantFiltration） | 单样本、外显子、panel、非模式生物、无 truth 资源 | 大规模高精度需求下静态阈值会漏掉真变异 |
| VQSR | 人类单一深度 WGS，或约 30+ 个联合分型的外显子 | 单个外显子/panel：变异太少，GMM 不可辨识，VQSLOD 是噪声 |
| AS_VQSR（`-AS`） | 超大队列，多等位位点上按等位过滤 | 小队列无增益 |
| VETS / ScoreVariantAnnotations | VQSR 的现代替代（隔离森林），可下探到更小队列 | 仍标 BETA，需先用 truth set 验证 |
| NVScoreVariants | 单样本外显子/panel（VQSR 变异不足） | 需要 2D 模型环境 |
| caller 原生模型（DeepVariant/DRAGEN） | caller 已输出校准 QUAL/FILTER | 不能再叠加 GATK 注释过滤 |

### VQSR 机制与失效条件

VQSR 在注释空间拟合两个高斯混合模型（真阳性模型 + 低概率尾部伪影模型），以 VQSLOD 打分，再按「truth 灵敏度 tranche」选择阈值（例如 99.7 tranche 保留 99.7% 的 truth 位点）。Tranche 是**对 truth 集的灵敏度，不是 FDR**。三个实操后果：

- 它需要数万级变异来估计完整协方差矩阵；单个深度 WGS 足够，单个外显子/panel 远远不够。「收敛」不等于结果可信。
- 外显子数据**不要**把 DP 作为 VQSR 注释，捕获深度反映探针设计而非真实性，会注入伪信号。
- SNP 与 indel 分开做；indel 更稀少，GMM 失败得更早。

### GATK 硬过滤（SNP/indel 分开）

SNP：QD<2.0、FS>60.0、MQ<40.0、MQRankSum<−12.5、ReadPosRankSum<−8.0、SOR>3.0。
Indel：QD<2.0、FS>200.0、ReadPosRankSum<−20.0、SOR>10.0（indel 的 SOR 阈值属于常用社区约定，不在 GATK 经典集合内），并去掉 MQ/MQRankSum（indel 上诊断力弱）。

阈值差异不是不一致：真实 indel 在重复区局部比对更乱，链偏好天然更高，FS 放宽到 200；伪 indel 又常聚集在 read 末端，ReadPosRankSum 收紧到 −20。这些数值是宽松的起点，应结合本数据的注释分布调整。

**hom-alt「缺失即 PASS」陷阱**：MQRankSum、ReadPosRankSum、BaseQRankSum 只在杂合位点有定义，纯合替代位点上缺失（`.`）。GATK 的 VariantFiltration 只在值存在且越界时才标 FAIL，缺失值默认通过；用 bcftools 手写等价条件时必须给每个 RankSum 条件补 `|| INFO/X = "."`，否则所有 hom-alt 位点会被静默删掉。

### 基因型级过滤

- GQ<20 设 `./.`；WGS 下 DP<8–10 设 `./.`；het 的等位比例明显偏离 0.5（如 <0.2 或 >0.8）提示比对伪影、CNV 或污染。
- 顺序：先位点过滤，再基因型置缺失，最后才算队列缺失率/HWE——否则低质量基因型会制造虚假的 HWE 偏离与缺失。
- bcftools 的 soft filter（`-s NAME` 写 FILTER 标签）便于溯源，hard filter（`-e` 直接删）更省空间；推荐软过滤保留证据，最后 `bcftools view -f PASS` 取用。

### 体细胞过滤

体细胞不能用胚系 VQSR/硬过滤。路线是 GATK FilterMutectCalls 加污染表、肿瘤分段表与方向偏倚先验，再按 TLOD、VAF、DP 追加阈值（例如 TLOD>6.3、AF>0.05、DP>20 是常见起点，需按平台与 panel 调整）。

### 过滤验证

| 指标 | WGS 期望 | WES 期望 | 说明 |
|---|---|---|---|
| Ti/Tv | 约 2.0–2.1 | 约 3.0–3.3 | 低于范围通常意味着假阳性稀释（随机错误 Ti/Tv 约 0.5）；WES 若只有约 2.1 说明过滤太松 |
| Het/Hom | 约 1.5–2.0 | 约 1.5–2.0 | 强祖系依赖；偏高提示污染，偏低提示近亲/ROH |
| 已知位点（dbSNP）比例 | 高 | 高 | 过低说明过度过滤 |

过滤后 Ti/Tv 显著下降是「过滤伤害了真变异」的信号，应收敛阈值而不是继续加码。区域分层同样必要：ENCODE blacklist（着丝粒、卫星区）、GIAB 分层 BED（低复杂度、segdup、串联重复）、LCR 区域，用 `bcftools view -T ^regions.bed` 排除或单独评估。

## 体细胞检测

### 引擎选择

| 工具 | 特点 | 适用 |
|---|---|---|
| GATK Mutect2 | 局部组装 + 单倍型；PoN、germline resource、F1R2/F2R1 方向偏倚模型 | 默认 tumor-normal/tumor-only；FFPE/OxoG 伪影过滤 |
| Strelka2 | 快、易用 | 常规体细胞小变异；已不再积极维护 |
| DeepSomatic | CNN 体细胞调用，支持 Illumina 与 PacBio HiFi | 低 VAF、难定位区域、长读长 |
| VarDict | 显式链偏好检验、低 VAF 扩增子/捕获 | 低 VAF panel、consensus BAM |
| UMI 一致序列 + 上述 caller | 从分子层面抑噪 | ctDNA / 极低 VAF |

### 关键概念

- **PoN（panel of normals）**：用一批正常样本调用结果吸收反复出现的建库/捕获噪声；PoN 越接近本平台与 panel，滤除效果越好，跨平台拼凑的 PoN 会误伤真变异。
- **方向偏倚**：FFPE 的 C>T、OxoG 的 G>T 等链特异伪影是低 VAF 假阳性的主要来源。Mutect2 通过 `--f1r2-tar-gz` 收集方向计数，`LearnReadOrientationModel` 学习先验，`FilterMutectCalls --ob-priors` 应用；跳这一步会显著抬高假阳性。
- **污染**：先用 VerifyBamID2 或 CHARR 估计，再把 `CalculateContamination` 得到的表喂给 FilterMutectCalls；污染存在时低 VAF 变异与污染伪影无法区分。
- **tumor-only 的边界**：没有配对正常样本时，约 50% 或约 100% VAF 的变异可能是胚系；必须结合 germline resource、PoN 与人群频率判断，并在报告中明确披露。克隆性造血（DNMT3A/TET2/ASXL1/PPM1D 等）是血液样本中低 VAF 体细胞变异的主要假阳性来源。
- **VAF 下限由分子数与错误底噪决定**：常规 Illumina 原始单碱基错误率约 1e-3，未做 UMI 时可靠 VAF 下限接近 0.5–1%；单链一致序列可降到约 1e-5，双链更低。输入 DNA 量不足时，再深的测序也没有足够突变分子可测。
- **de novo calling 与 tumor-informed tracking 是两类问题**：前者扫描全 panel、承担多重检验惩罚；后者只在既有变异位点上量化信号，可整合多 loci 达到 ppm 级。不要用前者的阈值去否定后者的结果。

## 长读长

- 平台：PacBio HiFi（读长约 15–25 kb，单 read Q30+）；ONT（R10.4+ 化学显著优于 R9.4，读长可达数十 kb 到 Mb 级）。
- 调用：Clair3（ONT，按化学选模型）、DeepVariant `ONT_R104` 模型、PEPPER-Margin-DeepVariant（ONT+Illumina hybrid）；HiFi 用 DeepVariant `PACBIO` 模型或 pbsv/DeepSomatic 体系。
- **模型/化学必须匹配**：把 DeepVariant 的 ONT_R104 模型用到 R9.4 数据上，或把 Clair3 的 R9.4 模型用到 R10.4 上，会静默退化。
- 长读长的真正价值：跨越重复区与同聚物、直接观察 indel/结构变异、原生相位、原生甲基化。短读长的 INS 召回受物理限制（约 30–50%），不是调参能解决的。
- 组装路线：HiFi 组装（hifiasm）+ 组装比对（dipcall/PAV）可获得最高质量 callset 与真值集；polishing 用 yak/DeepPolisher 等。
- SV：Sniffles2、cuteSV、pbsv、SVIM；短读长 SV 用 Manta/DELLY/GRIDSS 的共识策略；不同 caller 的 SV 表示（SVTYPE/END/SVLEN/BND）差异很大，合并前必须统一。

## VCF 归一化

### 规范形式

一个变异「已归一化」当且仅当同时满足（Tan 2015）：**最简表示**（REF/ALT 两端不能再裁掉碱基）与**左对齐**（POS 不能再左移）。两者共同定义唯一的 `(CHROM, POS, REF, ALT)` 键，且归一化幂等——重复执行不改变结果，因此可以安全地用于匹配、合并与集合运算。

### 为什么必须做

- 跨 caller 比较：同一 indel 可能被表示为不同位置或不同锚定碱基，不归一化会把同一变异判为 discordant。
- 数据库注释：dbSNP/ClinVar/gnomAD 都按规范形式存储，右对齐或非最简表示会静默匹配失败——临床可操作变异被报成「未见」而不报错。
- 合并与集合运算：`bcftools merge`、`isec`、complement 都依赖精确坐标匹配；混合归一口径会产生重复行，虚增计数并拆分等位频率。
- 同聚物/串联重复是重灾区：一个碱基的偏移就产生不同的键，注解随之漏配。

### 推荐顺序

1. 拆解 MNP 为原子 SNP（`--atomize`）。
2. 拆分多等位为双等位（`-m-`）。
3. 按参考基因组左对齐并裁剪（`-f reference.fa`）。

```bash
bcftools norm --atomize input.vcf.gz | \
    bcftools norm -m- | \
    bcftools norm -f reference.fa -Oz -o normalized.vcf.gz
```

不发 MNP 的 caller（如 HaplotypeCaller）可跳过 atomize。单条命令 `bcftools norm -f ref.fa -m-any` 适合简单场景，但不控制拆解顺序。

### 工具差异

`vt decompose_blocksub` 默认把 MNP/块替换拆成 SNP，而 `bcftools norm` 需要 `--atomize`（bcftools ≥1.12）才拆；同一份数据用不同工具归一化会得到不同记录数。GATK `LeftAlignAndTrimVariants` 有 `--max-leading-bases` 窗口，长重复中的 indel 可能没有完全左对齐。**在需要相互比较的所有队列上固定一个归一化工具与参数，并记录命令。**

### 与 HGVS 3′ 规则的冲突

VCF 左对齐把模糊 indel 移到**正向基因组 5′**端；HGVS 要求按**转录本方向 3′**端描述。对正链基因两者方向相反，因此同一个缺失的 VCF POS 与 HGVS `c.` 位置合法地不一致。**不要从 POS 手推 HGVS**，交给注释引擎处理，并把待比较的两条记录都归一到同一表示后再比。

### 其他要点

- REF 与参考不匹配时：`-c s` 修正、`-c x` 排除。REF 不匹配常意味着基因组版本错误，盲目修正会掩盖问题，未知原因时优先排除。
- 拆分后去重：`bcftools norm -d exact`。
- 符号等位：`END` 的 POS 锚定语义（DEL 删除 POS+1..END）、`SVLEN` 有符号（DEL 为负）。按大小过滤必须用 `ABS(SVLEN)`，否则会删掉所有缺失。BND 由 `MATEID` 成对出现，理解方向记号后再合并。
- 跨跃缺失等位 `*`：联合分型后某些样本在 `*/A` 或 `*/*` 状态，属正常现象，用 `bcftools norm` 拆解并让注释器特殊处理。

## 样本与队列 QC

### 覆盖度与污染

- 覆盖度：WGS 通常目标 ≥30x 平均深度与足够的高深度比例；WES 关注捕获区间内均一性与 ≥20x 比例；panel 关注目标区覆盖与脱靶。深度上限同样要看（约 >2 倍均值提示塌缩重复）。
- 污染：VerifyBamID2 的 FREEMIX 约 ≥0.02–0.03 是警戒线（不是硬常量）；CHARR 只需 VCF/gVCF 即可估计；肿瘤-正常配对用 conpair 同时评估一致性。1–3% 的同种污染即足以制造低比例 het。
- 身份与互换：somalier、NGSCheckMate、peddy、KING；先把全对 kinship 矩阵与 pedigree/manifest 对账，再做关联或 burden 分析。一个未发现的样本互换可以凭空造出或抹掉全基因组显著位点。

### 指标决策表

| 指标 | WGS | WES | 偏离含义 | 动作 |
|---|---|---|---|---|
| Ti/Tv（整体） | 约 2.0–2.1 | 约 3.0–3.3 | 低：假阳性稀释；高：过滤伤到颠换 | 调过滤器 |
| Ti/Tv（novel 子集） | 接近整体 | 接近整体 | novel 明显偏低：新变异里假阳性集中 | 提高严格度 |
| Het/Hom | 祖系依赖（EUR 约 1.5–1.6，AFR 约 2.0+） | 类似 | 高于同祖系：污染/参考偏倚；低：近亲/ROH | 先分祖系再判 |
| Novel 比例（vs dbSNP） | 常见变异应低 | 同 | 常见变异却高度 novel，几乎都是伪影 | 按频率分层再看 |
| Call rate | >95–98% | >95–98% | 低：低覆盖/低质量样本 | 先剔最差样本，再迭代 |
| Het 等位比例 | 中心在 0.5 | 0.5 | 整体偏移 + het 数升高：污染信号 | 用 VerifyBamID2/CHARR 确认 |
| ExcessHet / HWE | 同祖系内平衡 | 同 | 杂合过量：塌缩重复/CNV 比对伪影；杂合不足常为真实（Wahlund/近亲） | 只在同祖系对照组内按 excess het 过滤，不要一刀切 |
| 亲缘（kinship） | 与 manifest 一致 | 同 | 意外高亲缘：样本互换/重复 | 用 KING/somalier/peddy 对账 |

HWE 用精确检验（Wigginton–Cutler–Abecasis），不用卡方；case-control 研究只在对照中计算；GATK 的 ExcessHet 默认阈值约 54.69（phred，随队列规模调整）。样本级与位点级缺失率耦合，应迭代：剔最差样本 → 重算位点缺失 → 剔最差位点 → 重复。

### 过滤顺序

位点过滤 → 基因型置缺失 → 重算缺失率/HWE → 样本级过滤 → 关系/身份核查 → 下游分析。把低质量基因型留在矩阵里再算 HWE/缺失率，会制造伪偏离。

## 基准与验证

- **小变异**：GIAB v4.2.1（HG002/HG003/HG004，GRCh38）配合 confident BED；用 haplotype-aware 比较器（`hap.py`→vcfeval 或 `vcfeval`）而不是逐位点比较。只报一个基因组全局 F1 不够，必须按区域分层（低复杂度、segdup、串联重复、高/低 GC、MHC、CMRG 医学相关难区）。
- **GIAB 循环性**：DeepVariant 等工具在 GIAB 样本上训练，又在 GIAB 上评测，报出的最高 F1 部分来自记住真值集的特性。诚实的做法是留出样本或使用非 GIAB、群体匹配的验证材料，并分难度层报告。
- **SV**：Truvari 的每个参数都改变 F1（`--refdist`、`--pctsize`、`--pctseq`、`--sizemin`），不报告参数的 F1 不可解释；`--pctseq 0` 会虚增短读长 INS 分数。
- **正交验证**：报告级或科研关键结论用 Sanger、独立平台或已知参考样本确认；同一 caller 参数下的重复运行不构成验证。
- 固定参考基因组、工具版本、数据库版本与完整命令，纳入可复现清单；不同 caller 版本混用会引入质量分数口径差异。

## 与 bio-variant（VEP 注释）的衔接

推荐顺序：**归一化 → 过滤 → PASS 子集 → VEP 注释**。归一化必须早于注释，否则 ClinVar/gnomAD 匹配会静默漏配；过滤必须早于注释，否则会把大量伪影送去注释。

- bio-variant 适合小批量人类 SNV/短 indel 的 VEP 注释，输出最严重 consequence、转录本级 HGVS 与 VEP 共定位的临床意义条目；不支持结构变异、符号等位与 breakend，也不做本地 VEP 执行。
- 注释前明确 genome assembly 与转录本集（优先 MANE Select）；记录 VEP 版本与缓存版本，不同版本 consequence 可能变化。
- 注释结果是**研究上下文**：`CLNSIG` 等字段只是线索，需带 `CLNREVSTAT` 阅读；致病性分类与报告边界见「临床变异解读」。
- 注释后回看 consequence 是否符合预期（例如纯合变异是否被标为 hom-alt、剪接变异是否落在正确转录本），可反向发现检测/归一化阶段的错误。

## 常见陷阱

1. 单样本 VCF 直接 merge 当联合分型，把 `./.` 当 `0/0`。
2. 单个外显子/panel 跑 VQSR；外显子上把 DP 当 VQSR 注释。
3. 对纯合替代位点用 RankSum 过滤却不处理缺失值，静默删除全部 hom-alt。
4. 在 DeepVariant/DRAGEN 输出上再叠加 GATK 硬过滤或 VQSR。
5. 把 SNP 阈值套用到 indel，或不拆分多等位就过滤。
6. 体细胞变异用胚系过滤；跳过 LearnReadOrientationModel 与 PoN。
7. 用 tumor-only 调用直接报告低 VAF 变异为体细胞，未排除胚系与克隆性造血。
8. 未归一化就做跨 caller 比较、数据库注释或合并。
9. 从 VCF POS 手推 HGVS，与数据库/文献记录对不上就判为新变异。
10. 只报全局 F1 不分层、不报 Truvari 参数，或忽略 GIAB 训练-评测循环。
11. 把 BQSR 当无条件步骤，或忽略测序化学对长读长模型的约束。

## 主要来源与快照日期

- 领域：生物信息学。内容定稿/快照日期：2026-10-20；其中 bioSkills 参考仓库快照为 2026-08-15。
- 流程与工具：GATK Best Practices（HaplotypeCaller、GVCF、GenomicsDB、VQSR/VETS、Mutect2、FilterMutectCalls、BQSR/DRAGEN-GATK）；DeepVariant 文档与模型说明；bcftools/htslib 文档（norm、filter、stats、gtcheck）；vt；Clair3、Sniffles2/cuteSV/pbsv、hifiasm/dipcall/PAV 文档。
- 方法与基准：Tan A, Abecasis GR, Kang HM. Unified representation of genetic variants. Bioinformatics. 2015;31:2202–2204；DePristo 2011（联合分型）；Karczewski 2020（gnomAD）；Krusche 2019（GA4GH 基准）；GIAB v4.2.1 与分层 BED；Truvari 文档；hap.py/vcfeval 文档；VerifyBamID2、CHARR、somalier、peddy、KING 文档。
- 体细胞：Li MM, et al. J Mol Diagn. 2017;19:4–23（AMP/ASCO/CAP 分层，作为下游框架）；Mutect2 orientation-bias 文档；ctDNA 低 VAF 相关方法（VarDict、UMI 一致序列）文献。
- 改写与署名：部分结构与决策取向参考 GPTomics/bioSkills（MIT License，https://github.com/GPTomics/bioSkills，2026-08-15 归档）之 variant-calling（filtering-best-practices、gatk-variant-calling、deepvariant、joint-calling、variant-normalization、vcf-statistics、structural-variant-calling）、read-qc/contamination-screening、alignment-files/bam-statistics 与 liquid-biopsy/ctdna-mutation-detection；已重写为中文决策级知识，未整段复制原文。
