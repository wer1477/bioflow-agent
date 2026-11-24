# 部署实例

登录鉴权只在部署实例开启；开发实例（`/path/to/bioflow-dev`）不设
`BIOFLOW_AUTH_ENABLED`，继续使用原有会话/项目，不需要登录。

## 目录

| 路径 | 用途 |
| --- | --- |
| `/path/to/bioflow-prod` | 部署代码，`git clone` 自开发仓库；不含运行数据 |
| `/path/to/bioflow-runtime/bioenv` | 只读共享主环境（Python/R/基础生信库），供所有用户和项目 venv 继承 |
| `/path/to/bioflow-prod-data/config` | 运行配置（`agents.json`、`llm.json`、`mcp.json`、`prompts/`） |
| `/path/to/bioflow-prod-data/workspace` | 用户 workspace 根；登录版每用户位于 `users/<userId>/` |
| `/path/to/bioflow-prod-data/auth` | `auth.sqlite` 与 `auth-secret.key`（0600） |
| `/path/to/bioflow-prod-data/server.log` | 服务日志 |

配置目录通过 `BIOFLOW_CONFIG_DIR` 外置，`git pull` 不会覆盖管理员在 Web 里的修改。
首次部署时从仓库复制一份：

```bash
cp -a agent-client/backend/config/. /path/to/bioflow-prod-data/config/
```

## `.env`

部署实例的 `agent-client/backend/.env` 不提交，至少包含：

```dotenv
PORT=3000
BIOFLOW_CONFIG_DIR=/path/to/bioflow-prod-data/config
BIOFLOW_WORKSPACE_DIR=/path/to/bioflow-prod-data/workspace
BIOFLOW_AUTH_ENABLED=1
BIOFLOW_AUTH_DB=/path/to/bioflow-prod-data/auth/auth.sqlite
BIOFLOW_AUTH_ADMIN_EMAILS=<管理员邮箱>
BIOFLOW_AUTH_COOKIE_SECURE=1
BIOFLOW_AUTH_SMTP_HOST=smtp.qq.com
BIOFLOW_AUTH_SMTP_PORT=465
BIOFLOW_AUTH_SMTP_USER=<发件邮箱>
BIOFLOW_AUTH_SMTP_PASS=<授权码>
BIOFLOW_AUTH_MAIL_FROM=<发件邮箱>
BIOFLOW_AUTH_ENCRYPTION_KEY=<32 字节 base64>
BIOFLOW_LLM_API_KEY_DGX=<DGX key>
BIOFLOW_TAVILY_API_KEY=<...>
BIOFLOW_MCP_EXA_X_API_KEY=<...>
BIOFLOW_MCP_CONTEXT7_API_KEY=<...>
BIOFLOW_BIOD_PYTHON=<...>
BIOFLOW_BIOD_REPO=<...>
BIOFLOW_BIOD_CKPT=<...>
BIOAGENT_ENV_BIN=/path/to/bioflow-runtime/bioenv/bin
BIOFLOW_PROJECT_VENV=1
```

`BIOFLOW_AUTH_ENCRYPTION_KEY` 是用户 LLM API key 的加密主密钥；丢失会导致已保存的
用户 key 无法解密。未设置时会在 `auth-secret.key` 自动生成。

## 共享主环境与项目 venv

部署只维护一份主环境，所有用户共享：

```bash
sudo mkdir -p /path/to/bioflow-runtime
sudo rsync -a /path/to/bioflow-dev/.bioenv/ /path/to/bioflow-runtime/bioenv/
sudo /path/to/bioflow-runtime/bioenv/bin/python -m pip check
sudo chown -R root:root /path/to/bioflow-runtime/bioenv
sudo chmod -R a-w /path/to/bioflow-runtime/bioenv
```

- `BIOAGENT_ENV_BIN` 指向这份只读环境的 `bin`；托管只读环境只能读/执行，不能安装。
- 每个项目第一次运行 shell 或 `execute_python` 时，用主环境 Python 创建
  `<project>/.venv`（`--system-site-packages`），基础包来自主环境，额外依赖只写入项目。
- 子进程会设置 `VIRTUAL_ENV`、`PYTHONNOUSERSITE=1`、`PIP_REQUIRE_VIRTUALENV=true`、
  `PIP_USER=0`、`UV_PROJECT_ENVIRONMENT`、`R_LIBS_USER=<project>/.Rlib`。
- 关闭开关：把 `.env` 的 `BIOFLOW_PROJECT_VENV` 改为 `0` 并重启，即回到共享解释器行为。
- 主环境升级 = 重新复制/构建到同一路径，`chown root:root` + `chmod -R a-w`，然后重启部署。

## 构建与启动

```bash
export PATH=$HOME/.nvm/versions/node/v22.12.0/bin:$PATH
cd /path/to/bioflow-prod/agent-client/backend
npm run build
cd ../web && npm run build

screen -dmS bioagent-prod bash -lc \
  'export PATH=$HOME/.nvm/versions/node/v22.12.0/bin:$PATH; \
   cd /path/to/bioflow-prod/agent-client/backend; \
   exec node --experimental-sqlite dist/index.js >> /path/to/bioflow-prod-data/server.log 2>&1'
```

- 入口会先加载 `backend/.env`，再解析 `BIOFLOW_WORKSPACE_DIR` 等模块级路径。
- 该仓库在本机的 `npm install` 曾出现挂起；部署实例复用开发实例的 `node_modules`
  （同机、同 Node 版本）。升级依赖后需要重新同步。
- 重启：`screen -S bioagent-prod -X quit` 后重复启动命令。

## 反向代理

`/etc/nginx/webnginxs/bioagent.conf` 把 `/bioagent/`、`/api/`、`/assets/` 代理到
`127.0.0.1:3000`；对外地址为 `https://bioflow.example.com/bioagent/`。
`/api` 与 `/assets` 是根级路径，供同一域名下其他前端复用。

## frp

`~/frp_0.62.1_linux_amd64/frpc.toml` 的 `transport.tls.enable = true` 加密 the host 与
腾讯云 frps 之间的隧道；修改后重启 `frpc` screen，并用
`curl -I https://bioflow.example.com/bioagent/` 验证；失败时回滚该行。

## 升级

```bash
cd /path/to/bioflow-prod
git pull
# 重新构建 backend/web 后重启 bioagent-prod
```

`config/`、`workspace/`、`auth/`、`.env` 都在仓库外或未跟踪，不会被升级覆盖。
