---
name: peer-review
description: Review a manuscript or research deliverable in explicit modes (pre-submission internal review, reviewer report, rebuttal check). Runs mechanical checks, claim-evidence audit, methods/statistics/reproducibility review, novelty check, and severity-ranked findings. Does not edit the manuscript or run new experiments.
---

# 同行评审与稿件审查

这个 Skill 的目标不是“挑毛病”，而是判断稿件的主张是否被证据支持、方法是否足以支持解释、读者能否复现。每条意见都要能落到具体位置、具体证据和可验证的修改。

## 一、什么时候用

适用：

- 投稿前内部审查（red team）。
- 模拟审稿人报告。
- 检查 rebuttal/response to reviewers 是否回应了问题。
- 审查内部报告、预印本、基金申请书的研究设计部分。

不适用：

- 需要改稿（交给 Writer）。
- 需要补实验/补分析（交给 Researcher）。
- 需要做完整文献综述（先用 `lit-review`）。

## 二、先确认模式

| 模式 | 输入 | 输出 |
| --- | --- | --- |
| pre-submission | 稿件 + 结果/证据/代码 | 阻断问题清单 + 修改建议 |
| reviewer report | 稿件（可能无原始数据） | 结构化审稿意见 + 推荐决定 |
| rebuttal check | 稿件 + 审稿意见 + 回复 | 哪些回应充分/不充分/回避 |

模式不同，允许的推断不同：

- 看不到原始数据时，只能判断“稿件内部一致性”和“方法描述是否足够”，不能断言数据造假。
- 看不到代码时，不能声称“不可复现”，只能写“复现所需信息缺失”。

## 三、产出契约

写入 `review/review-<slug>.md`：

```markdown
# Review: <title>

## 0. 模式与范围
## 1. 一句话总结
## 2. 主要主张与证据强度
## 3. 阻断问题（Blocking）
## 4. 重要问题（Important）
## 5. 建议（Suggestion）
## 6. 机械检查
## 7. 方法学审查
## 8. 统计审查
## 9. 可复现性审查
## 10. 新颖性/先行工作
## 11. 推荐决定与理由
## 12. 给作者的修改清单
```

结构化 issue 索引写到 `review/issues.csv`（一行一条 issue-premise；`manuscript-audit` / `issue-audit` 读它）：

```csv
issue_id,section,issue_text,issue_type,severity_claim,premise_id,premise_kind,premise_text,anchor_locator,anchor_quote,anchor_quote_2,search_terms,owner_suggested,notes
I001,methods,"The primary model is not adjusted for confounders.",statistical,blocking,P1,passage,"The primary model is described as unadjusted.","Methods ¶1","We fitted an adjusted multivariable Cox model...",,,researcher,
I002,methods,"Sample size justification is missing.",methodological,important,P1,absence,"The manuscript does not report a sample size estimate.","Methods",,,"sample size|power calculation",,
```

- 一条 issue 拆 1–4 条 premise；每行一个前提，issue 字段重复。
- `premise_kind=passage`：逐字 `anchor_quote`；`absence`：“没报告 X” + `search_terms`；`conflict`：两条逐字引文。
- `severity_claim` 是你自己的档位；biod 只读不改。`owner_suggested` 可选，只做对照。

每条问题必须包含：

- 位置（页码/行号/图/表/章节）。
- 问题是什么（事实/逻辑/统计/报告）。
- 为什么是问题（影响结论/可复现性/读者理解）。
- 可验证的修改或补充（不是“请改进”）。
- 严重程度。

## 四、工作流

### 1. 机械检查（先做，成本低）

- 文件/图/表/补充材料是否齐全、可打开。
- 正文引用的图/表是否存在，编号是否连续。
- 样本量在摘要、方法、结果、图注中是否一致。
- 百分比/总数是否对得上；亚组之和是否等于总数。
- 统计量（n、df、p、CI、效应量）是否自洽。
- 参考文献是否可解析（DOI/PMID），正文引用与列表是否一一对应。
- 报告指南清单是否齐全。
- 数据/代码/伦理/COI/资助/作者贡献是否声明。

机械错误不一定是阻断问题，但会降低可信度；成批出现时要指出系统性质量问题。

### 2. 重建主张-证据链

把稿件的主张列成表：

| claim | 证据（图/表/统计/引用） | 支持程度 | 问题 |
| --- | --- | --- | --- |

重点找：

- 结论比证据强（相关写成因果、体外写成体内、小鼠写成人类）。
- 用亚组/事后分析支撑主要结论。
- 只报显著结果，不报预设终点/阴性结果。
- 讨论引入正文没有的结果。
- 引用不支持对应主张（标题相关 ≠ 支持）。
- “首次”“唯一”“首次发现”没有检索依据。

### 3. 方法学审查

按问题类型检查：

- **设计**：设计能否回答主张？对照是否合适？随机化/盲法/区组是否充分？
- **样本**：样本量/功效依据？纳入/排除是否预设？是否有选择偏倚？
- **测量**：抗体/探针/测序/分割/标注的特异性与可靠性？是否盲法测量？
- **混杂**：已知混杂是否测量/调整？未测量混杂的方向？
- **批次**：批次与处理是否解耦？归一化是否引入伪影？
- **模型**：假设是否检验？过拟合/数据泄漏？训练/验证/测试是否独立？
- **外推**：物种、剂量、人群、时间窗是否支持结论范围？

### 4. 统计审查

- 主要终点是否唯一/预先声明？多重比较是否校正？
- 效应量与置信区间是否报告？还是只有 p 值？
- 检验假设是否满足？非参数/稳健方法是否考虑？
- 伪重复：n 是生物学重复还是技术重复？
- 缺失数据：比例、机制、处理方法、敏感性分析。
- 亚组/交互：是否预设？是否多重比较？
- 生存分析：删失、竞争风险、比例风险假设。
- 贝叶斯：先验、收敛、敏感性。
- 机器学习：划分、交叉验证、泄漏、指标选择、基线比较、校准。
- 统计不显著 ≠ 无效应；置信区间是否排除有意义的效应？

### 5. 可复现性审查

- 数据是否可获取？accession/申请方式/许可。
- 代码是否可获取？版本、依赖、随机种子、运行命令。
- 方法参数是否足够复现（软件版本、参考基因组、阈值）。
- 图表是否由脚本生成，能否从原始数据重建。
- 是否有“手工调整”而未说明。
- 如果数据/代码不可得，作者是否给了合理理由和替代方案。

低成本 spot check：如果项目里有脚本和数据，抽一个主图/主表重跑；不要为了审查跑全新实验。

### 6. 新颖性与先行工作

用 `lit-review` 的 bounded 检索：

- 最接近的 3–5 篇工作是什么？
- 稿件的主张相对它们的新增量是什么（新问题/新机制/新数据/新方法/新应用）？
- 是否遗漏了明显先行工作？
- 是否把已知结论包装成新发现？
- 预印本/会议版本是否已存在？

新颖性不足不一定是阻断问题；但如果作者声称“首次”而检索到先行工作，是阻断问题。

### 7. 分级与写法

- **Blocking**：不解决则结论不可信/不可发表。例：主要终点改变、n 不足、统计错误、关键对照缺失、数据泄漏、伦理问题。
- **Important**：影响解释/可复现性，但可通过修改/补充分析解决。例：缺少效应量、混杂未讨论、图注不完整。
- **Suggestion**：提升清晰度/完整性，不影响核心结论。

写法：

- 一条意见只讲一个问题。
- 先陈述事实，再讲影响，再给可执行修改。
- 引用具体位置；不要写“全文统计有问题”。
- 对不确定的地方写“如果…则需要…”，不要假装确定。
- 不人身攻击、不猜测动机、不要求与主张无关的实验。
- 不替作者改稿；可以给示例措辞，但不重写全文。

### 8. 推荐决定

内部推荐用四档：

- Accept / Minor revision / Major revision / Reject。

给出理由，但明确这是内部建议，不是编辑决定。若证据不足以判断，写“需要补充 X 后才能判断”，不要硬给档次。

### 9. issue 分诊核查（V1，写完 issue 后）

issue 列表定稿后：

1. 落 `review/issues.csv`（schema 见第三节）。
2. 调用 `toollibrary action="issue-audit"`。
3. 先处理 P0（前提被正文反驳：引文/定位/表述有错），再看 P1（前提无法核实、归属不清、无可核查前提）。
4. P0/P1/P2 是**核对顺序**，不是 issue 档位；`premises_hold` 不等于 issue 成立。
5. 报告不改 `issues.csv`、不改 review、不派单；`owner` 只是建议，`owner_undecided` 交 PI。

## 五、质量检查表

- [ ] 每条阻断问题都有位置、证据、影响和可验证修改。
- [ ] 机械检查覆盖图/表/数字/引用/声明。
- [ ] 主张-证据链完整，过度解释被抓出。
- [ ] 方法/统计审查针对主张，不是泛泛清单。
- [ ] 可复现性判断有依据，没有把“看不到”当成“没有”。
- [ ] 新颖性判断有检索证据。
- [ ] 没有要求与主张无关的实验。
- [ ] 语气直接但不攻击；没有替作者改稿。
- [ ] issue 已结构化到 `review/issues.csv`，引文逐字、absence 用 `search_terms`。
- [ ] 跑过 `issue-audit`；P0/P1 已核对，冲突处标注了原文依据。

## 六、常见反模式

| 反模式 | 问题 | 修正 |
| --- | --- | --- |
| 泛泛而谈 | “统计不充分”“需更多实验” | 指到具体图/表/检验，给可验证修改 |
| 把不确定当确定 | 没看到代码就说不可复现 | 写“缺少 X，无法判断” |
| 要求无限补实验 | 审稿变成勒索 | 只要求能改变结论的关键实验 |
| 替作者重写 | 越界且不可执行 | 给修改方向，不写全文 |
| 忽略阴性/矛盾结果 | 审查不完整 | 专门检查预设终点和阴性结果 |
| 被新颖性带偏 | 忽略方法/统计问题 | 先证据链，再新颖性 |
| 泄露稿件 | 违反保密 | 不上传未发表内容到外部服务 |

## 七、与团队的分工

- 你只审查，不改稿、不跑新实验。
- 需要补数据/补分析 → 让 PI 派给 Researcher；你写清“补什么、为什么、怎样算解决”。
- 需要改稿/回复审稿 → 交给 Writer；你的意见要能直接转成修改清单。
- 需要文献/先行工作 → 用 `lit-review` 或找 Searcher；不要凭记忆判断“没人做过”。
