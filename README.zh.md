# Bioflow

Bioflow 是一个在本地运行、面向生物研究任务的 Agent 平台。它以 `agent-client/backend` 中的 Agent 运行时为核心，提供 REST 和 SSE API；`agent-client/web` 仅负责呈现与交互。

> 本仓库当前以 Linux/macOS（或 Windows 的 WSL）为主要开发环境。运行时会执行本地命令和 Python/R 分析，请只在受信任的工作区中启动。

## 快速开始

### 1. 准备运行环境

- Git
- Node.js `22.12.0` 或更高版本（推荐用仓库中的 `.nvmrc`）
- Conda 或 Micromamba（用于 Python/R 生信环境）

在仓库根目录创建 Python/R 环境。**prefix 必须写绝对路径**：micromamba（以及 conda）会把相对 prefix 解析到 `$MAMBA_ROOT_PREFIX/envs/` 下，而不是当前目录，于是环境不会出现在仓库里、`scripts/activate-bioenv.sh` 也找不到它。

```bash
micromamba env create --prefix "$PWD/.bioenv" --file environment.yml
# 使用 conda 时：conda env create --prefix "$PWD/.bioenv" --file environment.yml
source scripts/activate-bioenv.sh
```

MACS2 没有可用于当前 glibc/Python 的 conda 构建、HOMER 参考基因组也不在 conda 包内，因此首次创建环境后再执行一次：

```bash
scripts/setup-cli-tools.sh                                      # MACS2 工具环境 + HOMER hg38
scripts/setup-cli-tools.sh --skip-homer-data                    # 只装 MACS2
```

`bio-doctor check --format json` 与 `bio-peak tools --format json` 可确认 clitool 外部依赖是否就绪。

`scripts/setup-ngs-tools.sh` 会把 `fastp`/`bwa`/`STAR`/`salmon`/`megahit`/`kraken2`/`kaiju`/`taxpasta`/`seqkit`/`subread` 安装到 `.tools/ngs`，并在 `.bioenv/bin` 生成 wrapper；`bio-align check` 与 `bio-metagenomics check` 可确认。Kraken2/Kaiju 的分类数据库需另行准备。

安装 Node 依赖：

```bash
cd agent-client
npm run install:all
```

### 2. 配置本地密钥

后端默认从 `agent-client/backend/.env` 读取本地密钥，也接受启动前由 shell 导出的变量。复制示例后，至少填入当前默认 LLM 的密钥；若保留默认的 `tavily`、`exa`、`context7` MCP，也填入对应的三个密钥变量。`biomcp` 与 `tooluniverse` 默认启用但不需要密钥，需要先安装本地二进制：`uv tool install biomcp-cli` 与 `uv tool install tooluniverse==1.5.7`（安装到 `~/.local/bin`，配置会通过 `bash -c` 包装注入 PATH）；`biocontext` 是托管远程服务，默认启用且不需要密钥；`chatspatial` 与 `seqera` 默认关闭，按需启用。

`backend/config/llm_presets.json` 为“新建供应商”弹窗提供 29 条预设：主流厂商（OpenAI、Anthropic、Gemini、DeepSeek、通义千问、Kimi、智谱、豆包、MiniMax、阶跃、硅基流动等）、订阅制 coding plan（智谱 GLM Coding、Kimi For Coding、阿里 Token Plan、小米 MiMo、MiniMax 国内、Moonshot 国内），以及 OpenRouter/Groq/Mistral/xAI/Together/Fireworks/NVIDIA NIM/Baseten 等网关。设置页默认仍只显示 `llm.json` 中的 `dgx`，不会自动增加供应商。

```bash
cd agent-client
cp .env.example backend/.env
# 编辑 backend/.env
```

`backend/.env` 不会被 Git 跟踪。Web/CLI 可接受明文凭据，但会自动转存到该本地文件，并在配置 JSON 中写入环境变量引用（例如 `${BIOFLOW_LLM_API_KEY_DGX}`）；不要手工把密钥提交到 `backend/config/*.json`。

### 3. 启动

开发时分别启动 API/运行时和前端：

```bash
cd agent-client
npm run dev          # 后端：http://localhost:3000
npm run dev:web      # 前端：http://localhost:5173，/api 默认代理至 :3000（可用 BIOFLOW_API_TARGET 覆盖）
```

或构建一次后从仓库根目录启动整合服务：

```bash
./bioflow --port 3000
```

若同一台机器上已有实例占用 `3000`，用独立端口启动开发栈：

```bash
PORT=3001 npm run dev                                      # 后端换到 3001
BIOFLOW_API_TARGET=http://localhost:3001 npm run dev:web    # 前端 /api 代理指向 3001
```

健康检查：`curl http://localhost:3000/api/health`

## 架构与目录

```text
agent-client/
  backend/       Express + TypeScript：Agent 运行时、REST API（run 流为 NDJSON）、MCP、配置读取
  web/           React + Vite：前端交互壳，所有能力通过 /api 调用后端
  skills/        本地 Skill：每个目录包含 SKILL.md，可附带 resources/
  knowledgebase/ 只读知识库：领域/条目/skill.md + 可查看 resources/，不含可执行脚本
  toollibrary/   能力库展示层：领域索引常驻 system prompt，每个领域的工具 name/description（skill 与 MCP）供 toollibrary/toolload 按需读取
  workspace/     对话快照、运行记录和产物文件（本地状态，不提交）
  data/          本地分析数据（不提交）
clitool/         独立生信 CLI 工具及各自的测试；默认 Agent 指令位于 agent-client/skills/ 并由 agents.json 绑定
environment.yml  Python/R 生信运行环境
requirements.txt Python 直接依赖的精确版本
```

配置的源码在 `agent-client/backend/config/`：`agents.json`、`llm.json`、`llm_presets.json`、`mcp.json`、`biod.json` 和 `prompts/*.md`。运行时直接读取这些文件；Web 设置页的配置修改也会写回这里。`llm_presets.json` 是主流供应商预设覆盖层（OpenAI 兼容端点、精选模型顺序与置顶排序），与自动生成的 `llm_catalog.json` 分开维护；`npm --prefix backend run probe:presets` 会无凭据探测每条预设的 `/models` 端点，用来确认当前网络能不能连上（详见 `agent-client/backend/config/README.md`）。若需要使用另一套配置，将 `BIOFLOW_CONFIG_DIR` 指向该目录。

## 开发与验证

在 `agent-client/` 下运行：

```bash
npm run build        # 依次构建 Web 与 Backend（Backend 同时做 TypeScript 检查）
npm run test         # 运行 Backend 与 Web 测试
```

更详细的协作约定、测试命令、配置边界和 MCP 命令行维护方式见 [docs/development.md](docs/development.md)。

## 协作边界

- 改 Agent 行为、状态、工具、MCP、Skill 或编排时，改后端及其 API；不要让 Web 直接依赖运行时内部模块。
- 不提交 `.env`、`.bioenv/`、`workspace/`、`data/`、`node_modules/` 或构建产物。
- `backend/config/`、`skills/`、`knowledgebase/`、`toollibrary/` 和共享提示词容易产生冲突；变更前先同步并在 PR 中说明兼容性和所需环境变量。
