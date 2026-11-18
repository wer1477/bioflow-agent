# biod2 paper1-4B 决策服务（bioflow agent sidecar）

把 Biod 的 **biod2 / paper1 4B 决策模型**（7 头 / 9 个运行时决策点）作为常驻 HTTP
sidecar 提供给 bioflow agent。服务只监听回环，任何失败都由 agent 侧 fail-open 回落到
原有的浏览 / 索引 / 规则行为。

- 权重：`paper1-4B-s20261104/best`（4B 三 seed 中 val 与 mixed 最高；见 `MANIFEST.json`）
- 服务实现：`Biod/biod/multitask/serve.py`（**不 fork、不复制**，本目录只做部署与验收）
- 端口：`127.0.0.1:8790`；版本串：`biod-mt-v2`；权重身份：`ckptSha256` + `MANIFEST.json`

## 目录

```
services/biod2-4b/
├── MANIFEST.json          # 权重指纹 / provenance / 指标 / 阈值 / 验收记录
├── parity-report.json     # 上线前服务端 vs 离线评测的 556 例回放结果
├── threshold-sweep.json   # tau/topK 敏感性表与结论
├── README.md
├── .env.example           # 三条 BIOFLOW_BIOD_* 模板（真实值写 backend/.env）
├── bin/{start,stop,health,smoke}.sh
├── tools/{parity.py,threshold_sweep.py}
├── weights/               # ~185MB，不入 git
└── logs/                  # 启动日志，不入 git
```

## 跨仓库依赖（重要）

本服务**不是自包含**的：它依赖 Biod 检出存在且路径稳定。

| 依赖 | 路径 | 用途 |
|---|---|---|
| 代码 | `/path/to/Biod/biod/multitask/` | serve / render / model / encode |
| 词表 | `/path/to/Biod/Datasets/v2/catalog_snapshot.json` | 108 tools / 38 kb（sha256 记录在 MANIFEST） |
| 底座 | `/path/to/Biod/Models/foundation-model/Qwen3.5-4B-Base` | 文本塔（`model_config.json` 里是相对路径，靠 cwd 解析） |
| 解释器 | `/path/to/Biod/.venv/bin/python` | torch 2.7.1+cu126 / transformers 5.20.2 / peft 0.21.2 |

`serve` 必须以 `BIOFLOW_BIOD_REPO` 为 cwd 启动，否则相对路径的 base model 与
catalog snapshot 都会找不到。supervisor 拉起时已经这样做。

## 启动

**日常（推荐）**：由 backend 托管。`agent-client/backend/.env` 里设好三条变量后，
backend 启动会自动 spawn，并在端口已有健康实例时 adopt 而不重复拉起。

```bash
# agent-client/backend/.env
BIOFLOW_BIOD_PYTHON=/path/to/Biod/.venv/bin/python
BIOFLOW_BIOD_REPO=/path/to/Biod
BIOFLOW_BIOD_CKPT=/path/to/bioflow/services/biod2-4b/weights
```

**手动（验收 / 调试）**：

```bash
cd /path/to/bioflow/services/biod2-4b
./bin/start.sh --background   # 日志进 logs/，pid 写 .pid
./bin/health.sh               # ok/status/ckptSha256/指纹比对
./bin/smoke.sh                # 7 个端点各一次
./bin/stop.sh
```

> 同一端口只允许一个实例。手动实例与 backend spawn 的实例互斥——backend 会 adopt
> 已运行的实例而不再 spawn。

## 端点（biod-mt-v2）

| 方法 | 路径 | 承载的决策点 |
|---|---|---|
| GET | `/v1/health` | 存活 + 权重指纹（`ok:true` 才算 ready） |
| GET | `/v1/version` | 版本（**不暴露词表**，`optionIds` 为空） |
| POST | `/v1/decide` `kind=tool` | `tool_select`（服务端应用 tau） |
| POST | `/v1/decide` `kind=kb` | `kb_select`（服务端应用 tau/topK） |
| POST | `/v1/decide/context_retention` | `context_retention` |
| POST | `/v1/decide/role_select` | `role_select`、`v1.issue-triage` 的角色判定 |
| POST | `/v1/decide/relay_select` | `relay_select` |
| POST | `/v1/score-pairs` | `s2.premise` / `r1.plan-audit` / `w1` / `v1`（premise_judge、overclaim_flag） |

契约细节以 `Biod/biod/multitask/serve.py` 与 `agent-client/backend/src/agent/biod/` 为准；
本文只记部署相关约束。

### 已知行为

- **先加载后 bind**：加载期间端口是关的（没有 503 loading 态），冷启动约数十秒。
  判断可用性只看 `/v1/health` 的 `ok:true`。
- `optionCounts` 恒为 `0/0`、`/v1/version.optionIds` 为空：Node 侧「空词表 = 不做掩码」，
  因此不要指望用 version 校验词表；权重身份用 `ckptSha256`。
- `tool_select.noToolMargin` 已移除（2026-11-05）：`biod-mt-v2` 服务端只读 `policy.tau`，
  该字段在 v2 下从未生效，留着只会误导调参。
- `state.maxChars` 已从 220 提到 **640**（4B 训练分布 p99≈552、max 612）。

## 验收

```bash
./bin/health.sh                                  # G1: ready + 指纹
python3 tools/parity.py --out parity-report.json # G2: 556 例回放，一致率 ≥99%
python3 tools/threshold_sweep.py                 # G3: tau/topK 有效性
./bin/smoke.sh                                   # 7 端点连通
```

`parity.py` 逐例比对服务端输出与
`Biod/artifacts/eval/paper1/models/paper1-4B-s20261104/legacy_7task_predictions.jsonl`，
并按 gold 重算各任务指标，与离线指标要求 delta ≤0.5pp。

## 回退

| 级别 | 操作 | 效果 |
|---|---|---|
| 1 | 清空 `BIOFLOW_BIOD_CKPT` + 重启 backend | biod 全量 fail-open，回落浏览/规则（秒级） |
| 2 | `config/biod.json` 设 `enabled:false` + 重启 backend | biod 完全不参与 |
| 3 | `./bin/stop.sh` + 还原 `.env`/`biod.json` 备份 | 服务下线 |

## 观测

backend 已内建决策审计日志（`WORKSPACE_ROOT/.runtime/`）：

- `biod-decisions.jsonl`：tool/kb/context 决策
- `biod-plan-audit.jsonl` / `biod-manuscript-audit.jsonl` / `biod-issue-audit.jsonl` / `biod-hypothesis-screen.jsonl`：框架点

上线后 24h 关注：每点调用数、`biod.status` 分布（selected / off / fallback 原因）、
tool 的 NO_TOOL 率、kb 空选率、p50/p95 延迟、显存峰值。

## 变更记录

- 2026-11-05：首次部署 `biod2-paper1-4b-v1`；固化权重；`state.maxChars` 220→640；
  完成 parity / 阈值 / 延迟验收（结果见同目录 JSON）。
