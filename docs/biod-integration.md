# biod 决策接入（toollibrary / knowledgebase / context）

> 本文记录 Bioflow 的五个运行时决策点与 sidecar 接口。
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

## 十、验证记录（2026-11-01，the host）

- **真模型 sidecar**：`biod-v0-final` 冷启动 35s（含 10s warmup）→ `/v1/health` ready，GPU 9.3GB；tool 决策 424–476ms、kb 决策 231–293ms、score-groups（3 组）47ms、（20 组）111ms。
- **真实会话**：`toollibrary action=select` 返回 `scanpy`（53 候选、confidence 0.985、474ms）并加载 SKILL.md；`knowledgebase action=select` 返回 `General Science/multiple-testing-and-false-discovery-rate` 等条目正文。
- **失败演练**：`kill -9` sidecar → 下一次 `toollibrary` 返回 `action:"catalog"` + `biod:{status:"deferred",reason:"not_ready"}`；supervisor 在 1s 后自动重启（attempt 1/3），约 35s 后 health 恢复 ready。
- **测试**：远端 `npm run test` 436 项，430 pass / 1 fail / 5 skipped；唯一失败是接入前就存在的 `workspace_prompt_contract.test.ts`（`prompts/main.md` 不含测试期望的“初始为空”），与本变更无关。`npm run build` 通过。
- **阈值实测**：40 条真实用户消息，kb `tau=0.1078` 下 26/40 至少选中 1 条；tool 在 40 条普通对话上 NO_TOOL 概率 0.63–0.99（正确弃权），在工具型请求上 argmax 置信度通常 >0.9。

## 十一、v1 多任务接入（2026-11-02）

> 状态：**已接入并验证**。代码：`Biod/biod/multitask/**`（模型/sidecar）、`bioflow-dev` 的 `biod.json`/`role_router.ts`。

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

### 11.4 Sidecar 冒烟（2026-11-02，the host）

- 9B 加载/预热后：tool(100 候选) p50 781ms、kb(38) 291ms、context(6 组) 99ms、role 84ms、relay 76ms。
- 真实请求：tool → `scanpy` (0.9996)；kb → FDR + PyDESeq2；role → `searcher` (0.929)；relay → `allow` (0.842)；context → keep/keep/drop（映射 1/1/0）。
- 后端（`/api/health`）正常；sidecar `biod-mt-v1` ready；554 项后端测试 549 pass / 0 fail / 5 skip。
