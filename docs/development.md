# Bioflow 协作开发指南

## 首次上手

按仓库根目录的 [README](../README.md) 创建 `.bioenv`、安装 `agent-client` 的三套 Node 依赖，并将 `agent-client/.env.example` 复制为 `agent-client/backend/.env`。运行时会自动发现仓库根目录的 `.bioenv/bin`；在终端中手动执行生信命令时，仍建议先执行：

```bash
source scripts/activate-bioenv.sh
```

### 外部生信 CLI 依赖

`environment.yml` 已声明 clitool 使用的外部可执行文件：`ncbi-datasets-cli`（`bio-fetch genome`）、`sra-tools`（`bio-fetch sra`）与 `homer`（`bio-peak motif`），并补齐 `bio-doctor` 的 r-core 画像所需的 `r-data.table`。MACS2 在 bioconda 只提供面向旧 glibc 的 Python 3.9–3.11 构建（在当前系统上会因 `__log_finite` 未定义而失败），HOMER 参考基因组也不在 conda 包内，因此首次创建 `.bioenv` 后再执行一次（脚本会在 `.tools/macs2` 中用 Python 3.11 从源码构建 MACS2）：

```bash
scripts/setup-cli-tools.sh                 # 创建 .tools/macs2，并安装 HOMER hg38 基因组（约 1.6 GB）
scripts/setup-cli-tools.sh --skip-homer-data
```

脚本把 MACS2 前缀视为“完整”必须同时具备可执行的 `bin/macs2` 与 `conda-meta/history`。
若上次创建被中断、只留下 `lib/python3.11`，脚本会先把该目录移到
`.tools/macs2.partial.<时间戳>` 再重建，而不是在半成品上继续安装；重建失败会直接报错退出，
不会留下悬空的 `.bioenv/bin/macs2`。

验证：

```bash
source scripts/activate-bioenv.sh
bio-doctor check --format json              # bioagent-r-core 画像应为 available
bio-peak tools --format json                # macs2 与 findMotifsGenome.pl 均 available
.bioenv/bin/python scripts/check-bioenv-pins.py   # 直接依赖必须与 .bioenv 一致
.bioenv/bin/python scripts/verify-scanpy-pca.py   # 期望 PCA_OK 与 MASK_VAR_FALLBACK_OK
```

`requirements.txt` 里 `numpy==2.3.5` 是硬要求：numpy < 2.1 不支持 DLPack 1.0 的只读数组导出，
scanpy 在 `highly_variable_genes` 之后直接 `sc.pp.pca(adata)` 会抛
`BufferError: Cannot export readonly array ...`。`check-bioenv-pins.py` 在依赖漂移时失败，
`verify-scanpy-pca.py` 在运行时回归时失败；两者都应在发布前跑一次。

若有人把 bioconda 工具手装进 `.bioenv`（例如系统发生学用的 `clipkit`，其元数据声明
`numpy<2.1`），`pip check` 会报一条声明冲突；这类工具应改用独立环境，不要混进共享 `.bioenv`。
当前环境里的 `clipkit 2.14.0` 在该 numpy 上实测小比对可正常运行，但不作为兼容性保证。

`clitool/*/bin/*.js` 通过 git mode `100755` 固化执行位。`npm link` 只会把包目录链接到全局 `bin`，
符号链接继承目标文件权限，所以入口文件一旦缺执行位，`command -v bio-xxx` 能找到但执行会报
`Permission denied`。从归档/挂载复制仓库若丢失了该位，修复后重跑测试：

```bash
git update-index --chmod=+x 'clitool/*/bin/*.js'
cd agent-client/backend && npm test         # default_clitool_skills.test.ts 会守住这一条
```

默认配置使用的变量如下：

| 变量 | 是否必需 | 用途 |
| --- | --- | --- |
| `BIOFLOW_LLM_API_KEY_DGX` | 是（系统预置 LLM） | `backend/config/llm.json` 中 `dgx` provider 的 API key |
| `BIOFLOW_LLM_API_KEY_OPENCODE_GO_2` | 否（仅绑定该 provider 时） | `backend/config/llm.json` 中 `opencode-go-2` provider 的 API key；该 provider 还需要配置 `x-opencode-session` 请求头 |
| `BIOFLOW_TAVILY_API_KEY` | `tavily` MCP 启用时 | `tavily` 托管端点的 `tavilyApiKey` url 参数（streamableHttp） |
| `BIOFLOW_MCP_EXA_X_API_KEY` | `exa` MCP 启用时 | `exa` 托管端点的 `x-api-key` header（streamableHttp） |
| `BIOFLOW_MCP_CONTEXT7_API_KEY` | `context7` MCP 启用时 | `context7` 托管端点的 `CONTEXT7_API_KEY` header（streamableHttp） |
| `BIOFLOW_MCP_SEQERA_ACCESS_TOKEN` | `seqera` MCP 启用时 | Seqera Platform Personal Access Token（`Authorization: Bearer` header；该 server 默认 `enabled:false`） |
| `PORT` | 否 | 后端端口，默认 `3000` |
| `BIOFLOW_API_TARGET` | 否 | 仅 Vite 开发服务器使用：`/api` 的代理目标，默认 `http://localhost:3000` |
| `BIOFLOW_CONFIG_DIR` | 否 | 替代 `backend/config/` 的配置目录 |
| `BIOFLOW_ENV_FILE` | 否 | 启动前在 shell 中设置，用于替代 `backend/.env` 的密钥文件 |
| `BIOFLOW_BIOD_PYTHON` | biod 决策层启用时 | sidecar 解释器绝对路径（`Biod/.venv/bin/python`） |
| `BIOFLOW_BIOD_REPO` | biod 决策层启用时 | Biod 仓库绝对路径（sidecar 的 cwd 与 `.hf_cache` 根） |
| `BIOFLOW_BIOD_CKPT` | biod 决策层启用时 | 决策模型 run 目录（含 `biod_config.json`、`heads.pt`、`adapter/`） |
| `BIOFLOW_BIOD_DISABLED` | 否 | `1`/`true` 时完全关闭 biod（测试与回滚用） |
| `BIOFLOW_SUBAGENT_MAX_DEPTH` | 否 | 委派深度上限，默认 `1`（`0` 关闭委派；子 Agent 深度为父 +1） |
| `BIOFLOW_SUBAGENT_MAX_CONCURRENT` | 否 | 同时运行的子 Agent 上限，默认 `2`；超出直接返回 `subagent_busy`，不排队 |
| `BIOFLOW_SUBAGENT_TIMEOUT_MS` | 否 | 子 Agent 默认与最大墙钟时长，默认 `900000`（15 分钟），下限 30 秒、上限 1 小时 |
| `BIOAGENT_PYTHON` | 否 | 指定分析内核使用的 Python 可执行文件 |
| `BIOAGENT_ENV_BIN` | 否 | 指定包含 Python/R 等可执行文件的 `bin` 目录 |
| `WEB_ROOT` | 否 | 指定后端静态托管的前端构建目录 |
| `BIOFLOW_FEEDBACK_DB` | 否 | 意见反馈 SQLite 文件，默认 `workspace/feedback.sqlite`；仅登录版启用 |
| `BIOFLOW_AUTH_ENABLED` | 否 | `1`/`true` 时启用登录鉴权；默认关闭，开发实例保持无登录 |
| `BIOFLOW_AUTH_DB` | 否 | 鉴权 SQLite 文件，默认 `backend/data/auth.sqlite` |
| `BIOFLOW_AUTH_ADMIN_EMAILS` | 部署版 | 逗号分隔的管理员邮箱；注册时授予、登录时补授 `admin` |
| `BIOFLOW_AUTH_SMTP_*` | 部署版 | 验证码邮件通道：`HOST`/`PORT`/`USER`/`PASS`/`FROM`（465 隐式 TLS、587 STARTTLS） |

若没有某个 MCP 的密钥，可在 `backend/config/mcp.json` 中把该 server 的 `enabled` 设为 `false`，或改用一份由 `BIOFLOW_CONFIG_DIR` 指定的个人配置。不要修改并提交他人的密钥或环境文件。

### 登录鉴权（仅部署实例）

开发实例**不设置** `BIOFLOW_AUTH_ENABLED`：鉴权中间件、登录路由、让登录页面出现的 `/api/auth/mode` 之外的 auth 端点、以及 SQLite 都不会加载，API 行为与未引入登录前完全一致。部署实例在 `.env.prod` 中打开：

```bash
BIOFLOW_AUTH_ENABLED=1
BIOFLOW_AUTH_ADMIN_EMAILS=you@example.com
BIOFLOW_AUTH_SMTP_HOST=smtp.qq.com
BIOFLOW_AUTH_SMTP_PORT=465
BIOFLOW_AUTH_SMTP_USER=xxxx@qq.com
BIOFLOW_AUTH_SMTP_PASS=授权码
```

- 鉴权数据使用 Node 内置 `node:sqlite`，**启动命令必须带 `--experimental-sqlite`**；`npm run dev`、`npm test`、`npm start` 与 `bin/bioflow.mjs` 已内置该标志，直接 `node dist/index.js` 时需手动加。
- 会话：httpOnly cookie + 服务端 session；普通 7 天滑动、「记住我」30 天；改密/重置/禁用会撤销会话。
- 验证码：6 位、10 分钟、错误 5 次作废、单次使用；同邮箱 60 秒冷却 / 每小时 5 次，同 IP 每小时 20 次，同 IP 每天最多注册 5 个账号；登录失败 5 次锁 15 分钟。
- 前端通过 `GET /api/auth/mode` 判断是否渲染登录；`{enabled:false}` 时保持现状。
- 鉴权启用时，每个用户独占 `<BIOFLOW_WORKSPACE_DIR>/users/<userId>/`：项目目录、`.sessions`、`.trash`、`.runtime` 全在该根下；开发实例（开关关闭）继续使用原来的 workspace 根。
- 用户自带 LLM：`/api/me/llm` 管理私有 provider（API key 用 AES-256-GCM 加密存鉴权库，响应只回掩码），`/api/me/llm/roles/<roleId>` 覆盖 5 个角色的 provider/model/thinking；系统预置（`config/llm.json` 的 `dgx`）只读。
- 用户 LLM key 的主密钥优先取 `BIOFLOW_AUTH_ENCRYPTION_KEY`（32 字节 base64）；未设置时在鉴权库同级生成 `auth-secret.key`（0600）。更换或丢失主密钥会让已保存的用户 key 无法解密。
- 意见反馈：仅登录版提供。账户菜单 →「意见反馈」，`POST /api/feedback` 写入 `workspace/feedback.sqlite`（可用 `BIOFLOW_FEEDBACK_DB` 覆盖）；管理员在设置 →「意见反馈」只读查看。鉴权关闭的开发实例没有入口，端点也不挂载（404），且不会创建反馈库。
- 全局配置写入（`/api/config/manage` 的增删改、`/api/config/files`、`/api/settings/reload`）仅管理员；普通用户只能读取 `/api/settings`（不含系统提示词）、provider 目录与探测接口。
- 管理员接口：`GET /api/admin/users`（搜索/状态/活跃会话/provider 数）、禁用/启用、强制下线、触发重置邮件，以及 `GET /api/admin/audit`（审计保留 30 天）；全部要求 `role=admin`。
- 管理端入口：设置 →「用户与审计」/「意见反馈」（仅管理员可见）；普通用户看不到「团队」「用户与审计」「意见反馈」。
- 审计事件包括 register/login/login_failed/logout/code_sent/password_reset/password_changed/admin_disable/admin_enable/admin_revoke_sessions/admin_password_reset_sent。
- 生产必须通过 HTTPS 访问，cookie 默认 `Secure`；本地 http 调试时设 `BIOFLOW_AUTH_COOKIE_SECURE=0`。
- 部署实例（目录、`.env`、nginx、frp、升级步骤）见 [`docs/deployment.md`](deployment.md)。
- 反向代理需要转发 `X-Forwarded-For`（`/etc/nginx/webnginxs/bioagent.conf` 已设置），后端信任回环跳数以取得真实客户端 IP。

当前共享 `mcp.json` 启用 6 个 server：`tavily`、`exa`、`context7`（托管 streamableHttp，需密钥）、`biocontext`（托管 streamableHttp，无需密钥）与 `biomcp`、`tooluniverse`（stdio，需本地安装：`uv tool install biomcp-cli`、`uv tool install tooluniverse==1.5.7`，二进制落在 `~/.local/bin`，配置通过 `bash -c` 包装注入 PATH）；`chatspatial` 与 `seqera` 已预置但 `enabled:false`（前者依赖重、训练型方法可能超 60s 工具超时；后者需要 Seqera 账号 + PAT）。`agents.json` 的五个团队角色都绑定了已启用的 server。其中 `tavily` 与 `exa` 标记 `internal: true`：它们只作为内置 `web_search` 的 provider 保持连接，工具与 MCP 资源不进入 toollibrary，也不能被 `toolload` 装载。新增变量需写入 `backend/.env` 并**重启后端**才会进入 `process.env`（Web 设置页写入时会同时注入当前进程）。

## 日常命令

所有命令从 `agent-client/` 运行：

```bash
npm run dev             # 后端开发服务
npm run dev:web         # Vite 前端开发服务
npm run build:backend   # tsc + 复制运行时资源
npm run build:web       # 构建前端
npm run build           # 两者都构建
npm run test            # 后端与前端测试
npm run bioflow -- mcp list
```

### 并行运行多个实例

同一台机器上如果已有实例占用默认端口，用环境变量把开发栈错开，避免两个实例争用 `3000`：

```bash
PORT=3001 npm run dev
BIOFLOW_API_TARGET=http://localhost:3001 npm run dev:web
```

后端端口来自 `PORT`（也可以写在未提交的 `backend/.env` 中）；`BIOFLOW_API_TARGET` 只影响 Vite 开发服务器的 `/api` 代理，不参与构建产物，因此不需要它也能正常 `npm run build`。

### 供应商预设的网络可达性

`llm_presets.json` 的 29 条预设描述的是“供应商提供什么”，不是“当前网络能不能连上”。改预设前后跑一次无凭据探测（需要网络，不进 `npm run test`）：

```bash
cd agent-client/backend
npm run probe:presets                      # 全部 29 条
node scripts/probe-presets.mjs --only coding --strict
```

判定四档：`needs-key`（401/403，路径正确、只缺密钥）、`open`（2xx，端点公开模型列表）、`path-missing`（404，该传输协议的路径不对）、`unreachable`（DNS/TCP/TLS 未完成）。从实验室部署网络出发，`api.openai.com`、`generativelanguage.googleapis.com`、`api.mistral.ai`、`api.x.ai`、`api.together.xyz`、`router.huggingface.co` 连不上，这些预设只有走网络层代理才可用；国内厂商、MiniMax、OpenRouter、Groq、Cerebras、Fireworks、Baseten、NVIDIA 均可直达。Ollama / LM Studio 报 `unreachable` 是正常的——部署机上没跑本地推理服务。

### 供应商协议（protocol）

`llm.json` 的 provider 可带 `protocol`，取 `openai-completions`（缺省）、`anthropic-messages`、`openai-responses`。运行时始终使用同一套 OpenAI 形状的消息模型，只有传输层按协议分派：

- `openai-completions`：`POST {baseUrl}/chat/completions`，Bearer 鉴权。
- `anthropic-messages`：`POST {baseUrl}/v1/messages`，`x-api-key` + `anthropic-version`；`cache_control` 断点与 `thinking.budget_tokens` 在这里才真实生效，`max_tokens` 会自动抬到预算之上，低于协议下限（1024）的预算不发送。
- `openai-responses`：`POST {baseUrl}/responses`。

设置页的“协议”下拉与预设一起决定这个字段；切换协议不需要改模型清单。两条原生路径目前都**没有真机验证**（部署上没有 Anthropic / OpenAI key），只有本地契约测试：`backend/test/llm_anthropic_messages.test.ts` 与 `backend/test/llm_responses.test.ts`。Responses 适配器复用同一个 `openai` SDK 的 `responses.create`，不需要新依赖；它发送 `store: false`，不把会话留在服务端。

### 大文件上传（分块/续传）

浏览器上传超过 64MB 的文件时走分块协议；不超过 64MB 的仍走原来的单请求直传接口。

| 项 | 值 |
| --- | --- |
| 单文件上限 | 10GB（后端硬限制，前端提前拦截） |
| 分块大小 | 16MB（服务端下发） |
| 客户端并发 | 2 块（协议支持乱序与重复块） |
| 续传 | 断网自动重试；刷新/崩溃后重选同一文件，从服务端已收块继续 |
| 临时目录 | `agent-client/workspace/.runtime/uploads/<uploadId>/`（`BIOFLOW_WORKSPACE_DIR` 可改根） |
| 清理 | 会话 7 天过期；后端启动、每次初始化与列表时清扫 |
| 配额 | 全局 8 个活跃会话、单项目 4 个、预留 1GB 磁盘余量 |

接口都在项目路由下，路径校验与文件树一致：

```text
POST   /api/projects/:key/uploads                 {path,size} -> {upload}
GET    /api/projects/:key/uploads                 -> {uploads}
GET    /api/projects/:key/uploads/:id             -> {upload}
PUT    /api/projects/:key/uploads/:id/chunks/:i   application/octet-stream -> {chunk}
POST   /api/projects/:key/uploads/:id/complete    -> {file,...workspace}
DELETE /api/projects/:key/uploads/:id             -> 204
```

完成时把临时文件 `rename` 进项目目录（同文件系统，原子覆盖），不会产生第二份副本；未完成的数据不在项目树里，Agent 与文件浏览器都看不到。改动这些行为后需要重启后端。

如果通过部署机的 nginx 入口访问（nginx 配置不在仓库内），分块请求需要：

```nginx
client_max_body_size 64m;     # 一块 16MB + 余量；旧直传快路径仍 ≤64MB
proxy_request_buffering off;  # 让块直接透传给后端
```

开发实例默认不启用登录鉴权；若对公网暴露，请打开 `BIOFLOW_AUTH_ENABLED`，或在 nginx 层加认证与来源限制，而不是只保护上传接口。

### 项目文件直出（raw）

`GET /api/projects/:key/files/file` 返回的是 base64，浏览器无法用它直接渲染 PDF 或大图，因此另有一条流式端点：

```text
GET    /api/projects/:key/files/raw?path=<项目内相对路径>&download=0|1   -> 200 原始字节
```

`Content-Type` 与 `readProjectFile` 同源，来自 `guessProjectMimeType()`，未知扩展名回 `application/octet-stream`；默认 `Content-Disposition: inline`，`download=1` 时改为 `attachment`，文件名按 RFC 5987 编码（中文名不会乱码）。路径校验复用 `resolveProjectPath()`，越界、不存在、指向目录都返回 400 JSON。响应走 `res.sendFile()`，自带 `Range` / `206`（PDF 翻页、图片分段加载）。

### MCP 命令行配置

`bioflow mcp` 可在不打开 Web 设置页时维护 MCP 服务，适合本地脚本和 CI。`--env` 与 `--header` 可传入明文凭据；CLI 会写入本地环境文件、将 `mcp.json` 改为变量引用。所有输出默认隐藏 `env` 与 `headers` 中的值：

```bash
npm run bioflow -- mcp list [--scope project|local|user] [--json]
npm run bioflow -- mcp get <name> [--scope project|local|user]
npm run bioflow -- mcp add <name> --command <command> --arg <arg>
npm run bioflow -- mcp add <name> --url <url> --transport sse|streamableHttp
npm run bioflow -- mcp remove <name> [--scope project|local|user]
```

默认 `project` scope 读写 `backend/config/mcp.json`；`local` 使用 `agent-client/.bioflow/config/`；`user` 使用 `$XDG_CONFIG_HOME/bioflow/`（否则为 `~/.config/bioflow/`）。用 `--config-dir <path>` 可指定明确目录。服务端要使用非默认配置，启动时设置 `BIOFLOW_CONFIG_DIR`：

```bash
BIOFLOW_CONFIG_DIR="$PWD/.bioflow/config" BIOFLOW_ENV_FILE="$PWD/.bioflow/.env" npm run bioflow -- start
```

MCP 的启用状态和服务定义在 `mcp.json`，而 Agent 绑定仍由 `agents.json` 或 Web 设置页维护。`--show-secrets` 可显示未遮盖的配置值；由 CLI 管理的凭据仍只会显示变量引用，它不会读取或打印本地环境文件中的实际密钥。

测试也可以按影响范围运行：

```bash
npm --prefix backend test
npm --prefix web test
```

提交前至少运行与变更范围相符的测试；涉及 TypeScript、路由、配置或 UI 集成时，再运行 `npm run build`。使用锁文件安装时，在三个目录分别执行 `npm ci`：`agent-client/`、`agent-client/backend/`、`agent-client/web/`。

## 任务运行中的上下文压缩

上下文占用率按扣除输出预留后的输入预算计算。60% 是软水位，用于提示和运行后的检查点。达到 80% 时，后端在下一次模型请求前压缩历史，保留当前用户指令、原有工具和运行 ID。仍超过硬水位时，后端尝试缩短保留的近期历史，以及裁剪有轨迹原文引用的长工具结果。会改写模型输入的压缩只在实际降低预算估算时提交。

恢复后仍可容纳完整请求时，同一次运行继续。上下文装不下时，运行以 `budget_exceeded` 失败并尝试保存检查点。当本轮已显式建立待办，模型提前结束会触发一次续跑提醒。相同待办再次被提前结束时，运行以 `unfinished_tasks` 失败。规划工具显式请求用户输入时，可以正常等待。

## 修改位置

| 目标 | 主要位置 | 注意事项 |
| --- | --- | --- |
| Agent 运行、工具和编排 | `agent-client/backend/src/agent/` | 服务端是唯一运行时边界 |
| HTTP / SSE API | `agent-client/backend/src/http/` | 先定义稳定 API，再由客户端消费 |
| 配置与提示词 | `agent-client/backend/config/` | JSON 中的 credential 字段必须使用 `${ENV_VAR}` |
| 前端交互 | `agent-client/web/src/` | 不导入 Backend 内部模块 |
| 可复用 Skill | `agent-client/skills/<id>/SKILL.md` | 可选资源放在同目录 `resources/` |
| 知识库条目 | `agent-client/knowledgebase/<领域>/<条目>/skill.md` | 纯知识，不含可执行脚本；可选可查看资源放在同目录 `resources/`；领域描述写在 `knowledgebase/skill.md` |
| 能力库展示层 | `agent-client/toollibrary/<领域>/index.md` | 只放工具 name/description 与 id；领域描述写在 `toollibrary/index.md`；能力是否可用由配置决定 |
| 生信 CLI | `clitool/<tool>/` | 维护 CLI 实现、README 与测试；对应默认 Skill 在 `agent-client/skills/<id>/SKILL.md` |

## 新增知识库条目

知识库（Knowledge Base）是独立的只读 CoreTool，内容在 `agent-client/knowledgebase/`：

```text
knowledgebase/
├── skill.md                    # 领域索引：`- <领域>：<描述>`
└── <领域>/<条目>/
    ├── skill.md                # `name` + `description` frontmatter + 知识正文
    └── resources/              # 可选：图片、表格、补充 Markdown 等可查看资料
```

写作约束：

1. 领域目录名即领域名；新增领域时在 `knowledgebase/skill.md` 增加一行描述，否则 `knowledgebase action="index"` 会返回 `unlisted_domain` warning。
2. 条目 `skill.md` 的 `name` 允许中文、≤120 字符；`description` 必填且建议 ≤120 字（它就是对模型的选择依据）。
3. 单条正文建议 ≤28 000 字符：`knowledgebase` 结果在观测层的内联上限是 30 000 字符，超过会退化为「摘要 + 前 6 000 字符 + 落盘路径」。更长的内容拆成多条，或把大段资料放进 `resources/`。
4. 知识库只放可查看资料，不得放 `.py` / `.sh` / `.ipynb` 等可执行文件（工具只返回 warning，不会执行，但违反知识库边界）。
5. 修改后在 `agent-client/` 运行 `npm --prefix backend test`：`knowledgebase_content.test.ts` 会校验索引一致性、条目 id/name 唯一、正文预算与资源约束。

## 新增能力库条目（toollibrary）

能力库（Tool Library）是 CoreTool `toollibrary`（浏览）+ `toolload`（加载）的**展示层**，内容在 `agent-client/toollibrary/`。根 `index.md` 的领域索引会作为 `<tool_library_domains>` 常驻 system prompt，因此领域描述同时也是模型选域的主要依据：

```text
toollibrary/
├── index.md                    # 领域索引：`- <领域>：<描述>`
└── <领域>/index.md             # `- <name>（skill：<skill-id>）：<描述>`
                                # `- <name>（mcp：<server>_<tool>）：<描述>`
```

写作约束：

1. 领域目录名即领域 name，必须与根 `index.md` 的描述行一一对应；当前统一使用英文领域名（可含空格）。
2. 条目只允许两种 kind：`skill`（id 为 `skills/` 下的目录名，即 `slug(name)`，如 `scanpy`、`bio-seq`）与 `mcp`（id 为 MCP 公开名 `<server>_<tool>`，如 `context7_query-docs`）。`mcp.json` 里 `internal: true` 的 server（当前 `tavily` / `exa`，内置 `web_search` 的 provider）不进入展示层，不要为它们写条目。
3. **配置是存在性权威**：只有被当前 agent 绑定且启用的 skill / MCP 工具会展示；列了但不可见会返回 `unknown_tool` warning 并被隐藏。已配置但没写进任何领域文件的能力会进入运行时兜底领域 `Unclassified` 并返回 `unlisted_tool` warning。
4. 单条 name ≤120 字符、description ≤700 字符（超出返回 warning）；正文与 MCP schema 不写进这里，由 `toolload` 按需加载。
5. 新增/删除/绑定 skill 或 MCP server 后同步更新对应领域文件；修改后在 `agent-client/` 运行 `npm --prefix backend test`，`toollibrary_content.test.ts` 会校验领域覆盖、绑定一致性与描述预算。

## 本地状态与共享配置

`agent-client/workspace/` 保存会话、工具事件和产物；`agent-client/data/` 保存本地分析数据。这些是每位开发者自己的运行状态，均被忽略，不应用于功能同步或测试基线。

工具缓存也按 workspace 隔离：`<workspace>/.cache/{pip,uv,xdg}`（登录版为每个用户的 `users/<id>/.cache/`）。shell、后台任务和 Python 内核会设置 `PIP_CACHE_DIR`、`UV_CACHE_DIR`、`XDG_CACHE_HOME`，所以 `pip`/`uv` 和 XDG 工具的缓存不会写进共享的 `~/.cache`。`npm` 仍使用 `~/.npm`。

磁盘使用由 `scripts/check-disk-usage.sh` 每 30 分钟检查（system crontab）：`/` 或 `/data` 超过阈值、或 `~/.cache` 超过 5 GiB 时，写入 `~/.local/state/bioagent/disk-alert.log` 并记 syslog；设置 `BIOFLOW_DISK_ALERT_WEBHOOK` 可同时 POST 到聊天 webhook。阈值用 `BIOFLOW_DISK_WARN_PERCENT`、`BIOFLOW_DISK_CRIT_PERCENT`、`BIOFLOW_CACHE_WARN_GIB` 覆盖，手动检查用 `--test`。

项目依赖默认装进 `<project>/.venv`：开启 `BIOFLOW_PROJECT_VENV=1` 且配置 `BIOAGENT_ENV_BIN` 后，shell、后台任务和 `execute_python` 都会使用项目 venv；venv 用 `--system-site-packages` 从共享主环境创建，基础包直接可见，额外的 `pip`/`uv` 安装只写入项目。`R_LIBS_USER` 指向 `<project>/.Rlib`。关闭开关即回到原来的共享解释器行为。

`backend/config/`、`skills/`、`knowledgebase/` 和 `toollibrary/` 是共享源码。修改其中内容会改变其他开发者启动后的行为：

1. 对 `agents.json` 的绑定、`llm.json` 模型和 `mcp.json` 工具变更，说明新增/移除的环境变量。
2. 新增提示词时，创建单独的 Markdown 文件，并通过 `agents.json` 的 `promptFile` 引用。
3. 新增 Skill 时，直接在 `skills/` 根目录放一个稳定目录名与 `SKILL.md`（不再有子目录分组）；需要的数据、脚本和引用资料一并放入该 Skill 的 `resources/`。
4. 新增知识库条目时，在 `knowledgebase/skill.md` 补一行领域索引（仅在新增领域时），并在条目 `skill.md` 的 frontmatter 写 `name`/`description`；正文 ≤28 000 字符，可执行脚本不得放入知识库，运行 `npm --prefix backend test` 会校验内容契约。
5. 新增能力库条目时，把 skill 或 MCP 工具写进对应领域 `index.md`，并在根 `index.md` 登记领域描述；配置变更后保持展示层同步。
6. 不把会话文件、下载数据、访问令牌或本地绝对路径放入共享配置。

## 依赖更新

Node 依赖以各包目录的 `package.json` 和 `package-lock.json` 为准。变更依赖后，在对应目录运行 `npm install --package-lock-only` 并提交两者。

Python/R 环境由根目录 `environment.yml` 声明，Python 直接依赖固定在 `requirements.txt`。升级分析库时，同时更新这两个文件；重建环境后运行相关分析和后端测试。`.bioenv/` 是生成目录，不能作为依赖声明提交。
