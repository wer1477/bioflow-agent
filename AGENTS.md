# Bioflow Agent Instructions

## 运行时边界

- `agent-client/backend/` 是唯一的 Agent 运行时边界：Agent 状态、工具、MCP、Skill 和 workflow 编排都在服务端运行；对外通过 REST API 提供能力。其中 run 的实时输出是 **NDJSON over POST**（`POST /api/conversations/:id/runs`，`application/x-ndjson`），**不是 SSE**。
- `agent-client/web/` 是 React 交互壳，只能消费 `/api`；新增 IDE 集成、SDK 或自动化同样消费 server API，不能耦合 Backend 内部模块。
- biod 决策层由 backend 托管：`biod/multitask/serve.py` 是本地回环 sidecar（能力选择、知识选择与冷区评分），Node 侧只经 `src/agent/biod/` 的 HTTP 边界调用；失败必须 fail-open，不得阻塞会话。
- 改运行时行为时，先确认 API 契约与 Web 消费方；改 Web 时，不把运行时逻辑迁入前端。

## 源码与本地状态

```text
agent-client/
  backend/src/       Express + TypeScript：运行时、HTTP、配置访问
  backend/config/    共享配置：agents.json、llm.json、mcp.json、biod.json、prompts/*.md
  web/               React + Vite 前端壳
  skills/            每个 Skill 一个目录，必须含 SKILL.md
  knowledgebase/    只读知识库：<领域>/<条目>/skill.md（纯知识 + 可查看资源，无执行脚本）
  toollibrary/       能力库展示层：index.md 领域索引 + <领域>/index.md 的 skill/MCP 工具 name+description
  workspace/         本地会话、事件和产物快照；不提交
  data/              本地分析数据；不提交
clitool/             独立生信 CLI 及测试；对应默认 Skill 位于 agent-client/skills/
```

- `backend/config/`、`skills/`、`knowledgebase/` 和 `toollibrary/` 是共享源码；运行时直接读取配置文件，Web 设置修改也会写回这里。biod 的机器相关路径只写在未提交的 `backend/.env`，`biod.json` 用 `${BIOFLOW_BIOD_*}` 引用。
- `clitool/` 只承载 CLI 实现与测试；每个 CLI 的 Agent 指令维护在 `agent-client/skills/<skill>/SKILL.md`，并通过 `agents.json` 显式绑定。
- `workspace/` 与 `data/` 是每位开发者的本地状态，不能作为协作同步或测试基线。
- Web/CLI 配置时可输入明文密钥；运行时会将其转存到 `agent-client/backend/.env`（或 `BIOFLOW_ENV_FILE`）并在 JSON 中写入 `${ENV_VAR}` 引用。手改配置时直接使用该引用。
- 路径通过模块位置、仓库根目录或环境变量解析；文档命令从仓库根目录使用相对路径。用户机器路径只允许出现在未提交的本地配置中。
- `knowledgebase/` 是人类策展的只读知识库，由 CoreTool `knowledgebase` 按需加载；知识条目不得包含可执行脚本，能力类说明书仍应放在 `skills/`。
- `toollibrary/` 是能力库的**展示层**：只放领域与工具的 name/description 和 id，不放正文；能力是否存在由 `agents.json` / `mcp.json` / `skills/` 决定。L1 领域索引（`toollibrary/index.md`）常驻 system prompt（`<tool_library_domains>`）；模型用 CoreTool `toollibrary` 浏览单个领域的工具、`toolload` 加载正文或 MCP schema。
- 改变架构、启动方式、配置/环境变量或共享行为时，同步更新 `README.md`、`docs/development.md` 或本文件中对应的单一事实来源，保持项目记忆与实现一致。

## 完成与验证

在 `agent-client/` 目录运行与变更范围匹配的命令：

```bash
npm run test
npm run build
```

涉及依赖、配置或运行时边界时，完成前还要确认相关锁文件、示例和文档同步。不要提交 `.env`、`.bioenv/`、`workspace/`、`data/`、`node_modules/` 或构建产物。

## 按需查阅

- 首次安装、环境变量、完整命令与依赖更新：[`README.md`](README.md) 和 [`docs/development.md`](docs/development.md)。
- 配置文件格式、密钥引用和 MCP：[`agent-client/backend/config/README.md`](agent-client/backend/config/README.md)；MCP CLI 用法见 [`docs/development.md`](docs/development.md)。
