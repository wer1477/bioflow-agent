---
name: "Spatial Transcriptomics Overview"
description: "Decision points and interpretation limits for Visium, Xenium, CosMx, Slide-seq, and similar platforms: data formats, QC, spatial plots, domain identification, deconvolution, and cell-cell communication analysis."
---

# Spatial Transcriptomics Overview

## 适用场景

规划或复核空间转录组（ST）与多重成像分析：选平台与读入方式、定 QC 与标准化、构建空间邻接图、识别空间域、做解卷积与细胞通讯、评估空间可变基因，以及判断结果能支持到哪一层结论。与 scRNA 流程重叠的部分只在差异处说明。

## 第一步：先分平台大类

平台的捕获单元是否含多个细胞，决定后续每一步，必须在任何分析之前确认：

| 类别 | 平台 | 单元 | 基因空间 | 分子表 | 主分析 |
|---|---|---|---|---|---|
| 测序/捕获 | Visium、Visium HD、Slide-seq、Stereo-seq、GeoMx | spot/bead/bin，1–10 个细胞的混合（GeoMx 为 ROI） | 全转录组（poly-A 或探针） | 无 | 解卷积（或对亚细胞 bin 先向上重建） |
| 成像/原位 | Xenium、MERSCOPE/MERFISH、CosMx、seqFISH | 分割得到的单细胞 | 靶向 panel（约几百到几千基因） | 有，且是源头 | 分割 + 注释，**不做**解卷积 |

两大类的差别不是「分辨率高低」而是数据生成方式：捕获平台的 spot 是被动混合，成像平台的细胞是分割假设。把成像数据拿去做解卷积，等于在已经是纯细胞的单位里凭空造混合比例；把 Visium spot 当细胞做通讯分析，等于用区域平均表达冒充细胞接触。

## 数据格式与读入

### 常见输出

- **Visium（Space Ranger）**：`filtered_feature_bc_matrix.h5`、`spatial/` 下的 `tissue_positions.csv`（Space Ranger v2.0 起带表头）、`scalefactors_json.json`、`tissue_hires_image.png`/`tissue_lowres_image.png` 与 `aligned_fiducials.jpg`。坐标 `obsm['spatial']` 是全分辨率像素，索引 hires 图需乘 `tissue_hires_scalef`。`scanpy.read_visium` 已弃用，优先 `squidpy.read.visium` 或 `spatialdata_io.visium`。
- **Visium HD**：2 µm bin，常聚合到 8/16 µm；`tissue_positions` 是 parquet 而非 csv；8 µm bin 仍约覆盖 1–2 个细胞。
- **Xenium**：`transcripts.parquet`（逐分子，含 x/y/z、feature、qv、cell_id，保留所有 Q 值）、`cells.parquet`、`cell_feature_matrix.h5`（默认只保留 Q≥20，是派生产物）、`cell_boundaries.parquet`/`nucleus_boundaries.parquet`、`experiment.xenium` manifest。
- **MERSCOPE/MERFISH**：`detected_transcripts.csv`、`cell_by_gene.csv`、`cell_metadata.csv`、细胞边界（不同软件版本可能是 hdf5 目录或 parquet）。注意没有 `merfish` reader，`merscope` 同时处理 MERFISH/MERSCOPE。
- **CosMx**：扁平的 `*_tx_file.csv`（分子表）、`*_exprMat_file.csv`、`*_metadata_file.csv`、`*_polygons.csv`（版本相关）。
- **Slide-seq/Curio**：bead × gene 矩阵 + bead 坐标，无分子表；**Stereo-seq**：DNB 亚细胞点，需 bin 到细胞尺度；**GeoMx**：ROI 计数，常用 SpatialDecon；**seqFISH**：多为论文附带自定义格式，需自建 AnnData/SpatialData。

### 关键原则

- 成像平台同时产出**分子表**与**细胞矩阵**。细胞矩阵看起来像 scRNA 计数，但它是「分割 + 计数」的派生结果，继承全部分割误差；分子表才是可重分割、可回收未分配分子的源头。只读细胞矩阵的 loader 已丢掉重分割能力。
- 捕获平台没有分子表，不要去找；其对象只有 barcode × gene 矩阵、坐标与组织图像。
- 坐标框架必须显式确认：Visium 用像素、多数成像 reader 用微米；像素/微米混用会让邻域半径与图像叠加静默错位。SpatialData 把变换（intrinsic→global）显式保存；旧 AnnData 布局藏在 `uns['spatial'][library_id]['scalefactors']`。
- 对象模型：SpatialData（分子表 + 图像 + 分割几何 + 表格，多模态/超内存/需重分割时首选）、AnnData+Squidpy（常规图统计）、Seurat v5（R）、SpatialExperiment/SFE（Bioconductor）。SpatialData 的 table 本身是 AnnData，`squidpy.gr.*` 可直接运行。

## QC

### 捕获平台

- 关注每 spot 的 UMI、基因数、线粒体比例、每 spot 细胞数估计。阈值随组织与方案变化：DLPFC 示例的 UMI<600、genes<400、mito>28%、cells/spot>10 只是起点，不是通用标准。
- 必须**把 QC 指标画到组织坐标上**：计数沿组织边缘下降、线粒体比例在某一角落升高等空间梯度是技术伪影（边缘效应、透化不均、局部杂交失败），小提琴图看不出来；阈值可能正好切掉一个真实的小细胞类型区域。

### 成像平台

- 细胞只含几十到低几百条转录本，比液滴 scRNA 低 1–2 个数量级；照搬 `min_counts=500` 会删掉几乎全部真实细胞，并系统性偏向删除小细胞（淋巴细胞等），改变组织构成。
- 基因数上限就是 panel 大小，「基因数高=双细胞」在成像数据上无意义；线粒体基因通常不在 panel，`pct_counts_mt` 常常不可用。
- 用**阴性对照**评估特异性：Xenium 的 negative control probe/codeword、MERFISH 的 blank barcode、CosMx 的 NegPrb。指标为对照特征平均计数/真实基因平均计数，社区可接受范围约 ≤1–5%（Xenium 常 <0.1%，MERFISH 约 4%，CosMx 偏高），但随 panel 与版本变化，应结合本批次判断。对照是 QC 尺子，聚类前必须剔除。
- 转录本下限常用约 10 条/细胞（Squidpy/社区约定，非厂方规范；CosMx 常见约 20 条），并配合细胞面积 1%–99% 分位裁剪过分割/欠分割。阈值要看 panel 大小与组织，不要复制别处的数字。

## 标准化

「文库大小是技术噪声、除之即可」在空间数据上不成立：**库大小携带生物学信息**。Visium 的 spot 总计数与每 spot 细胞数、组织细胞密度相关；成像的每细胞计数与细胞面积/分割误差相关。直接 `normalize_total + log1p` 会抹掉真实的空间结构，降低空间域识别。

| 方法 | 适用 | 失效 |
|---|---|---|
| `normalize_total` + `log1p` | 跨平台快速比较、教程默认 | 空间数据会移除生物学信号；偏斜 panel 上偏差明显 |
| 解析 Pearson residuals | 全转录组 Visium 的 HVG/PCA | 成像靶向 panel 仍属基因计数法，继承 panel 组成偏差 |
| SCTransform v2 | 全转录组 UMI/Visium | 不能修复偏斜 panel |
| 细胞面积/体积（Moffitt 式） | 成像偏斜 panel，浓度才是生物量 | 依赖可靠分割；不能修复分割误差本身 |
| SpaNorm（空间感知） | 捕获与成像，保留空间结构 | 较新，需按版本文档验证 |

对偏斜成像 panel 的基准报告称，基因计数类标准化可引入约 13% 的差异表达误差、多达 19% 的基因倍数变化方向反转；面积/体积作为分母与 panel 组成无关，是更稳的选择。全转录组 Visium 则可放心使用 Pearson residuals 或 SCTransform 做特征选择。

## 空间邻接图：图就是模型

所有空间统计都是 `f(表达, W)`：Moran's I、Geary's C、邻域富集、共现、GNN 空间域方法都依赖同一个空间权重矩阵 W。把 k 从 6 改成 30、把 Delaunay 换成 kNN、或把 W 行标准化而不是二值化，统计量、z 分数、SVG 排名与域边界都会变。不存在唯一的 W，因此结论必须报告对图的稳健性。

| 图类型 | 度行为 | 密度偏差 | 适用 | 失效 |
|---|---|---|---|---|
| Visium 六边形格（`coord_type='grid'`，`n_rings`） | 每环固定 6 | 无（规则格） | Visium/规则捕获阵列 | 把 spot 当细胞（spot 是 1–10 细胞混合） |
| kNN（`generic` + `n_neighs`） | 固定 k | 半径在稀疏区自动拉长，连接远处细胞 | 成像点云、密度不均组织 | 默认非对称；k 过小易碎裂 |
| 固定半径 | 密度高则邻居多 | 强：密度本身伪造富集 | 密度近均匀且存在真实物理作用距离 | 密度梯度组织 |
| Delaunay | 参数自由、「谁与谁接触」 | 轻 | 单细胞点云的无参数接触图 | 组织有空洞/褶皱时产生跨空长边 |

实操要点：

- **坐标单位陷阱**：半径、共现区间、Delaunay 裁剪阈值都以物理距离为单位。先测最近邻间距：Visium 微米坐标应约 100，若为数百到数千说明是像素，需换算或用 grid 模式。
- **Delaunay 长边裁剪**：用 `radius=(0, max)`（例如几十微米，数个细胞直径）删掉跨组织空洞的伪边。
- **图敏感性分析**：至少在 k=6/15/30 与 Delaunay 下重建，比较下游结论的排序而非单个数值；只在一种图下成立的基因/互作/域应标注为 graph-fragile。
- **检查图健康度**：孤立细胞（度 0）提示碎裂，极端高度节点提示密度枢纽。
- **切片是 3D 组织的一张平面**：平面邻居在完整体积中可能相距很远，切片表面被截断的细胞转录本不全。单切片只能支持面内结论，不能据此声称 3D 接触。

## 空间域识别

先分清三个概念：**细胞类型**是单细胞的转录身份；**niche/邻域**是局部细胞类型组成（哪些类型共现）；**空间域**是连片的组织区域（皮层分层、肿瘤核心、间质带），域内可含多种细胞类型与多个 niche。问「哪些类型共现」却跑域分割，是答错问题。

- 表达单独聚类（Leiden/Louvain）忽略坐标，得到椒盐状标签；这是所有域方法要超越的基线，不是域结果。
- 域方法通过空间项让邻居倾向同标签，因此**空间权重旋钮**才是关键决策：BANKSY 的 `lambda`（约 0.8 偏域、约 0.2 偏细胞分型）、BayesSpace 的平滑先验、SpaGCN 的组织学权重、GNN 的图半径。过大会过度平滑、抹掉真实边界合并成团；过小退回椒盐。
- 代表方法：BayesSpace（MRF 平滑，适合层状连续组织）、BANKSY（邻居增广特征，高分辨成像与测序数据通用、可扩展）、STAGATE（图注意力自编码器，靠边权重抑制跨界平滑）、GraphST（图对比学习，兼容低分辨 Visium）、SpaGCN（融合表达、坐标与 H&E）、SEDR、BASS（联合细胞类型与域、多样本）。
- 域数 k 是**生物学选择**（需要多细的分区），不是用轮廓系数优化的统计量；应报告 k、说明理由，并展示 k±1 的敏感性。
- 基准：DLPFC（12 张 Visium 切片、6 层皮层+白质、ARI 评测）是常用真值。多个基准的共识是「没有单一最优方法」，GNN 类与 BayesSpace 在层状组织较稳；但 DLPFC 是连续层状组织，会偏袒平滑型方法，不要外推到非层状组织。依赖连续先验的方法在**非连续域**（散在肿瘤巢、免疫聚集）上普遍表现不佳，此时应降低空间权重或改做 niche/邻域分析。

## 解卷积

解卷积把多细胞 spot 分解为细胞类型比例或绝对数量，需要匹配的 scRNA 参考。先问「这份数据是否含混合」：

| 平台 | 单元大小 | 是否单细胞 | 处理 |
|---|---|---|---|
| Visium v1/v2 | 55 µm spot，100 µm 间距 | 否（约 1–10+ 细胞） | 解卷积 |
| GeoMx | ROI（多细胞） | 否 | 解卷积（SpatialDecon） |
| Visium HD / Stereo-seq / Slide-seqV2 | 2 µm bin / DNB / 10 µm bead | 边界情形 | 有配准图像时优先向上重建细胞（Bin2cell/StarDist 等）；无形态信息时解卷积（RCTD doublet 模式） |
| Xenium / MERSCOPE / CosMx | 亚细胞级 | 是 | 分割 + 注释，**不要**解卷积 |

- 参考数据是结果的主导因素，比算法选择更重要：组织、状态（健康参考会低估活化免疫/恶性状态）、建库方式（snRNA 与全细胞解离偏好会传导到比例）都必须匹配。参考里缺失的细胞类型，其转录本会被强行分配到最相近的已有类型，比例仍然归一、看起来干净，但结论是「自信的垃圾」。
- 输出语义不同：cell2location 给绝对丰度（每 spot 期望细胞数，常用 q05 保守分位）；RCTD/SPOTlight/SpatialDWLS/CARD/stereoscope 给比例。问「多少细胞」与问「占多少比例」是两个问题。
- 方法排名随基准变化，cell2location 与 RCTD 通常在多个独立基准中居前；无匹配参考时 STdeconvolve（无参考 LDA）可作兜底，其 topic 需事后注释。
- 比例数据是组成型（和为 1）：相关、t 检验、线性模型前应做 CLR/ILR 变换，否则一个类型升高会机械压低其余类型。差异丰度用 ALDEx2/scCODA 等组成感知方法，不要逐类型 t 检验。
- 罕见类型（低于几个百分点）是最不可靠的部分，必须用其空间 marker 基因佐证；两个方法一致常是共享假设，不算正交验证。可辩护的稳健性检查是换参考重跑（reference sensitivity）加一个正交模态。

## 空间可变基因（SVG）

- SVG 检验的是表达与位置的空间自相关，不等于「空间调控」。某细胞类型的 marker 因为该类型在空间上聚集，也会被评为 SVG。整张切片跑出来的 SVG 列表往往与 HVG/细胞类型 marker 大量重叠——若两者高度重合，空间检验几乎没有增加信息。
- 若问题是「组织如何分区」，样本级 SVG 是对的（细胞类型结构本身就是答案）；若问题是「哪些基因在细胞身份之外受空间调控」，样本级 SVG 是错的，应在细胞类型内检验（C-SIDE、CTSV、CELINA 等）或先回归掉组成。
- 方法各有不同的零假设：SpatialDE（空间方差分量=0，O(n³)，不适合超过约 1 万位置）、SPARK（固定核无匹配模式，计数 GLSM）、SPARK-X（表达协方差与位置协方差独立，线性扩展至 1e4–1e6 细胞）、nnSVG（NNGP，逐基因长度尺度，线性）、Moran's I/Geary's C（图 W 上无自相关，快但单尺度）。方法间不一致是零假设不同的结果，不是 bug。
- 阈值应同时看效应量与 FDR：细胞数上万时，微不足道的自相关也能达到极小 p 值。Moran's I 无法区分「热点」与「冷点」，问「哪里高」要用 Getis-Ord Gi*；组织非平稳时用局部 LISA，但局部统计有 n 个检验且彼此空间相关，BH-FDR 只是下限，应视为探索性结果。
- 共定位检验的零模型决定结论：Squidpy `nhood_enrichment` 默认的全局标签置换只回答「比完全空间随机更近邻吗」，两个同区室的高丰度类型会平凡通过；要声称「A 与 B 特异性相邻」必须换成条件/区室内置换、保持各自密度的 toroidal shift 或 CRAWDAD 式的尺度显式瓦片置换。罕见类型的富集 z 值波动最大，最应怀疑。

## 细胞通讯

共表达不等于通讯。所有标准工具（squidpy ligrec、COMMOT、CellChat、CellPhoneDB、stLearn、SpaTalk、NicheNet、LIANA 整合框架）计算的都是「配体 mRNA 在发送方、受体 mRNA 在接收方，相对置换零假设是否富集」，没有一个测量蛋白、结合、分泌、扩散或下游响应。所谓「显著配体-受体对」是**共表达假设**，只能作为待验证假说。

- 方法第一分叉是「是否真的建模空间距离」：squidpy `ligrec` 默认空间盲（置换簇标签，任意簇可与任意簇对话）；COMMOT 用最优传输加距离代价（`dis_thr`，需微米坐标，且每个通路只有一个各向同性长度，无法区分接触依赖与分泌型配体）；CellChat v2 的 spatial 模式是在表达驱动的质量作用分数上加距离过滤；NicheNet 不做空间检测，而是把配体与接收方下游靶基因响应连起来；MISTy 用多视图随机森林分解近邻/远邻贡献。
- 配体-受体数据库是结果决定因素：CellPhoneDB、CellChatDB 等在内容、复合物处理与策展上不同，换库的影响可能大于换算法。两个工具一致常只是共享同一个库，不是独立验证。必须报告数据库与版本。
- 显著性要在完整的「配体-受体对 × 有序细胞类型对」空间上做多重检验校正；将名义 p 值当发现、把 top 对连成网络，是制造互作网络的常见方式。
- 置信阶梯：裸共表达 < 邻近条件下的共表达 < 接收方下游转录响应支持 < 配体与受体蛋白共定位 < 扰动实验。绝大多数空间文献停在第二级。
- 空间特有的循环陷阱——**分割溢出**：相邻细胞间转录本误分配会把发送方配体渗入接触的接收方，恰好制造这些方法奖励的短程共表达信号，且最易发生在相邻异型细胞之间。对短程命中应先检查分割质量，或用替换分割（Baysor/proseg）后的矩阵复测。
- spot 平台的第二重陷阱：Visium spot 是 1–10 细胞混合，喂给通讯工具的「细胞类型」实际是解卷积估计；配体与受体可能共处同一个 spot 而根本没有细胞间信号。spot 级通讯结果应视为置信阶梯的最底级。

## 配准、批次与多切片

- 组织图像与坐标必须配准：H&E/IF 与 spot/细胞坐标用平台 scalefactor 或配准矩阵对齐；配准差会让形态学特征与表达错位。
- 连续切片或同一组织多模态整合用 PASTE/STalign 等做切片间对齐；但它们不能消除生物学差异，也不能替代样本设计。
- 批次：不同建库批次、不同捕获区域、不同日期都可能产生技术差异；可用 Harmony/scVI 等做整合，但**样本分组与批次完全混杂时任何整合都无法补救**。多切片要先检查切片间一致性（共同 marker 的空间模式），再做联合域分析。
- 不同平台、不同 panel、不同测序深度、不同分割版本的数据不能直接合并做域或通讯比较；跨平台比较应回到「区域/细胞类型的组成」这类语义层面，而不是矩阵拼接。

## 与 scRNA 流程的差异

| 环节 | scRNA 常规 | 空间转录组的差异 |
|---|---|---|
| QC | 每细胞 UMI/基因数/线粒体 | 捕获平台按 spot 评估且要看空间梯度；成像平台转录本极少、线粒体常缺失、要看阴性对照 |
| 标准化 | 文库大小=技术噪声，除之 | 文库大小携带细胞数/面积等生物学信息；偏斜 panel 用面积/体积或 SpaNorm |
| 降维聚类 | PCA + Leiden | 需空间项（图/平滑先验）才能得到连片域；纯表达聚类是基线 |
| 双细胞 | Scrublet/DoubletFinder | spot 天然混合，不做双细胞；成像要看分割溢出与多细胞片段 |
| 差异分析 | 细胞级检验或 pseudo-bulk | 域/niche 层面的比较需考虑组成型数据与空间自相关 |
| 细胞类型 | 注释即终点 | 注释是解卷积/域/通讯的输入；参考质量决定下游 |
| 验证 | 独立样本/实验 | 需要空间 marker、阴性对照、换参考/换图稳健性 |

## 解读限制

- 单张切片是 3D 组织的 2D 截面；切片位置、厚度、方向都会影响域与邻域结论，不可直接外推到体积。
- 成像平台结论受分割质量约束；细胞边界是估计值，溢出会伪造邻近与通讯信号。
- 靶向 panel 有界：基因「缺失」不等于不表达，只说明不在 panel；通路级结论尤其受限。
- 解卷积结果是对参考的投影，不是真实细胞计数；参考缺类型时结论自信但错误。
- 空间统计量依赖图与零模型的选择；报告必须写明图定义、k/半径、零模型与校正方式。
- 相关不是因果：配体-受体共表达、域与临床变量的关联都需要扰动或独立队列验证。
- 切片数与样本量常被低估：把一张切片中的多个 spot 当独立重复是空间版的 pseudo-replication，推断单位应是切片/样本。

## 常见陷阱

1. 把 Visium spot 当细胞，或把成像单细胞拿去做解卷积。
2. 照搬 scRNA 的 `min_counts` 阈值，删掉真实小细胞并改变组织构成。
3. 用 `normalize_total+log1p` 处理偏斜成像 panel，抹掉空间结构。
4. 用像素坐标设微米半径，或未裁剪 Delaunay 跨空洞长边。
5. 只用一个 k 或一种图就报告 Moran's I/富集结论，不做敏感性分析。
6. 表达单独聚类得到椒盐图就当作空间域；或把域、niche、细胞类型混为一谈。
7. 用缺失细胞类型的参考做解卷积，或对比例数据直接做 t 检验。
8. 把样本级 SVG 当成「空间调控」证据，忽略其与 HVG/marker 的重叠。
9. 把全局置换的邻域富集 z 值解读成特异性细胞互作。
10. 把配体-受体共表达写成「A 向 B 发送信号」，忽略分割溢出与数据库选择。
11. 多切片直接按坐标拼接，或让批次与条件完全混杂后强行整合。

## 主要来源与快照日期

- 领域：生物信息学。内容定稿/快照日期：2026-10-20；其中 bioSkills 参考仓库快照为 2026-08-15。
- 平台与格式：10x Genomics Visium/Visium HD、Xenium 官方文档；Vizgen MERSCOPE/MERFISH 文档；Bruker/NanoString CosMx SMI 文档；Curio Seeker、Stereo-seq、GeoMx 文档；SpatialData/spatialdata-io、Squidpy、Scanpy、Seurat v5 文档。
- 方法与基准：Maynard 2021（DLPFC，Nat Neurosci 24:425）；Yuan 2024（空间域方法基准，Nat Methods 21:712）；Bhuva 2024（文库大小与空间结构，Genome Biol 25:99）；Atta & Fan 2024（空间标准化基准，Genome Biol 25:153）；Li 2022 与 Sang-Aram 2024（解卷积基准）；Walker 等平台对照文档。
- 工具：Squidpy（spatial_neighbors、spatial_autocorr、nhood_enrichment、co_occurrence、ligrec）、cell2location、RCTD/spacexr、SPOTlight、SpatialDWLS、CARD、Tangram、STdeconvolve、Bin2cell、BANKSY、BayesSpace、STAGATE、GraphST、SpaGCN、SEDR、BASS、COMMOT、CellChat v2、NicheNet、MISTy、LIANA、PASTE/STalign。
- 改写与署名：部分结构与决策取向参考 GPTomics/bioSkills（MIT License，https://github.com/GPTomics/bioSkills，2026-08-15 归档）之 spatial-transcriptomics（README 与 spatial-data-io、spatial-preprocessing、spatial-neighbors、spatial-statistics、spatial-domains、spatial-deconvolution、spatial-communication 等子条目）；已重写为中文决策级知识，未整段复制原文。
