# Bioflow Agent

**本地优先、基于团队协作、带训练决策层的生物信息学 Agent。**

Bioflow 在生物信息学运行时之上运行一个小型研究团队：PI、Searcher、Researcher、Writer 和
Reviewer。主 LLM 负责规划、写代码、执行与解读结果；一个本地部署的小型决策模型
（`biod-mt-v2`）负责三类结构化决策，使已装载的能力库与知识库可以增长，而主提示词不随之线性增长。

| 决策 | 问题 | 回退 |
|---|---|---|
| 能力选择（`tool_select`） | 下一步应加载哪个能力？ | 浏览目录 |
| 知识选择（`kb_select`） | 哪些知识条目相关？ | 索引 / 目录 |
| 上下文保留（`context_retention`） | 冷区上下文组中哪些应保留？ | 规则基线 |

角色路由与 relay 门控由团队层直接调用同一个 sidecar，不属于论文中评测的三类决策。每次
sidecar 决策都会记录置信度、延迟与模型版本；任何失败都会回退到原有路径——会话不会因决策层
不可用而阻塞。

## 设计动机

生物信息学工作是一长串细小但关键的判断：用哪个工具、哪个参考版本、哪条知识、由谁回答一条消息。
通用 Agent 在主 LLM 内部隐式完成这些选择。Bioflow 把它们拆开：

- **有界决策 → 小模型。** sidecar 在一次前向中回答结构化选择题，返回有界标签或分数。
- **开放推理 → 主 LLM。** 主模型负责规划、写代码、解读结果，并处理决策层不确定的部分。
- **固定团队 → 显式交接。** 五个角色共享工作区但不共享对话记录；交接以运行时生成的卡片表达。
- **默认可审计。** 决策、工具调用、产物与 run manifest 都被记录，分析过程可检查、可重跑。

## 架构

```text
用户
 │
 ▼
PI ── 拆解 / 分派 / 仲裁 / 验收
 ├─ Searcher   文献、证据、假设
 ├─ Researcher 设计与执行、统计、解读
 ├─ Writer     叙事、图表、引用、投稿
 └─ Reviewer   新颖性、方法、统计、一致性

共享工作区 · 合并时间线 · 不共享对话记录

主 LLM ──HTTP──► biod sidecar（4B）
                   能力 / 知识 / 上下文决策
                   （角色路由与 relay 门控由团队层直接调用）
```

## 仓库内容

- `agent-client/backend` —— Agent 运行时、REST API（run 流为 NDJSON）、团队编排、决策层 HTTP 客户端。
- `agent-client/web` —— Web UI，只消费 `/api`。
- `agent-client/skills`、`knowledgebase`、`toollibrary` —— 按需加载的能力与知识目录。
- `clitool/` —— Agent 使用的生信 CLI 工具。
- `docs/` —— 架构、部署、开发与决策层集成说明。

决策模型本身（训练代码、服务代码与权重）位于配套仓库
[Biod](https://github.com/wer1477/bioflow-biod)。

## 快速开始

```bash
# 1) Python/R 环境
micromamba env create --prefix "$PWD/.bioenv" --file environment.yml
source scripts/activate-bioenv.sh
scripts/setup-cli-tools.sh --skip-homer-data

# 2) Node 依赖
cd agent-client && npm run install:all && cd ..

# 3) 配置 LLM 端点
cp agent-client/.env.example agent-client/backend/.env
# 编辑 agent-client/backend/.env

# 4) 启动
./bioflow --port 3000
```

打开 `http://localhost:3000`；健康检查为 `GET /api/health`。

## 决策层权重

评测使用的 sidecar 权重发布在
[huggingface.co/wer1477/biod-mt-v2-4b](https://huggingface.co/wer1477/biod-mt-v2-4b)：冻结的
Qwen3.5-4B-Base 文本塔 + LoRA adapter + 五个路由头。用 Biod 仓库里的
`scripts/download-weights.sh` 下载后，把后端指向 Biod 检出与权重目录：

```bash
# agent-client/backend/.env
BIOFLOW_BIOD_PYTHON=/path/to/Biod/.venv/bin/python
BIOFLOW_BIOD_REPO=/path/to/Biod
BIOFLOW_BIOD_CKPT=/path/to/biod-mt-v2-4b
```

后端会按需拉起 sidecar；sidecar 不可用时自动回退到浏览。服务契约见
`docs/biod-integration.md` 与 Biod 仓库。

## 评测说明

本仓库提供运行时与决策层集成。论文中的受控评测——已验证资产复用、原生工具选择、知识选择、
冷区保留以及一个公开植物工作流案例——使用冻结的 harness、提示词、配置指纹与结果表，随审稿包
提供，不在本仓库内。本仓库不声称任何 benchmark 分数。

## 引用

如果使用本软件，请引用论文与本仓库，见 `CITATION.cff`。

## 许可

Apache-2.0。基座模型遵循 Qwen 模型许可，见 `NOTICE`。

## 安全

如发现疑似漏洞，请不要公开提 issue，见 `SECURITY.md`。
