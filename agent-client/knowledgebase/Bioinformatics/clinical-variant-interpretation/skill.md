---
name: "Clinical Variant Interpretation"
description: "Decision points on germline ACMG/AMP and ClinGen SVI specifications, VUS handling, ClinVar/gnomAD evidence rules, CNV and somatic tiering, and the boundaries of reporting."
---

# Clinical Variant Interpretation

## 适用场景

在给定基因、转录本、疾病与基因组版本的前提下，判断 SNV/indel/CNV 的临床意义，或复核既有致病性分类、撰写证据摘要、决定 VUS 如何报告与复评。本条目讲「证据如何组合成结论」；原始变异检测、过滤与注释分别见「变异检测与过滤最佳实践」与 bio-variant（VEP 注释）说明。

## 第一步：先选框架

分类结论取决于问题本身，胚系与体细胞是两套不能混用的框架：

| 变异来源 | 框架 | 回答的问题 | 关键出处 |
|---|---|---|---|
| 胚系（遗传性） | ACMG/AMP 2015 + ClinGen SVI 修正 | 是否导致孟德尔病 | Richards 2015 |
| 体细胞（肿瘤）可操作性 | AMP/ASCO/CAP Tier I–IV | 对该肿瘤类型有无诊断/预后/治疗意义 | Li 2017 |
| 体细胞（肿瘤）致癌性 | ClinGen/CGC/VICC 打分 | 是否为驱动变异 | Horak 2022 |

体细胞变异套用 ACMG 胚系标准是范畴错误：ACMG 问「是否致病」，肿瘤变异要回答「是否致癌」和「是否可治疗」，这是两个独立的轴。致癌不等于可治疗，Tier 由肿瘤类型决定（同一 BRAF V600E 在黑色素瘤是 Tier I，在别的瘤种未必）。

套用通用 ACMG 前先查该基因有无 ClinGen VCEP 专家规范（遗传性耳聋、RASopathy、心肌病、ENIGMA BRCA1/2 等）。VCEP 规范会重新加权证据、约束组合并覆盖通用默认值；ClinVar 里的 3 星记录往往就来自某个 VCEP。

## ACMG/AMP 2015 基线

五级分类：Pathogenic、Likely Pathogenic、VUS、Likely Benign、Benign。28 条证据按强度分组：

- 致病侧：PVS1（very strong）；PS1–PS4（strong）；PM1–PM6（moderate）；PP1–PP5（supporting）。
- 良性侧：BA1（stand-alone）；BS1–BS4（strong）；BP1–BP7（supporting）。

2015 的组合规则是「拼积木」式定性规则，例如 PVS1 + 任一 strong 为致病、两条 strong 为致病、一条 strong 加若干 moderate/supporting 为可能致病、BA1 单独成立即良性。问题在于这些组合并非严格对等可加，部分组合在数学上等价于更高或更低一级，这正是后续贝叶斯化的动因。

## 必须叠加的 ClinGen SVI 修正（2018–2025）

直接使用 2015 原始规则在当前是已知错误，下列修正必须叠加：

| 时间 | 修正 | 对分类的影响 |
|---|---|---|
| 2018 | PVS1 改为分级决策树（Abou Tayoun 2018） | 不是任意 HIGH impact 都触发；按 NMD、外显子位置与 LOF 机制给 Very Strong/Strong/Moderate/Supporting |
| 2018 | PP5/BP6 废止（Biesecker & Harrison 2018） | 数据库断言不能当证据，须回到原始数据 |
| 2018 | BA1 更新推荐（Ghosh 2018） | 明确 5% 阈值的适用边界与例外清单 |
| 2020 | PM2 降为 PM2_Supporting（SVI PM2 v1.0） | 「gnomAD 中缺失」最多 supporting；应优先用计算过滤频率而非「严格缺失」 |
| 2020 | Tavtigian 贝叶斯点数体系 | 按点数相加合成等级，取代部分定性组合 |
| 2022 | PP3/BP4 校准（Pejaver 2022） | 计算预测按校准阈值给 supporting/moderate/strong；只用一个工具 |
| 2023 | 剪接证据规范（Walker 2023，SVI Splicing Subgroup） | SpliceAI 等剪接预测可给 PP3/BP4，有专门强度与适用边界 |
| 2024 | 扩展预测工具校准（Bergquist 2024） | AlphaMissense、ESM1b、VARITY 等在校准后可到 strong |
| 2024–2025 | gnomAD v4/v4.1 与 FAF 使用规范（VCEP 2025-06 通信） | BA1/BS1 用 Grpmax Filtering AF，不再用「严格缺失」定义 PM2 |

### 贝叶斯点数（Tavtigian 2018/2020）

每条证据按强度换算点数：Supporting ±1、Moderate ±2、Strong ±4、Very Strong ±8，良性证据取负值。相加后：≥10 致病；6–9 可能致病；0–5 VUS；−1 至 −6 可能良性；≤−7 良性。点数体系的价值是可复现、可表达分数强度，也是 VCEP 逐步采用的报告方式。注意 0–5 的 VUS 区间很宽，「差一点到 6 分」不等于倾向致病。

## PVS1 决策树（最常被误用的一条）

PVS1 不能由 consequence 工具给出的 stop_gained/frameshift 直接触发。按顺序判断：

1. **基因 LOF 机制**：只有该基因的致病机制是功能缺失（单倍剂量不足）时 PVS1 才适用。对 gain-of-function / dominant-negative 基因，一个 null 等位可能无害，不得给 PVS1。
2. **转录本**：在 MANE Select 上评估，不要挑「后果最严重」的次要转录本。
3. **NMD 50–55 nt 规则**：提前终止密码子若位于最后一个外显子-外显子连接点上游约 50–55 nt 以上，触发 NMD，按 true LOF 给全强度；若位于末外显子、距末连接点 ≤50 nt 或单外显子基因，则逃逸 NMD，蛋白仍被翻译，应按丢失的结构域与功能降到 Strong/Moderate/Supporting。
4. **剪接**：经典剪接位点变异若要按 PVS1 处理，需证明其确实导致 LOF（异常转录本被降解或丢失关键结构域），否则走剪接证据体系（PP3/BP4/PS3）。

把 SnpEff/ANNOVAR 的 HIGH impact 直接写成 PVS1，是可复现的系统性过度判读。

## 人群频率：用 grpmax FAF，不用全局 AF

BA1/BS1/PM2 都依赖人群频率，且必须结合疾病语境：

- 使用 gnomAD 的 **grpmax filtering AF（FAF）**：取遗传祖先分组中最高频率组的 95% CI 下限（gnomAD v4 字段 `fafmax_faf95_max`，联合 VCF 为 `fafmax_faf95_max_joint`）。全局 AF 会稀释只在某一祖系常见的变异；CI 下限可避免小群体噪声。
- 与疾病的最大可信人群频率（由患病率、遗传异质性、外显率、遗传方式推算，Whiffin 2017）比较：FAF 高于该阈值才可给 BA1/BS1，不能使用「统一 1%」。
- **gnomAD 中存在不等于良性**：隐性病携带者（如 CFTR）、晚发/低外显率等位、克隆性造血（DNMT3A/TET2 等低 AF 变异）、比对伪影都可能「看起来常见」。要看 PASS 与质量标记，而不是裸 AF。
- 祖系采样不均，「缺失」对采样不足的祖系是更弱的证据；PM2/BS1 的强度隐含依赖祖系。
- 版本与坐标：gnomAD v2.1.1 是 GRCh37，v3/v4 是 GRCh38；跨版本比较前先 liftover 并核对位点可判定性。ClinGen 2025 年建议 VCEP 尽早迁移到 v4，并把 BA1/BS1/PM2 改为计算频率口径。
- 基因水平约束（LOEUF）：LOEUF 是基因 LOF 变异观察值/期望值比的上限，越低表示越受约束（常用约 <0.35 作为受约束基因的粗略界值）。它可用于判断「该基因的 LOF 是否真有致病性」这一 PVS1 机制前提，以及解释 CNV 剂量敏感性；但 LOEUF 是基因级统计量，不是变异级证据，不能单独支持或否定某个变异的分类，且受转录本选择与变异注释质量影响。

## ClinVar：断言是线索，不是证据

按 review status 读取后再回到原始证据：

| CLNREVSTAT | 星级 | 能否作为证据 |
|---|---|---|
| practice_guideline | 4 | 最强单库信号，仍需核对当前证据 |
| reviewed_by_expert_panel | 3 | VCEP 结论，常意味着存在基因规范 |
| criteria_provided, multiple submitters, no conflicts | 2 | 共识级；检查提交者是否共享同一错误 |
| criteria_provided, single submitter | 1 | 仅作线索，不能作为证据 |
| criteria_provided, conflicting | 1 | 冲突本身是信息，不要取平均 |
| no_assertion_criteria_provided | 0 | 无权重 |

一致性不等于独立性：两个提交者可能复制同一个原始错误。冲突分类往往指向真正困难的变异（外显率、祖系、机制），应调查而不是平均。PP5/BP6 被废止，原因就是「断言不能作为证据输入」。

## 计算预测：只用一个，按校准强度

- PP3/BP4 是分级且互斥的。选定一个在 ClinGen 校准中达到可用等级的工具，在其校准阈值上使用，不要叠加多个相关工具制造「独立性」。
- REVEL 是 13 个分数的集成（含 SIFT、PolyPhen），「REVEL 与 PolyPhen 一致」不是相互印证。
- Pejaver 2022 校准中 SIFT/PolyPhen-2 未达到 supporting；原始 CADD 也未达到 missense PP3 的 supporting（CADD 更适合全基因组/非编码排序）。
- AlphaMissense、ESM1b、VARITY 等在 2024 年扩展校准中可达 strong 致病 / moderate 良性，但必须使用其校准阈值，不能套用开发者默认分类。
- 剪接：SpliceAI 在经典 ±1,2 位点之外，Δ 分数 ≥0.2 可给 PP3_Moderate、≤0.1 可给 BP4_Moderate（Walker 2023），打分窗口需放宽（默认窗口会漏掉深内含子与假外显子）；SpliceAI 不报告剪接后果类型（外显子跳跃 vs 内含子保留），而后者决定 PVS1 是否适用。

## VUS 处理与复评

- VUS 的正确含义是「现有证据不足」，不是「倾向致病」或「暂按致病处理」。不得据 VUS 做临床干预；家系共分离、功能实验、新文献可推动升级或降级。
- 建立复评循环：定期用新的 ClinVar/gnomAD 版本、新的 VCEP 规范与文献重注释已存 VCF，标出证据发生变化的 VUS。分类是「证据快照」，没有复评机制的分类是潜在错误。
- 复评时保留原报告的证据版本与日期，记录分类变化的原因，而不是覆盖旧结论。

## 拷贝数变异（CNV）

- 胚系 CNV 用 ACMG/ClinGen 2019/2020 技术标准的半定量点数法：拷贝数丢失与获得分别有两套评分表，五个等级；总分 ≥0.99 致病、0.90–0.98 可能致病、−0.89–0.89 VUS、−0.90–−0.98 可能良性、≤−0.99 良性。
- 评分分节：基因/功能元件内容、与已知单倍剂量不足（HI）/三倍剂量敏感（TS）区域的重叠、蛋白编码基因数、病例与文献证据、遗传方式（de novo 且亲子关系确认是强证据；来自健康双亲的遗传是良性证据）。
- ClassifyCNV/AnnotSV 只能自动处理第 1–3 节（基因内容、剂量敏感区域、人群频率）；de novo、共分离、文献需要人工补分。只跑工具会把几乎所有新 CNV 留在 VUS，因为「未评分」不等于「无证据」。
- 使用前更新 ClinGen 剂量数据库并记录版本，HI/TS 评分在持续更新。体细胞 CNV 不要用胚系 CNV 打分，应使用肿瘤可操作性框架。

## 体细胞变异：两个独立坐标轴

- **AMP/ASCO/CAP Tier（Li 2017）**：Tier I 强意义（该瘤种有获批药物或指南推荐）；Tier II 潜在意义（其他瘤种证据、试验证据）；Tier III 未知（体细胞版 VUS）；Tier IV 良性。
- **ClinGen/CGC/VICC 致癌性（Horak 2022）**：Oncogenic–Benign，使用肿瘤特异证据代码（热点复发、功能数据、瘤种频率）。致癌性与可操作性不是同一件事。
- 证据库：OncoKB Levels 1–4 与 R1/R2、CIViC 证据等级 A–E、COSMIC 热点复发（是信号，不是可操作性）。
- tumor-only 检测无法干净区分胚系与体细胞：VAF 约 50% 或约 100% 的变异可能是胚系；应使用 germline resource + PoN，并在报告中明确披露，或改用配对 tumor-normal。

## 报告与边界

- 报告必须写清：基因组版本、MANE Select 转录本、HGVS（遵循 3′ 规则，不要从 VCF POS 手推）、分类与证据条目、证据来源版本与日期、方法与限制。
- VCEP 规范优先于通用规则；报告应注明是否使用了 VCEP 规范及其版本。
- 临床报告需在 CLIA/CAP 等合规体系下签发；研究流程输出不得表述为临床诊断。
- 偶然发现/次要发现按 ACMG SF v3.2 等本地政策处理（是否报告需事先约定），不要擅自把全基因组发现塞进报告。
- 对 VUS 的措辞要明确「现有证据不足以改变临床管理」；对可能致病也要说明证据缺口。
- 报告级变异宜做正交验证（Sanger、不同平台）；仅凭单一 NGS 调用直接出临床报告有风险。

## 常见陷阱

1. 用 2015 原始组合规则，不给 PVS1 分级、PM2 用 moderate。
2. 把 SnpEff HIGH impact 当 PVS1。
3. 选「最严重」的转录本而不是 MANE Select。
4. 用全局 AF 判断 BA1/BS1，忽略 grpmax 与疾病频率上限。
5. 把 1 星 ClinVar 断言当证据，或把 3 星当成不可质疑。
6. 叠加 SIFT + PolyPhen + REVEL 当多条独立证据。
7. 把 SpliceAI 高分直接当 PVS1/PS3。
8. 用 ACMG 胚系框架解读肿瘤变异，或用 Tier 系统给胚系变异分类。
9. 对 VUS 不设复评机制；报告不记录证据版本。
10. 对 CNV 只跑 ClassifyCNV 就出结论，把「未评分」当「无证据」。

## 与上下游的衔接

- 上游：变异检测与过滤（保真度决定后续证据是否成立）、VCF 归一化（ClinVar/gnomAD 匹配依赖规范表示）、VEP 注释（bio-variant 可提供 consequence、HGVS 与共定位临床意义，但那是研究上下文，不构成分类）。
- 下游：报告、遗传咨询、复评队列；体细胞路径对接肿瘤可操作性证据库与 MDT 讨论。
- 本条目是知识参考，不替代持证临床遗传学家的判断与实验室 SOP。

## 主要来源与快照日期

- 领域：生物信息学。内容定稿/快照日期：2026-10-20；其中 bioSkills 参考仓库快照为 2026-08-15。
- ACMG/AMP：Richards S, et al. Genet Med. 2015;17:405–424。
- ClinGen SVI：Abou Tayoun 2018（PVS1，Hum Mutat 39:1517）；Biesecker & Harrison 2018（PP5/BP6，Genet Med 20:1687）；Ghosh 2018（BA1 更新，Hum Mutat 39:1525）；PM2 v1.0（2020）；Tavtigian 2018/2020（贝叶斯与点数）；Pejaver 2022（PP3/BP4，AJHG 109:2163）；Walker 2023（剪接，AJHG 110:1046）；Bergquist 2024（扩展工具校准，Genet Med）；ClinGen VCEP 2025-06 gnomAD v4 通信与 ClinGen Variant Classification Guidance（2025-07 更新）。
- 数据库与指南：ClinVar、gnomAD v4.1（GRCh38；FAF/grpmax 字段）、ClinGen dosage map、ACMG SF v3.2。
- 胚系 CNV：Riggs ER, et al. ACMG/ClinGen 2019 技术标准（Genet Med 2020;22:245–257）；ClassifyCNV、AnnotSV 文档。
- 体细胞：Li MM, et al. J Mol Diagn. 2017;19:4–23；Horak P, et al. Genet Med. 2022;24:986–998；OncoKB、CIViC。
- 改写与署名：部分结构与决策取向参考 GPTomics/bioSkills（MIT License，https://github.com/GPTomics/bioSkills，2026-08-15 归档）之 variant-calling/clinical-interpretation 与 copy-number/germline-cnv-interpretation；已重写为中文决策级知识，未整段复制原文。
