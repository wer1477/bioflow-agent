---
name: evidence-appraisal
description: Build a claim-evidence matrix that links every claim to verbatim source text, a locator, a support/contradict verdict, confidence, and retraction status. Use to verify references, check whether citations support claims, grade evidence, or audit a manuscript's evidence chain.
---

# 证据核验与分级

这个 Skill 回答的不是“这篇文献说了什么”，而是“这条主张是否真的被这个来源支持”。引用存在 ≠ 支持主张；摘要支持 ≠ 全文支持；综述支持 ≠ 原始研究支持。

## 一、什么时候用

适用：

- 核对稿件/报告里的引用是否支持对应断言。
- 建立证据表，为写作、审稿、决策提供可追溯依据。
- 评估证据强度/确定性，识别过度解释。
- 审查文献综述、基金申请、临床/监管文档的证据链。

不适用：

- 从零做文献检索（先用 `lit-review`）。
- 需要跑统计/实验（交给 Researcher）。
- 需要写稿件（用 `scientific-writing`）。

## 二、产出契约

写入：

```text
evidence/
  claims.csv
  matrix.md
```

`claims.csv` 字段：

`claim_id, claim_text, source_id, source_type, locator, quote, verdict, confidence, retraction_status, notes`

- `verdict`：supports / partially-supports / contradicts / unrelated / unverifiable。
- `confidence`：high / medium / low，并写理由（设计、样本、直接性、一致性）。
- `quote`：≤25 词的原文短引，必须能在 locator 处找到；不要改写后当引文。
- `locator`：DOI/PMID/PMCID/页码/章节/图/表；没有 locator 不能判 supports。

`matrix.md` 按主张汇总：

| claim | 来源数 | 支持/反对 | 最强证据 | 主要限制 | 结论 |
| --- | --- | --- | --- | --- | --- |

## 三、工作流

### 1. 把主张拆到最小可核验单元

一条主张只包含一个可判断的断言。例如：

- “X 在 Y 中上调”是一个主张。
- “X 通过 Z 导致 Y”包含关联、机制、因果三个可分开核验的主张。

拆不动的主张通常太模糊，先改写。

### 2. 定位来源

- 优先原始研究；综述只作为线索。
- 用 `science-search fetch --source pubmed --id ...` / `crossref` / `europepmc` 核对元数据。
- 用 `biomcp` / `biocontext` 核对临床/变异/蛋白/通路等结构化证据。
- 需要全文时获取 PDF/HTML；只有摘要时把 verdict 降级为 `unverifiable` 或 `partially-supports`，并写清原因。

### 3. 读来源，不读标题

至少确认：

- 研究设计、样本、系统、干预/暴露、对照、结局。
- 结果的方向、大小、不确定性、统计支持。
- 作者自己的限制，以及是否与主张范围匹配。
- 结论是否只适用于亚组/特定条件。

在原文中定位支持/反对的句子，复制短引并记录位置。

### 4. 判断支持程度

| verdict | 含义 | 典型情况 |
| --- | --- | --- |
| supports | 来源直接、明确支持主张 | 原始研究的主要结果与主张同向、同范围 |
| partially-supports | 支持但有条件/范围差异 | 只在亚组、物种、剂量、时间窗成立 |
| contradicts | 来源结果与主张相反 | 方向相反、无效应且 CI 排除有意义效应 |
| unrelated | 来源不涉及该主张 | 标题相关但结果无关、引用错位 |
| unverifiable | 无法判断 | 只有摘要、全文不可得、方法/数据不足 |

不要用“支持”掩盖“部分支持”；不要把“不显著”直接判为 contradicts（除非 CI 排除了有意义的效应）。

### 5. 评价证据强度

按问题类型选择框架，不要硬套：

- 干预效果：随机化、盲法、依从性、ITT、效应量/CI。
- 观察性病因：混杂、选择、测量、反向因果、剂量反应、一致性。
- 诊断准确性：参考标准、谱偏倚、验证偏倚、阈值预设。
- 预后：随访完整性、竞争风险、过拟合、外部验证。
- 系统综述：检索完整性、筛选可复现、异质性、发表偏倚。
- 机器学习：数据泄漏、划分、基线、校准、外部验证。

可参考的风险偏倚工具（只在适用时使用，不冒充正式评估）：

- RoB 2：随机试验。
- ROBINS-I：非随机干预研究。
- QUADAS-2：诊断准确性。
- PROBAST：预测模型。
- AMSTAR 2：系统综述。
- JBI 清单：质性/描述性研究。

分级写“高/中/低/极低确定性 + 理由”，说明是内部判断；不要写“GRADE 1A”除非真的做了完整 GRADE。

### 6. 检查撤稿/更正/版本

- 用 Crossref/PubMed/期刊页面检查 retraction、correction、expression of concern。
- 预印本检查是否有正式发表版本；版本差异是否改变结论。
- 会议摘要/数据库记录是否有后续完整论文。
- `retraction_status` 必须实际检查后填写，不能默认 clear。

### 7. 处理冲突证据

- 先看是否真的测同一个构念/人群/条件。
- 比较设计质量：随机 vs 观察、样本量、盲法、测量误差。
- 不要用“票数”投票；小样本阳性研究不应压过大样本阴性研究。
- 若冲突无法解释，保留两种结论并写清判别所需数据。

### 8. 交付

最终消息包含：

1. 核验了哪些主张、多少来源。
2. 哪些主张被强支持、哪些只有部分支持、哪些被反驳/无法核验。
3. 最严重的证据缺口（可能导致结论改变）。
4. `claims.csv` / `matrix.md` 路径。
5. 置信度与未决问题。

## 四、质量检查表

- [ ] 每条 claim 都有 locator；没有 locator 的条目没有标 supports。
- [ ] 短引能在原文定位，未改写。
- [ ] 区分原始研究/综述/预印本/数据库/指南。
- [ ] 检查了撤稿/更正/版本。
- [ ] 评估了设计、样本、直接性、一致性，不只写“证据强”。
- [ ] 处理了相反证据，没有选择性纳入。
- [ ] 结论范围与来源范围一致（物种/人群/剂量/时间）。
- [ ] 不确定的地方明确标 unverifiable/low。

## 五、常见反模式

| 反模式 | 问题 | 修正 |
| --- | --- | --- |
| 引用存在就判支持 | 引用错位/标题党 | 读原文并定位支持句 |
| 只看摘要 | 结论可能被正文限制推翻 | 获取全文；否则降级 |
| 综述转引 | 原始研究可能相反 | 回溯原始文献 |
| 把不显著当无效应 | 可能样本不足 | 看 CI 和效应量 |
| 用票数解决冲突 | 质量差异被忽略 | 按设计/偏倚/样本量权衡 |
| 不说撤稿状态 | 引用撤稿文献 | 实际检查并记录 |
| 伪造分级 | “GRADE 高”无依据 | 写确定性和理由 |

## 六、与团队的分工

- Searcher 用本 Skill 产出 `evidence-table.csv`；Reviewer 用它审查稿件证据链；Writer 用它核对引用。
- 需要补检索 → 用 `lit-review`。
- 需要补分析/复现 → 交给 Researcher。
- 需要改写稿件 → 交给 Writer；本 Skill 只给证据判断，不改叙事。

## 七、与 manuscript audit 的衔接

- 本 Skill 的 `claims.csv` 是证据核验工作表；Writer 的 `manuscript/claim-evidence.csv` 是初稿后的 **edge 索引**，一行一条 claim-evidence，不是同一张表。
- 初稿后由 Writer 显式调用 `toollibrary action="manuscript-audit"`；biod 只做 L1 证据覆盖 + L2 支持关系风险筛查，返回 `manuscript/audit-<slug>.md`。
- audit 的 `no_issue_found` 不是“已证实”；最终支持判断仍由 Reviewer/人做；audit 不替代本 Skill 的原文核验。
