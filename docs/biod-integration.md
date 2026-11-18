# biod 决策接入（toollibrary / knowledgebase / context）

> 状态：v1 已接入（2026-11-01）；Searcher S2 hypothesis-screen 已接入（2026-11-02）。单一事实来源；改行为先改本文与对应机制文档。
> 2026-11-07：shipped 配置把 `decisionPoints.tool_select.mode` 设为 `off`，五个角色的 `coreToolIds` 不再绑定 `toollibrary`；工具选择退回模型自行浏览（llm 模式）。biod 仍负责 `kb_select`、`context_retention` 与 framework 决策点，回滚只需把这两处改回 `select` + 绑定。
> 代码：`agent-client/backend/src/agent/biod/`（Node 决策层）、`Biod/biod/serve.py`（Python sidecar）。

## 一、结论速览

1. biod 以**常驻 HTTP sidecar** 形态运行，加载 `biod-v0-final`（Qwen3.5-4B-Base + LoRA + 双 pointer head）；backend 启动时自动拉起（`autoStart`），默认启用。
2. 三个决策点都**替模型做选择**，失败一律 fail-open：
   - `toollibrary` 默认 `action="select"`：biod 在运行时可见能力里选一个，**同一调用内完成 toolload**，工具结果只含选中的能力。
   - `knowledgebase action="select"`：biod 在 38 条知识里按 τ 多选，**只返回被选中条目的正文**。
   - 冷区压缩：biod 批量给 group 打相关性分，替换规则先验 `baselineScore`；配额/证据行/阈值全部不变。
   - **选择权按角色绑定**：两个能力族（`toollibrary` / `knowledgebase`）**始终注入角色上下文**，角色在 `coreToolIds` 里绑定它才把选择交给 biod；未绑定即退化为模型自行浏览选择（`biod.status="off"`、`biod.reason="not_configured"`），与 biod 失效走同一条浏览回落路径。
3. 任何失败（禁用、未就绪、超时、网络、坏响应、CKPT/版本不匹配、低置信、NO_TOOL）都回落到原来的浏览/索引行为，并在结果里追加 `biod` 元数据；主流程无感。
4. 模型词表是冻结的：工具 ckpt 仍是 61 槽 + NO_TOOL，而当前 catalog 有 114 条能力（100 条可见；`tavily`/`exa` 的 8 条 internal MCP 被 dispatcher 隐藏）；知识 ckpt 仍是 32 条（`66383258b2d773c7`），当前知识库已有 38 条。**新增工具/知识条目无法被 v0 打分**：`BiodService` 启动时读取 `/v1/version` 的 `optionIds`，把不在词表里的候选过滤掉；全部被过滤时该次决策 fail-open 回落到浏览路径（不会因为一个新工具让所有 select 都失败）。
5. sidecar 单 GPU、单请求串行；冷启动约 34s（含 10s warmup）、显存约 9GB；tool p50 ≈ 0.4s、kb p50 ≈ 0.24s、冷区批量 ≈ 0.3s。
6. **state 截断**：ckpt 训练分布 p99=212 字符、max=219；tool prompt 的 61 个 option 已占 ~3620/4096 token，所以 Node 侧 `state.maxChars=220`，sidecar 再按 kind 兜底截断（tool 240 / kb 600 / score-groups 400）。超长用户消息只取前 220 字符，这是训练分布约束，不是 bug。

## 二、拓扑

```
AgentRuntime
  ├─ toollibrary(action=select) ──┐
  ├─ knowledgebase(action=select) ┼─► BiodService ──HTTP──► biod.serve :8790 ──► BiodPredictor (CUDA)
  └─ context compaction ──────────┘        │
                                           └─ .runtime/biod-decisions.jsonl（append-only 观测）

BiodSupervisor（backend 进程内）: spawn / health poll / 崩溃退避重启 / stop
```

- 进程边界：Node 不 import Python；只走 `127.0.0.1:8790` 回环 HTTP。
- `BiodService` 永不向调用方抛错；失败以 `{ok:false, reason}` 返回。
- backend 退出（SIGINT/SIGTERM）时只停止自己 spawn 的 sidecar；若启动时发现已有健康 sidecar 则“收养”并保留。

## 三、Sidecar API（`Biod/biod/serve.py`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | `status=loading/ready/degraded`、modelVersion、device、optionCounts、queueDepth |
| GET | `/v1/version` | ckptOptionIdsHash、catalogHash、61/32 个 option id |
| POST | `/v1/decide` | `{requestId, kind:"tool"|"kb", state, candidates?, policy:{tau,topK,noToolMargin}}` |
| POST | `/v1/score-groups` | `{requestId, state, groups:[{id,name,description}]}`，≤32 组，返回每组 sigmoid 分 |

- tool：对 ckpt 全量 61+NO_TOOL 打分 → 按 `candidates` 过滤 → visible+NO_TOOL 重归一 → `chosen` 取 argmax（NO_TOOL 需领先 `noToolMargin`）。
- kb：ckpt 的 32 条 sigmoid → 按 `candidates` 过滤 → `chosen` = `p ≥ tau` 的 topK（可为空集）。
- `score-groups` 复用 kb pointer head 对任意 option 列表打分：这是**排序信号**，不是知识阈值判定（OOD，见 §七）。
- 请求 `candidates` 必须 ⊆ ckpt option id；否则 400 `CKPT_MISMATCH`。Node 侧会先按 `/v1/version` 的 `optionIds` 过滤候选。`requestId` 60s 幂等缓存。
- state 上限：Node `state.maxChars=220`（训练分布 p99=212 / max=219）；sidecar 再按 kind 兜底（tool 240 / kb 600 / score-groups 400）。超长用户消息只取前 220 字符，避免 tool prompt 超过 ckpt 的 4096 token（61 个 option 本身已占 ~3620）。
- 离线环境：sidecar 启动时强制 `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1`，`HF_HOME` 默认 `<repo>/.hf_cache`。

## 四、配置与环境

`agent-client/backend/config/biod.json`：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "service": { "baseUrl": "http://127.0.0.1:8790", "autoStart": true, "startupTimeoutMs": 180000, "requestTimeoutMs": 2000, "contextTimeoutMs": 3000 },
  "runtime": { "python": "${BIOFLOW_BIOD_PYTHON}", "repoRoot": "${BIOFLOW_BIOD_REPO}", "ckptDir": "${BIOFLOW_BIOD_CKPT}", "device": "cuda", "dtype": "bfloat16" },
  "model": { "expectedVersion": "biod-v0-final" },
  "decisionPoints": {
    "tool_select": { "mode": "select", "tau": 0.1, "noToolMargin": 0.1 },
    "kb_select": { "mode": "select", "tau": 0.1078, "topK": 3 },
    "context_retention": { "mode": "select", "maxGroups": 32 }
  },
  "state": { "maxChars": 2000 }
}
```

- 机器相关路径只写在未提交的 `backend/.env`（见 `docs/development.md`）；配置 JSON 里用 `${...}` 引用。缺任一变量时 `autoStart` 自动关闭，但仍可连已运行的外部 sidecar。
- `mode` 只有 `off|select`；任一决策点设 `off` 即回到接入前行为。
- 未知字段会在加载时产生 warning（不静默忽略），不会中断启动。
- 测试环境通过 `BIOFLOW_BIOD_DISABLED=1` 强制关闭（`test/setup-test-workspace.mjs`）。

### 4.1 `framework` 决策块（可选）

`biod.json.framework` 与上面的 `decisionPoints`（tool/kb/context）是两套独立机制：`decisionPoints` 是旧 R1 的运行时选择，`framework` 是方案/筛选决策框架。Searcher S2 由 `framework.decisionPoints` 控制（见 §4.4；shipped 配置为 `assist`）；shipped 配置对 Researcher 开 `r1.plan-audit=assist`，对 Writer 开 `w1.claim-evidence-audit=assist`，对 Reviewer 开 `v1.issue-triage=assist`。

```json
{
  "framework": {
    "enabled": true,
    "defaultMode": "off",
    "decisionPoints": {
      "s2.premise": { "mode": "off", "scorer": "heuristic", "budget": "short" }
    },
    "researcher": {
      "enabled": true,
      "thresholds": {
        "tauBetter": 0.55,
        "tauMissing": 0.55,
        "margin": 0.08,
        "minConfidence": 0.5,
        "topK": 3
      },
      "prefilter": { "mode": "lexical", "maxCandidates": 16 },
      "decisionPoints": {
        "r1.plan-audit": { "mode": "assist", "scorer": "heuristic", "budget": "audit" }
      }
    }
  }
}
```

- `r1.plan-audit` 只对 Researcher 开放；Researcher 在方案定稿后调用 `toollibrary action="plan-audit" path="planning/experiment-design-<slug>.md"`。
- 它只解析 design doc 里的 `plan-steps` YAML 块，和角色绑定集比较；只返回报告，**不修改方案、不加载工具、不 gate**。
- `mode` 只支持 `off|shadow|assist`：`shadow` 只写 `biod-plan-audit.jsonl`；`assist` 额外写 `planning/plan-audit-<slug>.md`。
- `scorer` 支持 `heuristic|mock|biod-tool|http`；`biod-tool` 复用 v0 tool head，只建议 shadow；当前没有 trained plan-audit head。
- `budget=audit` 对齐 v0 `max_len=4096`（4096 total / 512 state / 24 candidates）；`audit-max` 是后续 32k 训练的占位。
- 任一条件缺失（framework 关闭、researcher 关闭、DP off、无 `plan-steps`）都 fail-open，不阻塞 Researcher 执行。

### 4.2 Writer W1：初稿后 claim-evidence audit

`biod.json.framework.writer` 控制 Writer 的 `w1.claim-evidence-audit`。它只审初稿的论点论据，不写作前检索、不做章节放行、不改稿。

```json
{
  "writer": {
    "enabled": true,
    "thresholds": {
      "minConfidence": 0.55,
      "tauMismatch": 0.65,
      "tauPartial": 0.5,
      "overclaimConfidence": 0.6,
      "topIssues": 10
    },
    "precheck": { "online": false, "maxQuoteChars": 800 },
    "decisionPoints": {
      "w1.claim-evidence-audit": { "mode": "assist", "scorer": "heuristic", "budget": "claim-audit" }
    }
  }
}
```

- 只有 Writer 能调用：`toollibrary action="manuscript-audit" path="manuscript/manuscript.md"`；`matrixPath` 默认 `manuscript/claim-evidence.csv`，`referencesPath` 默认 `manuscript/references.bib`。
- 输入是 Writer 维护的 edge CSV（一行一条 claim-evidence），正文为权威、matrix 为索引；`claim_text` 在正文找不到时标 `stale_claim`。
- 先跑确定性 precheck：citation key/DOI/PMID、locator、quote、inline citation、orphan bib entry、figure/table 引用；online 默认关闭，避免把未发表稿件发给外部服务。
- 再逐 edge 打分并聚合到 claim：`no_issue_found / check_support / support_mismatch / overclaim / missing_evidence / needs_data / unverifiable / stale_claim`，输出 P0/P1/P2。
- `assist` 写 `manuscript/audit-<slug>.md`；`shadow` 只写 `biod-manuscript-audit.jsonl`。报告是风险清单，不是审稿结论；`no_issue_found` 不等于 claim 已被证明。
- `budget=claim-audit` 是 4096 total / 2048 state；`claim-audit-max` 是后续 32k 训练占位，按 edge 打分，不把整篇论文塞进 state。
- 任一条件缺失（framework/writer 关闭、DP off、matrix/正文缺失）都 fail-open，不阻塞 Writer 写作或交付。

### 4.3 Reviewer V1：issue 前提/归属/排序核查

`biod.json.framework.reviewer` 控制 Reviewer 的 `v1.issue-triage`。它只核对 Reviewer **已经写出来**的 issue，不生成 issue、不判严重度档位、不改 review、不 gate。

```json
{
  "reviewer": {
    "enabled": true,
    "thresholds": {
      "minConfidence": 0.55,
      "tauContradicted": 0.65,
      "tauHolds": 0.55,
      "ownerMargin": 0.15,
      "pairMargin": 0.05,
      "duplicateThreshold": 0.7,
      "maxPairwiseIssues": 8,
      "maxScoredIssues": 64,
      "topIssues": 10
    },
    "decisionPoints": {
      "v1.issue-triage": { "mode": "assist", "scorer": "heuristic", "budget": "issue-audit" }
    }
  }
}
```

- 只有 Reviewer 能调用：`toollibrary action="issue-audit" path="manuscript/manuscript.md"`；`issuesPath` 默认 `review/issues.csv`。
- 输入是 Reviewer 维护的 `review/issues.csv`（一行一条 issue-premise），正文为权威；premise 支持的三种形态：
  - `passage`：给逐字 `anchor_quote`，代码在正文定位，只把**代码抽出的 passage**交给 scorer；
  - `absence`：给 `search_terms`，“论文没报告 X”由代码做确定性检索（命中 → 前提与正文冲突；未命中 → 前提成立但标 `absence_check_limited`）；
  - `conflict`：给两条逐字引文，判断“两段冲突”这个前提是否成立。
- 逐 premise 输出 `holds / contradicted / unresolved`（`contradicted` 需 `tauContradicted`，否则降为 `unresolved`）；逐 issue 输出 5 角色归属（`searcher/researcher/writer/reviewer/pi`，margin 不足标 `owner_undecided` 并建议 PI 派发）；blocking 候选内做 pairwise 相对排序（默认 ≤8 条 → ≤28 对）。
- 输出 **check priority P0/P1/P2**，不是 issue 严重度：报告固定写“P0/P1/P2 are check priorities, not issue severities”。`severity_claim` 只作为输入，biod 不改它。
- `assist` 写 `review/issue-audit-<slug>.md`；`shadow` 只写 `biod-issue-audit.jsonl`。工具从不写 `issues.csv`，也不派单。
- `budget=issue-audit` 是 4096 total / 2048 state；`issue-audit-max` 是后续 32k 训练占位，按 premise 打分，不把整篇论文塞进 state。
- 未见前提、引文找不到、issue 重复、section 不存在都由确定性 precheck 标出；超预算的 issue 标 `deferred` 并在报告单列，不静默丢弃。
- 任一条件缺失（framework/reviewer 关闭、DP off、issues.csv/正文缺失）都 fail-open，不阻塞 Reviewer 的审查交付。

### 4.4 Searcher S2：假设筛选（hypothesis-screen）

`biod.json.framework.decisionPoints` 的 `s2.premise / s2.rerank / s2.policy` 控制 Searcher 的 S2 筛选。它只筛 Searcher **已经写出来**的结构化假设，不生成假设、不改假设、不 gate；输入是 `research/hypotheses.yaml`。

- 只有 Searcher 能调用：`toollibrary action="hypothesis-screen" path="research/hypotheses.yaml"`。
- 输入契约：YAML 顶层 `hypotheses`（每卡具备 `id / gapIds / claim / predictions / evidenceLinks / alternatives`），可选 `rq / reviewSummary / gaps / evidence`；`evidence[].id` 必须被 `evidenceLinks[].eid` 引用。自由文本 `hypotheses.md` 不被接受。
- 流程：`s2.premise`（每 premise × 最多 2 条证据链接 → `supported/contradicted/unknown`）→ `s2.rerank`（K 张卡相对分）→ `s2.policy`（融合、top-5 短名单、contradicted 延期、exploration 抽样）。`s3.trigger` / `s5.diversity` 默认 `off`，可单独开启。
- 打分默认 heuristic（`createSearcherFramework` 的 `HeuristicScorer`）；配置里的 `scorer` 字段对 s2.* 不生效，`http` 适配器等待 `/v1/score-pairs`。**当前没有 trained S2 head。**
- `mode`：`off|shadow|assist`。S2 三个核心 DP 作为一个单元：任一 `assist` → 整体 assist；否则任一 `shadow` → shadow。
- `assist` 写 `research/hypothesis-screen-<slug>.md`；`shadow` 只写 `biod-hypothesis-screen.jsonl` 与 framework ledger，不写报告、工具只返回计数。
- 报告是建议：`shortlist/ranked` 只影响深审顺序；`deferred` 不是删除；`unknown` 仍有资格；biod 不判 novelty / impact / 最终价值。
- 缺 YAML / 解析失败 → `missing_hypotheses` / `invalid_hypotheses`（带 issues）；任一条件缺失都 fail-open，不阻塞 Searcher。

## 五、工具选择（toollibrary）

调用：

```json
{"action":"select"}                 // 默认；从全部可见能力里选
{"action":"select","domain":"…"}    // 限定领域
{"action":"catalog","domain":"…"}   // 显式浏览，不调用 biod
{"action":"index"}                  // 运行时领域索引，不调用 biod
```

成功返回（只含选中项，且已加载）：

```json
{
  "ok": true,
  "action": "select",
  "selected": {"id":"scanpy","name":"scanpy","kind":"skill","description":"…","domain":"Omics and Single-Cell Analysis"},
  "load": {"ok":true,"action":"skill","skillId":"…","skillName":"…","content":"…"},
  "decision": {"decisionId":"…","confidence":0.95,"latencyMs":420,"modelVersion":"biod-v0-final","candidateCount":53}
}
```

- 选中 MCP 时 `load` 为 `{ok,action:"mcp_tool",id,loaded,alreadyLoaded}`，schema 已登记到下一轮 `tools`。
- `confidence < tau`（默认 0.1，仅作噪声下限）→ 不加载，回落 browse，`biod.reason="low_confidence"`。NO_TOOL 的判定在 sidecar 内完成（`noToolMargin`）。
- `chosen=["NO_TOOL"]` → 回落 browse，`biod.reason="no_tool"`。
- sidecar 不可用 → 回落 browse，`biod.reason` 为 `timeout|network|not_ready|…`。
- **角色未绑定 `toollibrary`** → 不调用 biod，`select` 直接回落 browse，`biod={status:"off",reason:"not_configured"}`；角色仍可用 `catalog` / `index` + `toolload` 自行选择。
- 回落结果保留原 `action:"index"|"catalog"` 与 `domains/entries`，只追加 `biod` 字段，模型仍可自行选择。

### 5.1 方案审计（Researcher only）

```json
{"action":"plan-audit","path":"planning/experiment-design-demo.md"}
```

成功返回（assist 模式）：

```json
{
  "ok": true,
  "action": "plan-audit",
  "reportPath": "planning/plan-audit-demo.md",
  "designPath": "planning/experiment-design-demo.md",
  "summary": {"total":4,"better_tool":1,"missing_tool":1,"keep_current":1,"no_tool":1,"uncertain":0,"fallback":0},
  "opportunities": [{"stepId":"S3","type":"missing_tool","current":null,"recommended":"pydeseq2","confidence":0.73,"reason":"tool_covers_step"}],
  "biod": {"mode":"assist","modelVersion":"heuristic-r1-v1","policyVersion":"r1-plan-audit-policy-v1","latencyMs":42}
}
```

- 只读 design doc；报告写到 `planning/plan-audit-<slug>.md`；不改 design/SAP、不加载工具。
- `shadow` 模式不写报告，只写 `biod-plan-audit.jsonl`。
- 缺 `plan-steps` 块 → `{ok:false,reason:"missing_plan_steps"}`；非 Researcher 调用 → `not_authorized`。

### 5.2 初稿论点论据核查（Writer only）

```json
{"action":"manuscript-audit","path":"manuscript/manuscript.md"}
```

成功返回（assist 模式）：

```json
{
  "ok": true,
  "action": "manuscript-audit",
  "reportPath": "manuscript/audit-manuscript.md",
  "manuscriptPath": "manuscript/manuscript.md",
  "matrixPath": "manuscript/claim-evidence.csv",
  "summary": {"totalClaims":42,"totalEdges":78,"p0":2,"p1":7,"p2":5,"no_issue_found":20,"check_support":6,"support_mismatch":1,"overclaim":3,"missing_evidence":2,"needs_data":0,"unverifiable":1,"stale_claim":1,"fallback":0},
  "topIssues": [{"claimId":"C003","section":"discussion","finding":"overclaim","priority":"P0","evidenceId":"E012","reason":"causal claim; evidence is association in mice"}],
  "biod": {"mode":"assist","modelVersion":"heuristic-w1-v1","policyVersion":"w1-claim-evidence-audit-v1","latencyMs":180}
}
```

- 只读 `manuscript.md`、`claim-evidence.csv`、可选 `references.bib`；报告写到 `manuscript/audit-<slug>.md`；不改稿、不改 CSV、不加载工具。
- `shadow` 模式不写报告，只写 `biod-manuscript-audit.jsonl`。
- 缺 matrix / 正文 → `missing_claim_matrix` / `missing_manuscript`；非 Writer 调用 → `not_authorized`；v1 只接受 Markdown 初稿。

### 5.3 issue 分诊核查（Reviewer only）

```json
{"action":"issue-audit","path":"manuscript/manuscript.md","issuesPath":"review/issues.csv"}
```

成功返回（assist 模式）：

```json
{
  "ok": true,
  "action": "issue-audit",
  "reportPath": "review/issue-audit-manuscript.md",
  "documentPath": "manuscript/manuscript.md",
  "issuesPath": "review/issues.csv",
  "summary": {"totalIssues":12,"totalPremises":25,"p0":1,"p1":3,"p2":4,"premisesHold":14,"premiseContradicted":1,"premiseUnresolved":6,"noPremise":1,"anchorsMissing":1,"locatorMissing":0,"sectionsMissing":0,"absenceChecks":2,"absenceHits":1,"duplicates":1,"ownerUndecided":2,"ownerDisagreements":1,"deferred":0,"fallback":0},
  "queue": [{"issueId":"I003","priority":"P0","premiseStatus":"premise_contradicted","owner":"pi","rank":1,"why":"the document contradicts 1 premise(s): P1"}],
  "ownerTally": {"searcher":1,"researcher":4,"writer":5,"reviewer":1,"pi":1},
  "biod": {"mode":"assist","modelVersion":"heuristic-v1-v1","policyVersion":"v1-issue-triage-v1","latencyMs":140}
}
```

- 只读正文与 `review/issues.csv`；报告写到 `review/issue-audit-<slug>.md`；不改 review、不改 CSV、不生成 issue、不派单。
- `shadow` 模式不写报告，只写 `biod-issue-audit.jsonl`。
- 缺 CSV / 正文 → `missing_issues` / `missing_manuscript`；非 Reviewer 调用 → `not_authorized`；v1 只接受 Markdown 正文。
- 报告里的 `P0/P1/P2` 是**核对顺序**；`Blocking/Important/Suggestion` 仍由 Reviewer 自己给，biod 只读不改。

### 5.4 假设筛选（Searcher only）

```json
{"action":"hypothesis-screen","path":"research/hypotheses.yaml"}
```

成功返回（assist 模式）：

```json
{
  "ok": true,
  "action": "hypothesis-screen",
  "reportPath": "research/hypothesis-screen-hypotheses.md",
  "hypothesesPath": "research/hypotheses.yaml",
  "summary": {
    "cards": 6,
    "premises": 14,
    "evidence": 9,
    "verdicts": {"supported": 8, "contradicted": 1, "unknown": 5},
    "shortlist": ["H2", "H5", "H1"],
    "ranked": ["H2", "H5", "H1", "H3", "H4", "H6"],
    "deferred": [{"id": "H3", "reason": "premise_conflict:p2"}],
    "exploration": ["H4"],
    "deepReview": ["H2", "H5"],
    "diversityFlags": [],
    "fallback": false
  },
  "biod": {
    "decisionPoint": "s2.hypothesis-screen",
    "mode": "assist",
    "modelVersion": "heuristic-v1",
    "policyVersion": "s2.policy-v1",
    "rendererVersion": "searcher-screen-v1",
    "latencyMs": 12
  }
}
```

- 只读 `research/hypotheses.yaml`；报告写到 `research/hypothesis-screen-<slug>.md`；不改 YAML、不生成假设、不加载工具。
- `shadow` 模式返回 `shadow:true` 与计数，不写报告；`off` 返回 `{ok:false, reason:"disabled"}`。
- 缺文件 / YAML 格式错 → `missing_hypotheses` / `invalid_hypotheses`（带 issues）；非 Searcher 调用 → `not_authorized`。
- `shortlist` / `ranked` / `deferred` 只是深审排序建议；报告固定写“不是 gate，最终取舍由 Searcher / PI”。

## 六、知识选择（knowledgebase）

调用 `{"action":"select"}`（可选 `domain`；`action` 可省略，缺省即 `select`）。成功返回：

```json
{
  "ok": true,
  "action": "select",
  "domain": null,
  "entries": [{"id":"Bioinformatics/anndata","name":"anndata","description":"…","content":"…","resources":[]}],
  "decision": {"decisionId":"…","confidence":0.88,"latencyMs":240,"modelVersion":"biod-v0-final","candidateCount":32},
  "warnings": []
}
```

- 只返回被选中的条目正文；总正文受 30,000 字符预算约束，超出的条目截断并带 `truncated` warning。
- 空集/失败 → 回落 `index`（有 `domain` 时回落 `catalog`），追加 `biod` 元数据。
- **角色未绑定 `knowledgebase`** → 不调用 biod，`select` 直接回落 `index`/`catalog`，`biod={status:"off",reason:"not_configured"}`；角色仍可自行 `index` → `catalog` → `read`。
- `index` / `catalog` / `read` 行为不变；prompt 按选择权渲染：委托 biod 时引导优先 `select`，未委托时引导自行浏览。

## 七、context：冷区打分器

- 位置：`context_manager.ts` 的两处压缩（run 内 `compactRuntimeMessages`、run 后 `compactAfterRun`）。
- 流程：`buildBiodColdZoneScorer(groups, taskText)` → 过滤 user prompt → 渲染 `{id:seq, name:kind:tool, description:摘要≤400}` → 一次 `/v1/score-groups` → `planColdZone({scorer})`。
- 只替换 `ColdZoneGroup.score` 这一项；`dropThreshold/quota/evidenceLines/archive` 全部不动。未被评分的组回落 `baselineScore`。
- 失败/空任务文本/禁用 → 返回 `null`，调用方完全不传 `scorer`，等价于接入前行为。
- **局限**：kb head 从未在“对话 group”上训练过，这是零训练复用；分数只用于排序，不参与 τ 准入门。上线门槛（后悔率、NDCG、摘要 token）需离线 replay 验证。

## 八、失败语义

| 条件 | 主流程 | 结果 |
| --- | --- | --- |
| `enabled=false` / `BIOFLOW_BIOD_DISABLED=1` | 正常 | 原 browse/index/catalog 响应（无 biod 调用） |
| 角色未绑定该能力族 CoreTool | 正常 | 不调用 biod，直接 browse/index/catalog + `biod={status:"off",reason:"not_configured"}` |
| sidecar 未就绪/超时/网络/坏响应 | 正常 | 回落 browse/index/catalog + `biod.status="deferred"` |
| 版本或候选不匹配 | 正常 | 同上，`biod.reason="catalog_mismatch"|"model_mismatch"` |
| 低置信 / NO_TOOL / 空集 | 正常 | 同上，`biod.reason="low_confidence"|"no_tool"|"no_selection"` |
| 熔断打开 | 正常 | 同上，`biod.reason="circuit_open"` |
| 决策成功 | 用选中项 | 只返回选中工具/知识（+decision 元数据） |

不变量：决策层失败**不得**抛错、不得改变既有字段语义、不得阻止会话继续。

## 九、运维

```bash
# 健康与版本（在本机）
curl -s http://127.0.0.1:8790/v1/health | jq .
curl -s http://127.0.0.1:8790/v1/version | jq '{modelVersion,optionIds}'

# 决策记录（append-only JSONL）
tail -n 20 agent-client/workspace/.runtime/biod-decisions.jsonl

# 后端日志（开发实例）
tail -f /tmp/bioflow-backend.log | grep biod
```

- 冷启动约 34s；`startupTimeoutMs=180000` 覆盖首次加载。
- 崩溃：1s/2s/4s 退避，最多 3 次/5min；超过后 `circuit_open`，下次 backend 重启再试。
- 回滚：`biod.json` 置 `enabled:false`（或删文件）→ 行为回到接入前；只关某一决策点：`decisionPoints.*.mode="off"`。
- 端口冲突：改 `service.baseUrl` 与 sidecar 的启动参数保持一致（supervisor 从 `baseUrl` 解析端口）。

## 十、验证记录（2026-11-01，deployment-host）

- **真模型 sidecar**：`biod-v0-final` 冷启动 35s（含 10s warmup）→ `/v1/health` ready，GPU 9.3GB；tool 决策 424–476ms、kb 决策 231–293ms、score-groups（3 组）47ms、（20 组）111ms。
- **真实会话**：`toollibrary action=select` 返回 `scanpy`（53 候选、confidence 0.985、474ms）并加载 SKILL.md；`knowledgebase action=select` 返回 `General Science/multiple-testing-and-false-discovery-rate` 等条目正文。
- **失败演练**：`kill -9` sidecar → 下一次 `toollibrary` 返回 `action:"catalog"` + `biod:{status:"deferred",reason:"not_ready"}`；supervisor 在 1s 后自动重启（attempt 1/3），约 35s 后 health 恢复 ready。
- **测试**：远端 `npm run test` 436 项，430 pass / 1 fail / 5 skipped；唯一失败是接入前就存在的 `workspace_prompt_contract.test.ts`（`prompts/main.md` 不含测试期望的“初始为空”），与本变更无关。`npm run build` 通过。
- **阈值实测**：40 条真实用户消息，kb `tau=0.1078` 下 26/40 至少选中 1 条；tool 在 40 条普通对话上 NO_TOOL 概率 0.63–0.99（正确弃权），在工具型请求上 argmax 置信度通常 >0.9。

## 十一、v1 多任务接入（2026-11-02）

> 状态：**已接入并验证**。代码：`Biod/biod/multitask/**`（模型/sidecar）、`bioagent-dev` 的 `biod.json`/`role_router.ts`。

### 11.1 形态

- 新 sidecar 入口：`python -m biod.multitask.serve`（配置 `biod.runtime.entry`）。
- checkpoint：`artifacts/runs/multitask-v3/best`（`Qwen3.5-9B-Base` + LoRA + 5 个 head）。
- `biod.model.expectedVersion = "biod-mt-v1"`；`/v1/health` 与 `/v1/version` 返回 `ok:true`。
- 旧的 `biod.serve`（v0 4B）保留可用；切回只需改 `runtime.entry`/`ckptDir`/`expectedVersion` 三个字段。

### 11.2 五个决策点

| 决策点 | Node 调用方 | Sidecar 端点 | 失败回落 |
|---|---|---|---|
| tool_select | `BiodService.decideTool` → `/v1/decide` | 9B pointer head | `toollibrary action=catalog` |
| kb_select | `BiodService.decideKnowledge` → `/v1/decide` | 9B pointwise head | `knowledgebase index/catalog` |
| context_retention | `buildBiodColdZoneScorer` → `/v1/score-groups` | 9B 3 类 head，映射 keep=1/summarise=0.5/drop=0 | 规则先验 |
| role_select | `team/role_router.ts` → `/v1/decide/role_select` | 9B 5 类 head | PI + `source:"fallback"` |
| relay_select | `team/relay_gate.ts` → `/v1/decide/relay_select` | 9B 3 类 head | `escalate` |

- **tool/kb**：Node 仍只传候选 id；sidecar 用 `artifacts/datasets/v2/catalog_snapshot.json` 还原 name/description，并在 `state` 里带 `[角色：X]` 前缀，与训练布局一致。
- **context**：v1 用「3 类标签 → 分数」的兼容层；`planColdZone` 的配额、证据行、摘要与归档逻辑不变。完整 disposition 直通是下一轮工作。
- **role**：`biodRouter` 先看 `requestedRoleId`/`mode=manual`，再请求 sidecar；`confidence < 0.6` 或 sidecar 失败 → `fallbackRoleId`（pi）。`BIOFLOW_BIOD_DISABLED=1` 强制回落。
- **relay**：门禁只拦角色发起的 relay；`confidence < 0.75` 或任何失败 → `escalate`；`allow` 直送，`reject` 回理由，`escalate` 变 PI 交付。

### 11.3 配置（`config/biod.json`）

```json
{
  "runtime": { "entry": "biod.multitask.serve", "python": "${BIOFLOW_BIOD_PYTHON}", "repoRoot": "${BIOFLOW_BIOD_REPO}", "ckptDir": "${BIOFLOW_BIOD_CKPT}" },
  "model": { "expectedVersion": "biod-mt-v1" },
  "decisionPoints": {
    "tool_select": { "mode": "select" },
    "kb_select": { "mode": "select" },
    "context_retention": { "mode": "select" },
    "role_select": { "mode": "select", "tau": 0.6 },
    "relay_select": { "mode": "select", "floor": 0.75 }
  }
}
```

`team.router.engine` 已切到 `"biod"`，`fallbackRoleId="pi"`；`PUT /api/config/manage/team` 可随时切回 `always-pi`。

### 11.4 Sidecar 冒烟（2026-11-02，deployment-host）

- 9B 加载/预热后：tool(100 候选) p50 781ms、kb(38) 291ms、context(6 组) 99ms、role 84ms、relay 76ms。
- 真实请求：tool → `scanpy` (0.9996)；kb → FDR + PyDESeq2；role → `searcher` (0.929)；relay → `allow` (0.842)；context → keep/keep/drop（映射 1/1/0）。
- 后端（`/api/health`）正常；sidecar `biod-mt-v1` ready；554 项后端测试 549 pass / 0 fail / 5 skip。

## 十二、Searcher S2 接入（2026-11-02）

- 新增 Searcher-only 工具 `toollibrary action="hypothesis-screen"`；输入 `research/hypotheses.yaml`，`assist` 写 `research/hypothesis-screen-<slug>.md`，`shadow` 只写 `biod-hypothesis-screen.jsonl` 与 framework ledger。
- 代码：`agent-client/backend/src/agent/biod/searcher/**`、`BiodService.runHypothesisScreen`、dispatcher 角色门；配置见 §4.4。
- 打分仍是 heuristic（未训练）；`/v1/score-pairs` 仍不存在，`s2.*` 的 `scorer` 配置字段不生效。
- 报告只改深审顺序，不生成/修改假设、不 gate；`deferred` 不是删除，`unknown` 仍有资格。
