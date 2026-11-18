---
name: lit-review
description: Run a reproducible literature review from a question to an evidence table, synthesis, and gap list. Use for systematic or scoping reviews, related-work surveys, research-landscape questions, and novelty checks. Uses the science-search CLI plus biomedical MCP servers; it does not execute experiments.
---

# 文献综述与证据综合

这个 Skill 是一套可复现的文献工作流，不是“搜几条摘要然后总结”。它的产物必须让另一位研究者只读文件和检索日志就能重建你的检索与筛选过程。执行实验、统计建模或写论文正文不属于本 Skill。

## 一、什么时候用

适用：

- 用户问“这个方向已经有什么工作”“某结论的证据有多强”“这个想法新不新”。
- 需要把一批文献整理成证据表、研究现状、争议点和空白。
- 需要为假设生成或实验设计提供文献边界。

不适用：

- 只要一条事实（用 `web_search` 或 `science-search fetch` 直接查更快）。
- 需要跑数据、做统计、做实验（交给 Researcher）。
- 需要写投稿正文（交给 Writer；本 Skill 只提供证据材料）。

## 二、产出契约

在项目目录下建立：

```text
research/lit-review/<slug>/
  question.md          # 问题、范围、纳排标准、日期
  search-log.md        # 每个数据库的检索式、日期、命中数、筛选数
  screening.csv        # 题录级筛选记录：title, year, source, decision, reason
  evidence-table.csv   # 提取后的证据：见下方字段
  synthesis.md         # 按主题综合，不按论文罗列
  gaps.md              # 真正未被回答的问题 + 为什么
```

`<slug>` 用 3–6 个英文小写词，例如 `tp53-splicing-therapy`。

`evidence-table.csv` 至少包含：

`claim_id, claim, source_type, source_id, source_locator, study_design, population_or_system, sample_size, intervention_or_exposure, comparator, outcome, effect_size, uncertainty, limitations, retraction_status, notes`

- `source_type`：peer-reviewed / preprint / conference / database / guideline / report / web。
- `source_locator`：DOI、PMID、PMCID、arXiv ID、数据库 accession，或页码/章节。没有 locator 的条目不能进入 `supported`。
- `retraction_status`：checked-clear / checked-retracted / not-checked。未核验就写 `not-checked`，不要写 clear。

## 三、工作流

### 1. 把问题写成可检索的形式

先写 `question.md`：

- 一句话问题。
- 问题类型：病因/机制、诊断、预后、干预效果、流行率、方法学、资源现状。
- 范围：物种、疾病/表型、人群、时间窗、语言、研究类型。
- 纳排标准：什么算相关，什么明确排除。
- 预期用途：支持假设、评估创新性、还是为实验设计选方法。

能用 PICO（人群/干预/对照/结局）、PEO（暴露/结局）或 SPIDER（定性）就用；用不了就写清楚“探索性范围综述”。

### 2. 先看工具能查什么，不要凭记忆写数据库名

```bash
science-search --describe --format json
science-search databases --format json
```

读返回的 connector id、可用字段、记录 id 形式。当前常用 source 包括 `pubmed`、`europepmc`、`biorxiv`、`openalex`、`semantic_scholar`、`crossref`、`arxiv`；变异/表达/通路等用对应 source。以运行时 registry 为准，不要照抄本文。

### 3. 建检索式并记录

每个数据库单独一行写进 `search-log.md`：

| 日期 | source | query | filters | hits | screened | included |
| --- | --- | --- | --- | --- | --- | --- |

要求：

- 同义词、缩写、旧名、物种名都要覆盖；基因/蛋白名注意别名和物种前缀。
- 用数据库支持的字段语法（PubMed 的 `[tiab]`、`[MeSH]` 等）；不确定就先跑小样本看返回。
- 先用窄检索定位核心文献，再用引文追踪（向前引用、向后参考文献）扩展。
- 记录 `next_cursor` 时原样保存，不要改写；分页查询必须带同一个 cursor 和查询条件。
- 日期、语言、文章类型过滤要写出来，不要只写在脑子里。

### 4. 检索

按“先精确、后扩展”的顺序：

```bash
science-search search --query '("TP53" OR "p53") AND splicing' --source pubmed --limit 20 --format json
science-search search --query 'TP53 splicing' --source biorxiv --limit 20 --format json
science-search fetch --source pubmed --id 12345678 --format json
science-search fetch --source europepmc --id PMC1234567 --fields title,abstract --format json
```

补充来源：

- `web_search` / `web_fetch`：指南、学会共识、监管文件、会议摘要、灰色文献。
- BioMCP（先 `toolload({id:"biomcp_search"})` 等）：临床试验、变异、药物、通路等结构化实体。
- BioContext（先 `toolload({id:"biocontext_get_europepmc_articles"})` 等）：Europe PMC 全文、bioRxiv 预印本、OLS 本体、HPA、PRIDE、PanglaoDB、ClinicalTrials.gov、FDA 药物、grants.gov。
- ToolUniverse（先加载 `tooluniverse_find_tools` / `tooluniverse_execute_tool`）：当前 skill 和 science-search 都没覆盖的专门数据库。

每次检索后读 `items`、`next_cursor` 和 `issues`。一个 source 失败不阻断其它 source；把失败写进 `search-log.md`。

### 5. 去重与筛选

1. 先按 DOI/PMID/标题+年份去重。
2. 题录级筛选：只读标题+摘要，按纳排标准判断；每条写 `decision`（include / exclude / maybe）和 `reason`。
3. 全文级筛选：读方法、结果、限制；不要只读摘要就下结论。
4. 记录数量：检索命中 → 去重后 → 题录纳入 → 全文纳入。像 PRISMA 一样把数字写进 `search-log.md`，但不要声称“系统综述”除非你真的按系统综述标准做了。

常见排除理由要具体：物种不符、无对照、无原始数据、重复发表、无法获取全文、结局不相关。

### 6. 提取证据

对每篇纳入文献提取 `evidence-table.csv` 的字段。重点不是抄结论，而是记录：

- 研究设计、样本量、研究系统（人/小鼠/细胞系/类器官）。
- 干预/暴露、对照、结局、效应量与不确定性。
- 作者自己承认的限制，以及你发现的额外限制。
- 结论所在位置（摘要/结果/讨论）和原文短引（≤25 词，用于核对，不要大段复制）。

### 7. 评价证据质量

对每条 claim 至少回答：

- 设计能否回答这个问题（横断面不能证明因果，体外不能直接外推到人）。
- 偏倚风险：选择、测量、混杂、失访、报告偏倚。
- 直接性：物种、剂量、人群、结局是否匹配。
- 一致性：不同研究是否一致；不一致时是否能用设计/人群解释。
- 精确性：样本量、置信区间、是否只有 p 值。
- 发表偏倚：是否只有阳性结果、是否小样本研究扎堆。

不要编造 GRADE 等级；可以写“高/中/低/极低确定性 + 理由”，并说明这是你的判断。

### 8. 综合，而不是罗列

`synthesis.md` 按主题组织：

- 每个主题：已确立的结论、证据强度、主要争议、关键空白。
- 明确区分“文献结论”“作者推断”“你的推断”。
- 对冲突证据给出可能解释（人群、剂量、方法、偏倚），不要简单投票。
- 指出哪些结论只是预印本、会议摘要或单一小组重复发表。

`gaps.md` 只写真正没被回答的问题，并说明：

- 为什么现有研究没回答（设计限制、样本、随访、物种）。
- 回答它需要什么类型的数据或实验。
- 是否值得做（影响、可行性、伦理/数据可及性）。

### 9. 交付给 PI

最终消息必须包含：

1. **结论**：3–6 条，按证据强度排序。
2. **证据强度**：每条结论后的设计类型/样本量/一致性/局限。
3. **争议与空白**：最重要的 1–3 个。
4. **产物路径**：上述 6 个文件的路径。
5. **未决问题/置信度**：哪些没查到全文、哪些数据库失败、哪些判断不确定。

如果任务要求假设，转 `hypothesis-design`；如果任务要求判断创新性，用检索结果做 novelty check，不要凭印象说“没人做过”。

## 四、引用与证据红线

- 不编造文献、DOI、PMID、作者、年份、期刊。
- 引用必须能落到 locator；只有标题没有 locator 的条目只能算线索。
- 预印本、会议摘要、公司白皮书、新闻稿要标注类型，不能和同行评议论文混在一起。
- 二手引用（综述里转引的原始研究）要尽量回到原始论文；回不到就标注“转引，未核验”。
- 发现撤稿/更正/表达关注时，在 `retraction_status` 和 `synthesis.md` 同时记录。
- 不要为了支持结论而选择性引用；相反证据必须进表。
- 不要把未发表数据、患者信息或稿件上传到外部搜索服务；只检索公开信息。

## 五、常见失败模式

| 失败 | 表现 | 修正 |
| --- | --- | --- |
| 检索太窄 | 只找到 3 篇，结论“没有研究” | 换同义词/数据库/引文追踪，再判断空白 |
| 检索太宽 | 上千条，无法筛选 | 加字段、物种、研究类型、日期限制 |
| 只读摘要 | 把摘要结论当全文结论 | 至少读结果和限制段 |
| 综述转引 | 引用的是综述不是原始研究 | 回溯原始文献，或标注转引 |
| 数量幻觉 | 声称“系统综述”但没有筛选日志 | 要么补齐日志，要么改称范围综述 |
| 证据等级幻觉 | 随口写“GRADE 高” | 写确定性和理由，不冒充正式 GRADE |
| 只报阳性 | 忽略阴性/冲突研究 | 把阴性结果和失败重复写进综合 |

## 六、与团队的分工

- 你负责检索、筛选、提取、综合、空白与创新性判断。
- 需要跑数据、做统计、验证机制 → 交给 Researcher，并在交付里写清需要的输入。
- 需要把证据写成稿件 → 交给 Writer，并保证 `evidence-table.csv` 的 locator 完整。
- 需要独立审查证据链 → 交给 Reviewer；你可以先按本 Skill 自检一遍。
