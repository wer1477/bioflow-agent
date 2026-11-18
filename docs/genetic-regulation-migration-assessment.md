# 遗传调控解析、调控元件与网络智能设计：迁移评估

> 调研日期：2026-08-19（基于本机工作区快照）
> 范围：`../other` 中与基因调控网络（GRN）、调控元件、表观组、染色质互作和合成调控网络设计直接相关的实现/Skill；并与本项目已配置能力比较。本文是迁移决策记录，不引入或启用任何依赖。

## 结论

优先建设两项独立、可复现的能力：

1. **`bio-grn`**：用 Arboreto 的 GRNBoost2/GENIE3 从 bulk RNA-seq 或 scRNA-seq 表达矩阵推断 TF—靶基因候选边；
2. **`bio-regulatory`**：以基因或基因组坐标为入口，统一汇总 CpG 岛、ChromHMM 状态、ATAC/组蛋白 ChIP 峰和 TF ChIP-seq 结合证据。

随后补齐“peak calling → motif → 元件—基因链接”的受控工作流；最后再把 CRISPRi/a、CRISPRoff 和多组学/空间分析接入。不要直接迁移 CellType、Biomni 或 SpatialAgent 的 Agent runtime：本项目的唯一运行时边界是 `agent-client/backend/`，而新增生信可执行能力应作为 `clitool/` 中独立、可测的 CLI，由 `agent-client/skills/` 指导调用并经 `agents.json` 显式绑定。

GRNBoost2/GENIE3 的结果是表达共变模式下的**候选调控关联**，不是 TF 对靶基因的因果或直接结合证明。任何面向用户的输出都应保留此限定，并把 ChIP、ATAC、motif、染色质互作或扰动实验作为佐证层。

## 当前项目基线

当前默认 Agent 已配置 `science-search`、`bioinformatics/deeptools`、`bioinformatics/molecular-cloning` 与 `bioinformatics/synthetic-biology`，见 `agent-client/backend/config/agents.json`；`scvi-tools` 已迁入知识库（`agent-client/knowledgebase/Bioinformatics/scvi-tools/skill.md`），由 `knowledgebase` CoreTool 按需读取。因此本项目已有以下可复用基础：

| 当前能力 | 已覆盖范围 | 本次识别的缺口 |
| --- | --- | --- |
| `bioinformatics/deeptools` | ChIP-seq/RNA-seq/ATAC-seq 的 coverage、QC、profile/heatmap 和峰周围可视化；来源：`agent-client/skills/bioinformatics/deeptools/SKILL.md` | 不负责 peak calling、motif 富集、TF—target GRN 或跨证据的元件注释。 |
| `scvi-tools`（知识库条目） | PeakVI、MultiVI、scATAC 与多组学模型；来源：`agent-client/knowledgebase/Bioinformatics/scvi-tools/skill.md` | 提供表征/整合，不直接给出 TF—靶基因网络或公共表观组证据。 |
| `bioinformatics/synthetic-biology` | 密码子优化、ODE 回路、SBML、双稳态/分岔、表达盒设计；来源：`agent-client/skills/bioinformatics/synthetic-biology/SKILL.md` | 已覆盖合成基因回路仿真，不需要整套重复迁移。 |
| `bioinformatics/molecular-cloning` | sgRNA 设计与离靶评分、Gibson/Golden Gate、引物和质粒注释；来源：`agent-client/skills/bioinformatics/molecular-cloning/SKILL.md` | 尚未按目标位点的 CpG、可及性、组蛋白标记和 TF 占位来筛选表观编辑位点。 |
| `science-search` / `bio-workflow` | 文献/资料检索与多步骤分析编排；来源：`agent-client/skills/science-search/SKILL.md`、`agent-client/skills/bio-workflow/SKILL.md` | 不是 ENCODE、ReMap、Roadmap 等坐标级证据数据库的统一查询接口。 |

项目对 CLI/Skill 的归属和本地状态约束见 `README.md` 与 `docs/development.md`：CLI 位于 `clitool/<tool>/`，Skill 位于 `agent-client/skills/`；`workspace/` 与 `data/` 都是不可提交的本地状态。因此迁移设计不能把预下载参考数据、索引或二进制放入共享源码或测试基线。

## 候选能力与建议

| 方向 | 本地证据 | 能力与适配判断 | 建议 |
| --- | --- | --- | --- |
| GRN 推断 | OpenScience 的 `backend/cli/skills/coding/arboreto/SKILL.md` | GRNBoost2、GENIE3、TF 名单限制、输出 `TF/target/importance`，并支持 Dask；适用于 bulk/scRNA 表达矩阵。当前项目没有等价的网络推断能力。 | **第一优先级：迁移能力，不复制 Agent 框架。** 实现 `clitool/bio-grn/`。 |
| 调控元件与表观证据 | CellType 的 `src/ct/tools/epigenomics.py` | 以基因或坐标查询 CpG 岛、Roadmap ChromHMM、ENCODE ATAC/组蛋白 ChIP 的 narrowPeak、ReMap TF ChIP-seq 结合位点。正好补齐坐标级注释缺口。 | **第一优先级：重写为独立 CLI/服务适配层。** |
| Peak、motif 与染色质互作 | Biomni 的 `biomni/tool/genomics.py` | 提供 MACS2 peak calling、HOMER motif 富集、区域 overlap，以及以 `.cool/.hic` 和调控元件 BED 分析 enhancer—promoter interaction/TAD 的函数。当前 deepTools 可承接其下游 QC/可视化。 | **第二优先级：迁移工作流接口。** 保留外部工具为显式依赖，不搬 Biomni runtime。 |
| 高性能区间操作 | OpenScience 的 `backend/cli/skills/coding/gtars/SKILL.md` | Rust/Python 的 BED overlap、coverage/BigWig、refget、fragment split/score 与 tokenization。 | **按性能需要引入。** 首版可用标准 BED/Tabix 工具；高吞吐或 scATAC fragment 工作负载再评估。 |
| CRISPR 表观编辑/离靶 | CellType 的 `src/ct/tools/epigenomics.py` 中 `crispor_guide_design`、`cas_offinder` | CRISPOR 评分、Cas-OFFinder 离靶搜索；同一模块的 CpG 与可及性证据可用于位点优先级。 | **第二阶段。** 与现有 `molecular-cloning` 衔接，不另建重复 sgRNA 功能。 |
| 空间/细胞间网络 | SpatialAgent 的 `spatialagent/skill/`、`spatialagent/tool/analytics.py` | 有 ligand-receptor、轨迹、空间域及多模态整合。细胞间通讯（CCI）与 TF→靶基因 GRN 是不同问题。 | **暂不迁移整套。** 仅当空间转录组成为明确需求时，抽取薄工作流。 |
| 合成调控网络设计 | OpenScience 的 `backend/cli/skills/biology/synthetic-biology/SKILL.md` | 覆盖 ODE、SBML、双稳态/分岔、表达盒和 fitness 分析；能力与当前 `synthetic-biology` 基本重合。 | **不迁移。** 未来若需智能优化，在现有 Skill 上增加多目标优化与实验约束即可。 |
| 构建/克隆辅助 | BenchAid 的 `skills/construct-generator/SKILL.md`、`skills/primerdesigner/SKILL.md`、`skills/cloning/SKILL.md` | 偏 LIC/Gibson/SLIC、引物、GenBank/质粒构建，非调控解析核心，且与当前 `molecular-cloning` 高度重叠。 | **不迁移。** |

### 1. `bio-grn` 的最小产品

来源 Skill 明确要求表达矩阵为“观测（细胞/样本）×基因”，可选 TF 清单，并输出 TF、target、importance；见 `../other/oss-bioagents/openscience/backend/cli/skills/coding/arboreto/SKILL.md`。

建议 CLI 契约：

```text
bio-grn infer \
  --expression expression.tsv \
  --tfs transcription_factors.txt \
  --method grnboost2 \
  --seed 777 \
  --output results/network.tsv
```

最低输出包括：带列名的 edge table（`tf,target,importance`）、输入/过滤统计、版本和随机种子的 manifest、按 target 或 importance 的可配置筛选结果。对于单细胞数据，需要记录聚合/抽样策略、细胞数、批次处理方式，避免把 dropout 或批次效应误当成调控边。测试应使用小型合成矩阵，断言固定 seed 下的输出 schema、可复现性和错误处理，而非依赖用户的 `data/`。

### 2. `bio-regulatory` 的最小产品

CellType 实现位于 `../other/oss-bioagents/celltype-agent/src/ct/tools/epigenomics.py`，其中：

- `cpg_island` 查询 UCSC hg38 CpG Island 的 tabix BED；
- `chromatin_state` 使用 Roadmap 的 15-state ChromHMM 和组织到 epigenome ID 的映射；
- `encode_accessibility` 查询 ENCODE ATAC-seq 或组蛋白 ChIP-seq narrowPeak；
- `remap_tf_binding` 查询 ReMap 2022 hg38 TF ChIP-seq tabix BED。

新实现应统一接受 `--gene` 或 `--region chr:start-end`，同时显式要求 genome build、组织/细胞类型和数据版本；输出一份结构化证据表及机器可读 JSON。每条证据都应含来源、assembly、坐标、样本/细胞类型、实验类型、文件/版本和查询参数。不要把“存在 peak/ChIP 命中”呈现为功能性调控已经被证明。

CellType 的原实现通过 Ensembl REST 解基因坐标、使用 `pysam.TabixFile` 查询本地索引数据，并在缺数据时返回错误。因此本项目应定义可配置的数据目录和显式 `prepare-data` 步骤，而不是把下载放在一次普通查询中。应把数据基准版本、checksum、tabix 索引和来源许可写入 manifest。

### 3. 元件发现、motif 与三维证据

Biomni 的实现来源为 `../other/oss-bioagents/Biomni/biomni/tool/genomics.py`：

- `perform_chipseq_peak_calling_with_macs2` 在 PATH 中调用 MACS2，产生 narrowPeak、summits BED 和统计；
- `find_enriched_motifs_with_homer` 调用 `findMotifsGenome.pl`，可传用户背景区间；
- `analyze_chromatin_interactions` 读取 `.cool/.hic` 与标记为 enhancer/promoter 的 BED，分析候选 enhancer—promoter interaction 与 TAD；
- `analyze_genomic_region_overlap` 覆盖多个区间集合的 overlap 分析。

推荐编排为：

```text
alignment/fragments
  → peak calling（MACS2）
  → QC 与信号图（现有 deepTools）
  → motif enrichment（HOMER；带匹配背景）
  → 区间注释 / ReMap / ENCODE 证据（bio-regulatory）
  → 可选 Hi-C/HiChIP/CRISPR 扰动证据的元件—基因链接
  → 与 bio-grn 边做证据分级，而非简单合并为“真网络”
```

MACS2、HOMER、cooler 和相关参考基因组必须作为可检测的外部依赖；CLI 应在执行前报告版本、assembly、背景集合和缺失依赖。Gtars 可以在大量 BED overlap、coverage 或 scATAC fragment 处理成为性能瓶颈时替换区间层，其来源为 `../other/oss-bioagents/openscience/backend/cli/skills/coding/gtars/SKILL.md`。

### 4. CRISPR 表观编辑设计应如何接入

CellType 的 `crispor_guide_design` 依赖本地 CRISPOR 与 `hg38.2bit`；`cas_offinder` 依赖 Cas-OFFinder 可执行文件和同一参考基因组。它们不能只复制 Python 函数就可运行。建议在现有 `molecular-cloning` 的 sgRNA/离靶能力上增加可选的“表观编辑位点评分”步骤，按以下顺序给出候选而非确定性结论：

1. `bio-regulatory` 检查 CpG 岛、染色质状态、ATAC 与组蛋白标记；
2. 生成 sgRNA 并做序列/离靶评分；
3. 将 scaffold、PAM、参考版本、离靶搜索参数和证据版本写入设计报告；
4. 需要实验验证时，明确 CRISPRi/a、CRISPRoff 等效应依赖细胞上下文，不能由计算结果保证。

## 推荐实施顺序与验收条件

| 阶段 | 交付物 | 关键验收条件 |
| --- | --- | --- |
| P0：设计 | 输入/输出 schema、assembly 与数据版本策略、错误模型 | 后端 API 契约与 Web 消费方式先确认；不让 Web 直接导入 backend 模块。 |
| P1：GRN | `clitool/bio-grn/`、对应 Skill、最小测试 | 固定 seed 可复现；TF 过滤、schema、无效矩阵与依赖缺失均有测试；输出标为候选关联。 |
| P2：元件证据 | `bio-regulatory` 查询/准备 CLI、对应 Skill、版本化 manifest | gene/region 都可查询；assembly 不匹配会失败；每项证据带来源/版本；本地数据不入库。 |
| P3：peak/motif/linking | MACS2/HOMER/区间整合工作流 | 明确输入对照、背景和工具版本；深度图由 deepTools 生成；不以单一证据宣称直接调控。 |
| P4：编辑和多组学 | `bio-epiedit` 表观编辑候选排序；`bio-multiome` scRNA+scATAC 证据链接；空间工作流按需另立模块 | 排序保留政策与输入哈希；assembly 不一致失败；整合报告将 peak–gene、RNA/ATAC 和 GRN 分列，空间/CCI 不与 GRN 混写。 |

### 5. P4 首版模块边界

`bio-epiedit` 只消费已有 sgRNA、离靶评分与 P2/P3 产物，按版本化评分策略输出实验优先级；它不生成 guide、不调用 CRISPOR/Cas-OFFinder，也不预测编辑效力。CRISPOR、Cas-OFFinder 和参考基因组的安装、版本与许可确认完成后，才能作为独立外部 Adapter 接入。

`bio-multiome` 只消费预处理后导出的 cell-by-gene RNA、cell-by-peak ATAC 和 cell metadata TSV。它验证共有细胞、assembly 与分组，针对 P3 peak–gene 候选按组计算 RNA/ATAC 关联，并将 P1 GRN target 支持作为独立列保留；它不训练或复制 scVI/MultiVI。空间表达、邻域和 CCI 应在有明确数据与问题时建设独立 `bio-spatial` 模块，并以不同 evidence type 输出。

实施时在 `agent-client/` 运行与变更匹配的 `npm run test` 和 `npm run build`；新增 CLI 也应有其自身测试。涉及配置、依赖或启动方式时，按项目约定同步 `README.md`、`docs/development.md` 或配置说明。

## 许可、数据与复用边界

| 项目 | 本地许可证据 | 可复用判断与额外限制 |
| --- | --- | --- |
| OpenScience | 根仓库 Apache-2.0：`../other/oss-bioagents/openscience/LICENSE` | OpenScience 包装层可按 Apache-2.0 审查。Arboreto Skill front matter 标为 BSD-3-Clause、synthetic-biology 标为 MIT；这些是其声称的上游依赖许可，实际引入前仍须在锁定版本的上游发布物中复核。Gtars Skill front matter 为 `license: Unknown`，不得依据 OpenScience 根许可证假定上游 gtars 可被复制；优先作为外部依赖消费或先完成上游许可核查。 |
| CellType | MIT：`../other/oss-bioagents/celltype-agent/LICENSE` | MIT 覆盖该实现代码，不自动覆盖 UCSC、Roadmap、ENCODE、ReMap、Ensembl、CRISPOR 或 Cas-OFFinder 的数据、服务或二进制。每个下载源及其再分发/商业使用条款必须单独审查。 |
| Biomni | Apache-2.0：`../other/oss-bioagents/Biomni/LICENSE` | 代码许可不等于集成数据许可。其 README（约第 407 行）和 `biomni/license_info.md` 明确部分工具/数据库有更严格商业或非商业限制，并以 `commercial_mode` 过滤。只移植工具编排时仍需保留归属和 NOTICE；复制数据、下载脚本或数据库绑定前需逐项许可审查。 |
| SpatialAgent | MIT：`../other/oss-bioagents/SpatialAgent/LICENSE.txt` | 源码可按 MIT 评估，但 CZI Census、OmniPath 等外部数据/API 的使用条件不由该许可证授予。 |
| BenchAid | 本地快照根目录未发现 `LICENSE`/`COPYING`；其 `README.md` 文字称 MIT | 许可证据不完整，不能直接复制实现。且其能力与本项目克隆 Skill 重叠，不构成当前迁移目标。 |

除源码许可外，临床样本、受控访问组学数据和用户上传的序列/坐标还应遵循项目的数据治理要求。`workspace/`、`data/`、`.env`、参考基因组及大型索引都不得提交。

## 本地一手证据索引

- Arboreto Skill：`../other/oss-bioagents/openscience/backend/cli/skills/coding/arboreto/SKILL.md`
- Gtars Skill：`../other/oss-bioagents/openscience/backend/cli/skills/coding/gtars/SKILL.md`
- OpenScience synthetic-biology Skill：`../other/oss-bioagents/openscience/backend/cli/skills/biology/synthetic-biology/SKILL.md`
- CellType epigenomics 实现：`../other/oss-bioagents/celltype-agent/src/ct/tools/epigenomics.py`
- Biomni genomics 实现：`../other/oss-bioagents/Biomni/biomni/tool/genomics.py`
- Biomni 数据许可说明：`../other/oss-bioagents/Biomni/license_info.md`
- SpatialAgent Skill/工具目录：`../other/oss-bioagents/SpatialAgent/spatialagent/skill/`、`../other/oss-bioagents/SpatialAgent/spatialagent/tool/analytics.py`
- BenchAid 相关 Skill：`../other/oss-bioagents/benchaid/skills/`
