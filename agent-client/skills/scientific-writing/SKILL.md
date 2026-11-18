---
name: scientific-writing
description: Assemble a submittable manuscript from results and evidence, with a claim-evidence matrix, section contracts, figures/tables, reporting-checklist mapping, reference verification, and submission materials. Use for paper structure, drafting, revision, cover letters, and response to reviewers. Does not change data or run analyses.
---

# 科学论文写作与投稿

这个 Skill 把“有一堆结果”变成“一份每一句都能追溯到证据的稿件”。写作不是给结果润色，而是先决定主张、证据和叙事，再写句子。

## 一、什么时候用

适用：

- 需要把分析结果组织成论文/预印本/报告。
- 需要写摘要、引言、方法、结果、讨论、图注、表格。
- 需要核对引用、准备投稿材料、回复审稿意见。
- 需要把 Reviewer 的意见转成修改计划。

不适用：

- 需要改数据、补分析（交给 Researcher）。
- 需要从零做文献综述（先用 `lit-review`）。
- 需要独立审查稿件（用 `peer-review`）。

## 二、产出契约

在项目目录下建立：

```text
manuscript/
  claim-evidence.csv     # 一行一条 claim-evidence edge
  outline.md             # 故事线 + 每节要证明什么
  manuscript.md          # 正文（或按 venue 模板输出 docx/tex）
  figures/               # 图 + 图注 + 数据来源
  tables/                # 表 + 脚注 + 统计说明
  references.bib         # 或 venue 要求的格式
  reporting-checklist.md # 所选指南的逐项对照
  cover-letter.md
  highlights.md
  response-to-reviewers.md
```

`claim-evidence.csv` 字段（一行一条 edge）：

`claim_id, section, claim_text, claim_type, evidence_id, evidence_type, evidence_locator, evidence_quote, evidence_scope, writer_relation, writer_status, notes`

- `claim_text` 是正文中的原子断言；一个 claim 只做一个断言，必须能在正文定位。
- `claim_type`：observation / association / causal / mechanism / generalization / methodological / interpretation / background。
- `evidence_type`：citation / figure / table / result_file / dataset / none；无证据的 claim 保留一行 `NONE`。
- `evidence_quote` 用原文短引/图注/结果字符串，不要改写；没有 locator 的主张不能标 supported。
- `writer_status`：supported / partially-supported / unsupported / needs-citation / needs-data；这是自评，不是审计结论。

## 三、工作流

### 1. 先建主张-证据矩阵

从结果文件和证据表里提取主张，不要从“想讲的 story”倒推。

- 每条主张一句话，可检验、可定位。
- 区分：直接观察、统计推断、机制解释、文献结论、作者观点。
- 标出互相冲突或依赖假设的主张。
- 先删掉没有证据的主张；不要用措辞掩盖证据缺口。

### 2. 决定故事线和投稿目标

写 `outline.md`：

- 一句话核心发现（不是“我们研究了 X”，而是“X 导致/预测/区别于 Y”）。
- 目标读者与 venue（期刊/会议/预印本/内部报告）。
- 每节要回答的问题：为什么做、怎么做、发现什么、意味着什么。
- 主要图表的顺序：每张图承担一个论证步骤。
- 明确“不放进正文”的结果及理由（补充材料/后续工作）。

故事线必须服从证据，而不是反过来。若核心主张只有相关性，标题和摘要不能写成因果。

### 3. 先做图表，再写正文

图表是论证的主干：

- 每张图一个清晰问题；面板按逻辑排序。
- 图注自足：样本量、统计方法、误差棒含义、显著性标记、重复数。
- 表格给出精确统计量：效应量、CI、p、n、校正方法。
- 图中数字必须和结果文件一致；不要手工改图。
- 避免误导性坐标轴、双 y 轴、3D、彩虹色、只画均值不画分布。
- 提供源数据/绘图脚本路径。

### 4. 按节写作

**Title**：具体、可检索、不夸大；包含系统/对象/主要发现。

**Abstract**：背景 1–2 句 → 问题/空白 → 方法 1–2 句 → 主要结果（带关键数字）→ 结论与意义。不引用文献，不写正文没有的结论。

**Introduction**：已知 → 未知 → 为什么重要 → 本研究做什么。最后一段明确问题/假设，不写“我们首次……”除非有检索证据。

**Methods**：可复现到别人能重做。写清样本、试剂、仪器、软件版本、参数、随机化/盲法、统计方法、伦理批准、数据/代码可及性。不要把结果解释塞进 Methods。

**Results**：按论证顺序，不按实验时间顺序。每段：问题 → 方法一句 → 结果（数字/图）→ 一句解释边界。不在 Results 里讨论文献。

**Discussion**：主要发现 → 与已有工作比较 → 机制解释 → 限制 → 意义/下一步。限制要具体，不要“样本量较小”一句话带过。

**Conclusion**：只写证据支持的结论；不引入新数据/新引用。

### 5. 核对引用

对每条引用：

- 用 `science-search fetch --source pubmed --id ...` / `crossref` 核对 DOI、作者、年份、期刊。
- 检查引用是否真的支持对应主张；标题相关不等于支持。
- 检查撤稿/更正/表达关注。
- 优先引用原始研究；综述只用于背景。
- 统一格式（数量、et al.、期刊缩写、DOI）。
- 不引用读不到的文献来凑数；不要用二手转引冒充原始来源。

### 5.5 初稿后证据链核查（Writer）

初稿和 citation 初核完成后：

1. 把 `claim-evidence.csv` 更新为 edge schema；`claim_text` 逐字来自正文，`evidence_quote` 用原文短引，无证据的 claim 保留 `NONE` 行。
2. 调用 `toollibrary action="manuscript-audit" path="manuscript/manuscript.md"`。
3. 读 `manuscript/audit-<slug>.md`；先处理 P0/P1，再决定 P2。
4. `no_issue_found` 只表示“未发现明显问题”，不等于 claim 已被证明；最终判断仍由 Writer 和 Reviewer 做。
5. 审计只返回报告；不自动改稿、不 gate、不替代 Reviewer。

### 6. 对照报告指南

按研究类型选择并逐项填写 `reporting-checklist.md`：

- 随机对照试验：CONSORT。
- 观察性研究：STROBE。
- 系统综述/meta 分析：PRISMA。
- 动物实验：ARRIVE。
- 病例报告：CARE。
- 诊断/预后模型：TRIPOD。
- 预测模型/机器学习：TRIPOD+AI 或相应领域指南。
- 组学研究：领域特定指南（如 MIAME/MINiML 等，按 venue 要求）。

指南不是装饰：缺项要写“不适用”及理由，不能空着。

### 7. 投稿与修改材料

- **Cover letter**：一句话贡献、为什么适合该 venue、原创性/未一稿多投声明、通讯作者信息。不要复述摘要。
- **Highlights**：3–5 条，每条一个可验证发现。
- **Response to reviewers**：逐条编号；引用修改位置（页码/行号/图号）；不同意时给证据和理由，不情绪化。
- **Data/code availability**：写清存放位置、accession、许可、受限数据的申请方式。
- **Ethics/COI/funding/authorship**：ICMJE 作者标准、CRediT 贡献、利益冲突、资助编号、AI 使用披露（按 venue 要求）。

### 8. 交付给 PI

最终消息包含：

1. 稿件当前状态（可投稿/需补数据/需补引用）。
2. 核心主张与证据强度。
3. 未能核实的引用/数字/主张清单。
4. 产物路径（正文、图、表、checklist、cover letter）。
5. 建议的下一步（补实验/补分析/改投/回复审稿）。

## 四、质量检查表

- [ ] 标题/摘要的每个结论都能在正文找到证据。
- [ ] 每张图/表都在正文被引用，且顺序一致。
- [ ] 数字与结果文件一致（样本量、p、CI、效应量）。
- [ ] 统计方法与设计匹配；多重性/缺失数据有交代。
- [ ] 引用可解析、支持主张、无撤稿。
- [ ] 初稿后跑过 `manuscript-audit`，P0/P1 已处理或记录。
- [ ] 报告指南逐项覆盖。
- [ ] 限制具体，且没有和结论矛盾。
- [ ] 数据/代码/伦理/COI/作者贡献齐全。
- [ ] 没有夸大因果、没有“首次”而无检索依据。
- [ ] 全文时态/术语/缩写一致。

## 五、常见反模式

| 反模式 | 问题 | 修正 |
| --- | --- | --- |
| 先定结论再找证据 | 选择性引用/过度解释 | 先建 claim-evidence 矩阵 |
| 摘要夸大 | 审稿人反感/撤稿风险 | 摘要只写正文支持的结论 |
| 把相关当因果 | 结论不可靠 | 改措辞或补因果设计 |
| 引用凑数 |  references 不可靠 | 每条引用核对 locator 和支持关系 |
| 图注不自足 | 读者无法理解 | 图注写 n、统计、误差棒、缩写 |
| 方法不可复现 | 无法重复 | 版本/参数/代码/数据路径齐全 |
| 回复审稿情绪化 | 影响决定 | 逐条、证据、修改位置 |
| 一稿多投/自我抄袭 | 学术不端 | 声明原创性、引用前作、按 venue 政策 |

## 六、与团队的分工

- 你只写和核验，不改数据、不跑新分析。
- 缺数字/方法细节 → 向 PI 要，或请 Researcher 提供结果表和 Methods 段落。
- 缺文献/证据强度 → 请 Searcher 补 `evidence-table.csv`。
- 投稿前审查 → 请 Reviewer 按 `peer-review` 独立审一遍；你负责修改和回复。
