# MCP 机制

> 基线：`e66665e`（`refactor: migrate doc-only skills into the skillbook`）
> 范围：`agent-client/backend/src/agent/mcp_manager.ts`、`types.ts` 的 MCP/catalog 类型、`config/mcp_config_store.ts`、`config/secret_config.ts`、`config/environment_file_store.ts`、`agent_runtime.ts` 的连接与装配段、`runtime_tool_dispatcher.ts` 的 `toolload` MCP 分支与 MCP 透传分支、`security_policy.ts` 的 MCP 风险兜底、`http/routes/{settings,config_manage,config_files}.ts`、`agent-client/web/src/components/settings/McpSettings.jsx`、`agent-client/bin/bioflow.mjs` 的 `mcp` 子命令，以及 `backend/config/mcp.json` 与 `agent-client/.env.example`。
> 本文描述**当前实现事实**，用于新增 / 绑定 / 调试 MCP server 前的第一事实来源核对；文中标注了已知设计缺口。
> MCP 的加载入口是 CoreTool `toolload` 的 `id` / `resource` 两个分支（`toollibrary` 负责浏览展示层），见 [`toollibrary-mechanism.md`](toollibrary-mechanism.md)；MCP 工具加载结果如何进入 run 上下文与压缩载荷见 [`context-mechanism.md`](context-mechanism.md) §八；每轮主循环何时拉起连接见 [`agent-loop.md`](agent-loop.md)。本文按**磁盘契约 → 凭据 → 连接生命周期 → 能力发现 → 展示层与按需加载 → 执行 → 观测 → 管理面**补齐其未展开的机制。

## 一、结论速览

- MCP server 的唯一定义源是磁盘上的 `backend/config/mcp.json`（`{ "servers": [...] }`）。运行时按需 `fs` 读取 + 解析，**不落库、不缓存**（`mcp_config_store.ts:87-95`）。
- 每个 run（即每条用户消息）开头都会调用一次 `mcpManager.connectServers(request.mcpServers)`，并先向 SSE 流发出 `mcp_status` 事件（`agent_runtime.ts:158-164`）。
- 进入 run 的 server 集合 = 主 agent 的 `mcpServerIds` **∩** `enabled === true`（`agent_context_resolver.ts:171-176`）。悬空 id 与停用 server 被**静默丢弃**，不报错、不告警。
- MCP 会话按 server **`name`** 索引（不是 `id`），在同一后端进程内**跨 run 复用**；只有配置键（transport/command/args/url/env/headers）变化才断开重连（`mcp_manager.ts:222-260`、`:341-350`）。
- MCP 工具 schema **不预注入**模型。每轮 `tools` 只含 CoreTools（含 `toollibrary`/`toolload`；`history_lookup` 已于 2026-11-01 临时下线）；某个 MCP 工具的 schema 必须由模型先调用 `toolload({id})` 才会进入**下一轮**的 `tools`（`agent_runtime.ts` 的装配段、`addTools`）。
- **常驻的只有展示层索引**：`toollibrary` 的 description 是静态文本；MCP 工具以 name/description 形式列在 `agent-client/toollibrary/<领域>/index.md` 里，由模型按需调用 `toollibrary(domain)` 读取。旧 `<mcp_catalog>` 与 `capability_catalog.ts` 已删除。
- server instructions 仍在连接后采集（SDK 的 `getInstructions()`），但**不再渲染进任何常驻文本**；展示层只列人工维护的工具 name/description。
- 但"先加载再调用"只在**提示词层**成立：`RuntimeToolDispatcher.execute` 对任何不匹配 `toollibrary` / `toolload` / CoreTool 的工具名都直接透传给 MCP 执行，运行时**不校验**该工具是否被加载过。
- 工具对模型的公开名由 `publicToolName` 生成：`${serverName}__${toolName}` 经 `[^A-Za-z0-9_-]` 净化后，**重复下划线会被压成单个**，所以实际名形如 `tavily_tavily_search`、`context7_resolve-library-id`；超过 64 字符时截断为 `base.slice(0,55)_<sha1 前 8 位>`（`mcp_manager.ts:352-357`）。展示层文件与 `toolload` 的 id 都用这个实际公开名。
- 凭据只以 `${ENV_VAR}` 形式写入 `mcp.json`；Web/CLI/导入 API 收到明文时，会转存到本地环境文件并只保存变量引用（`mcp_config_store.ts:144-159`、`environment_file_store.ts:15-40`）。
- MCP 工具的**风险等级恒为 `unknown`**（无 provider-declared 元数据），因此 approval 模式必然弹审批，auto 模式交给独立分类模型，只有 unrestricted 模式直接放行（`security_policy.ts:49-56`）。
- prompts 会被**发现并计数**（出现在 `mcp_status.connected` 中），但**从不暴露给模型**：`getPrompt` 全仓无调用方。resources 则已接线：清单与正文都经 `toolload` 的 `resource` / `server` 参数按需获取。
- **加载不再触发审批**：加载走 `toolload`（所属注册条目 `risk: 'read_only'` → 任何模式直接放行）；MCP 工具**执行**仍是 `unknown`，approval 模式照常弹审批。
- 单个 server 连接失败**不阻断 run**：失败项进 `mcp_status.failed`，本轮其余工具照常可用（`agent_runtime.ts:158-169`）。
- 当前共享配置启用 6 个 server：`tavily`（`https://mcp.tavily.com/mcp/?tavilyApiKey=${BIOFLOW_TAVILY_API_KEY}`）、`exa`（`https://mcp.exa.ai/mcp`，header `x-api-key: ${BIOFLOW_MCP_EXA_X_API_KEY}`）、`context7`（`https://mcp.context7.com/mcp`，header `CONTEXT7_API_KEY: ${BIOFLOW_MCP_CONTEXT7_API_KEY}`）、`biocontext`（`https://biocontext-kb.fastmcp.app/mcp`，只读、无需密钥）四者走托管 streamableHttp；`biomcp`（stdio，Rust 单二进制，MCP 面 7 tool）与 `tooluniverse`（stdio，compact 模式，5 个发现/执行 tool）需要本机安装（`uv tool install biomcp-cli` / `uv tool install tooluniverse==1.5.7`）。另预置 `chatspatial`（stdio，重依赖、60s 超时风险）与 `seqera`（托管 streamableHttp，需 PAT）但 `enabled:false`。其中 `tavily`、`exa` 标记 `internal: true`（内置 `web_search` 的 provider，工具与资源不进入 Tool Library）。缺对应变量或二进制时该 server 连接失败但后端仍可启动；`biomcp`/`tooluniverse` 通过 `bash -c 'export PATH="$HOME/.local/bin:$PATH"; exec …'` 启动，避免后端进程 PATH 不含 `~/.local/bin`。

## 二、四个「MCP」定义域

讨论 MCP 时必须先区分四个载体，它们的失效模式完全不同：

| # | 载体 | 位置 | 谁写 | 谁读 | 失效表现 |
| --- | --- | --- | --- | --- | --- |
| ① | `mcp.json` server 定义 | `backend/config/mcp.json`（或 `BIOFLOW_CONFIG_DIR`） | Web 导入 API、CLI、手改 | `getAllMCPServers()` | 文件缺失 → 无 server；JSON 非法 → 启动期 `JSON.parse` 抛错 |
| ② | Agent 绑定 `mcpServerIds` | `backend/config/agents.json` | `PUT /api/config/manage/agents/:id`、删除 server 时的 `removeMCPServerReferences` | `resolveAgentMcpServers` | 悬空 id / 已停用 server → 该 server 对该 agent 无效，但 id 仍留在文件里 |
| ③ | 进程内会话 | `mcpManager` 单例的 `sessions` Map | `connectServers` | `executeTool`、`disconnectServer` | 连接失败 → 只进 `failed`，run 继续；进程退出 → 全部关闭 |
| ④ | 每 run 工具快照 | `AgentChatRequest.mcpServers` + 模型 `tools` 数组 | `agent_service.ts:227` 从 ①∩② 投影；`addTools` 追加已加载工具 | `connectServers`、`toolload` | 只影响本 run，不落盘 |

关键推论：**① 是唯一真相来源**，②③④ 都是投影。因此「Web 设置页看不到某个 server」通常不是 UI 问题，而是 ① 里 `enabled: false`、或 ② 的 `mcpServerIds` 没绑定它（`McpSettings.jsx:60-73` 只渲染 `settings.mcpServers` 快照）。

## 三、磁盘契约：`mcp.json`

### 3.1 文件形态与容错读取

共享配置默认落在 `agent-client/backend/config/mcp.json`，可用 `BIOFLOW_CONFIG_DIR` 整体替换（`backend_config_loader.ts:11-12`）。文件形态与当前内容：

```json
{
  "servers": [
    {
      "id": "tavily",
      "name": "tavily",
      "description": "",
      "command": "",
      "args": [],
      "env": {},
      "transportType": "streamableHttp",
      "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=${BIOFLOW_TAVILY_API_KEY}",
      "headers": {},
      "enabled": true,
      "internal": true
    },
    {
      "id": "exa",
      "name": "exa",
      "description": "",
      "command": "",
      "args": [],
      "env": {},
      "transportType": "streamableHttp",
      "url": "https://mcp.exa.ai/mcp",
      "headers": {
        "x-api-key": "${BIOFLOW_MCP_EXA_X_API_KEY}"
      },
      "enabled": true,
      "internal": true
    },
    {
      "id": "context7",
      "name": "context7",
      "description": "",
      "command": "",
      "args": [],
      "env": {},
      "transportType": "streamableHttp",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "${BIOFLOW_MCP_CONTEXT7_API_KEY}"
      },
      "enabled": true
    }
  ]
}
```

> 2026-10-20：共享配置在默认 3 个托管 server 之外新增 `biomcp`（stdio，启用）与 `tooluniverse`（stdio，启用），并预置 `chatspatial`（stdio，`enabled:false`）与 `seqera`（streamableHttp，需 PAT，`enabled:false`）；字段结构不变，完整内容以 `backend/config/mcp.json` 为准。
>
> 2026-10-21：`tavily` 与 `exa` 增加 `internal: true`。它们只是内置 CoreTool `web_search` 的 provider：连接与 fan-out 行为不变，但工具与 MCP 资源不再进入 Tool Library，也不能被 `toolload` 单独装载。

读取端刻意宽容（`mcp_config_store.ts:87-91`）：

```ts
function all(): MCPServer[] {
  const raw = readConfig('mcp.json');
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : [];
  return items.filter(isRecord).map(canonicalServer);
}
```

即**顶层数组**与 `{ servers: [...] }` 都接受，其余形态退化为空列表。写回永远是 `{ servers: [...] }`（`:93-95`）。启动期 `loadBackendConfig` 只做 `JSON.parse` 语法校验，不校验 schema（`backend_config_loader.ts:29-38`）；schema 校验发生在**写路径**（见 §3.5）。

### 3.2 字段规范化（`canonicalServer`）

每个 server 读入时都会过一遍 `canonicalServer`（`mcp_config_store.ts:115-133`）：

| 字段 | 规则 | 备注 |
| --- | --- | --- |
| `id` | `raw.id \|\| raw.name`（字符串化） | **CLI 与 Web 导入的常见路径下 `id === name`**，但两者可以不同 |
| `name` | `raw.name ?? raw.id`，trim | 同时用作会话键与公开工具名前缀 |
| `command` / `url` / `description` | 字符串化，缺省 `''` | stdio 必须有 `command`，非 stdio 必须有 `url`，检查在连接期 |
| `args` | 数组，逐项字符串化（数字 `1` → `"1"`） | `config_manage_store_boundary.test.ts:98-111` 固化了这一行为 |
| `env` / `headers` | `Record<string,string>`，逐值字符串化 | 非对象一律变 `{}` |
| `transportType` | `stdio` \| `sse` \| `streamableHttp`；缺省时「有 `url` → `sse`，否则 `stdio`」 | 其它值直接抛错 |
| `enabled` | 仅 `false` 视为停用 | 缺省启用 |
| `internal` | 仅 `true` 视为运行时内部 server | 只服务内置工具（当前 `web_search`）的 provider；工具与资源不进入 `toollibrary` / `toolload` |
| `createdAt` / `updatedAt` | 字符串，`createMCPServer` 时写入 ISO 时间 | 读取路径不校验 |

`transportType` 归一化（`:161-165`）是**唯一会在读取路径抛错**的字段：手写错一个值，整个 `getAllMCPServers()` 都会失败。

### 3.3 导入格式

`parseMCPImport` 接受四种常见形态（`mcp_config_store.ts:97-113`）：

```ts
Array.isArray(parsed)                 // [ {...}, {...} ]
  ? parsed
  : isRecord(parsed) && isRecord(parsed.mcpServers)   // Claude Desktop 风格 { "mcpServers": { "name": {...} } }
    ? Object.entries(parsed.mcpServers).map(([name, value]) => ({ name, ...value }))
    : isRecord(parsed) && Array.isArray(parsed.servers) // 本仓原生形态
      ? parsed.servers
      : isRecord(parsed) ? [parsed] : [];               // 单个对象
```

`mcpServers` 映射形态会把 key 当 `name` 注入，因此 `id` 缺省等于该 key。**没有 `name` 即报错** `MCP server requires a name.`（`:110`）。导入按 `id` 做合并：同 id 更新并保留原 `createdAt`，其它已有 server 保留（`:71-84`），这与 Web 弹窗文案「导入的同名连接会更新，其他现有连接会保留」一致（`McpSettings.jsx:81`）。

### 3.4 三种 transport

`MCPServerSession.createTransport`（`mcp_manager.ts:92-118`）按 `transportType` 构造 SDK transport：

| 类型 | 必填 | 实现 | 注入点 |
| --- | --- | --- | --- |
| `stdio` | `command` | `StdioClientTransport` | `command`/`args` 逐个插值；`env: { ...process.env, ...插值后的 config.env }`（子进程继承后端环境） |
| `sse` | `url` | `SSEClientTransport` | `requestInit.headers` + `eventSourceInit.fetch` 包装（GET 与 POST 都带 headers） |
| `streamableHttp` | `url` | `StreamableHTTPClientTransport` | 仅 `requestInit.headers` |

非以上类型在构造期抛 `Unsupported transport type`（`:117`），但 `canonicalServer` 已先一步拦截，因此实际不可达。

### 3.5 校验边界：写路径严、读路径宽

`assertValidServer` 只被 `createMCPServer` / `updateMCPServer` / `replaceMCPServers` / `importMCPServers` 调用（`:35`、`:47`、`:63`、`:81`），检查两件事（`:135-138`）：`id` 与 `name` 非空；`assertSecretReferences` 未发现明文凭据。读取路径 `all()` **不做任何校验**——手改 `mcp.json` 写入明文 key 会被直接使用，直到下一次写操作才被拒绝。

## 四、凭据边界

### 4.1 `${ENV_VAR}` 引用

`mcp.json` 中所有字符串都可以用 `${NAME}` 插值，插值发生在**连接期**（不是读取期）：

```ts
// secret_config.ts:9-14
return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_placeholder, name: string) => {
  const resolved = environment[name];
  if (resolved === undefined) throw new Error(`${source} requires environment variable ${name}`);
  return resolved;
});
```

对应到 MCP 的四个插值点：`command`、每个 `arg`、`url`、`env`/`headers` 的每个值（`mcp_manager.ts:26-28`、`:96-104`）。**变量缺失不是「留空」而是抛错**，最终表现为该 server 连接失败（见 §5.3）。

环境变量本身来自 `backend/.env`（或 `BIOFLOW_ENV_FILE`）：进程入口先 `dotenv` 加载，再跑其余初始化（`index.ts:1-5`）：

```ts
loadDotenv({ path: getEnvironmentFilePath() });
```

### 4.2 写边界：明文进、引用出

三个写入口（Web 导入、`PUT` 之前的 `createMCPServer`/`updateMCPServer`、CLI `mcp add`）共用同一策略：**只要 key 命中 `/key|token|secret|password|authorization/i` 且值是非空明文，就转存环境文件，JSON 里只留引用**；空值与已是 `${VAR}` 的值原样保留（`mcp_config_store.ts:144-159`、`:154`）：

```ts
const variableName = mcpCredentialEnvironmentName(serverId, key); // BIOFLOW_MCP_<SERVER>_<FIELD>
persistEnvironmentSecret(variableName, value);
return [key, '${' + variableName + '}'];
```

变量名由 server `id` 与字段名净化大写拼成（`environment_file_store.ts:15-18`），所以 `env.TAVILY_API_KEY` 在 id 为 `unsafe-mcp` 时写成 `${BIOFLOW_MCP_UNSAFE_MCP_TEST_API_KEY}`——`secret_exposure.test.ts:69-72` 固化了这一点。写环境文件是**原子替换 + `0600` 权限**，并同步写 `process.env` 使当前进程立即可用（`environment_file_store.ts:24-40`）。

反向约束：非引用形态的明文凭据在 `assertSecretReferences` 处被拒绝（`secret_config.ts:20-34`），错误信息形如 `MCP configuration.servers[0].env.TAVILY_API_KEY must use an environment variable reference such as ${BIOFLOW_LLM_API_KEY}.`。

### 4.3 读面遮蔽

- `GET /api/settings` 返回的 server 列表经 `maskMcpSecrets`：只对**命中同一密钥正则的 key** 调 `maskSecret`（长度 ≤ 8 全掩、否则 `abc...xyz`），非密钥 key 原样返回（`settings.ts:149-162`、`secret_config.ts:36-40`）。
- 配置文件浏览器对 `llm.json` 与 `mcp.json` 一律 **403**（`config_files.ts:139-143`），`secret_exposure.test.ts:64-65` 覆盖。
- 但 `local`/`user` scope 的 CLI 配置目录（`.bioflow/config/`、`$XDG_CONFIG_HOME/bioflow/`）不在配置文件浏览器根内，也不在 `.gitignore` 覆盖范围内——CLI 把它们当本地状态（见 §10.3）。

### 4.4 连接期插值失败的后果

因为插值在 `start()` 内、`start()` 被 `try/catch` 包住（`mcp_manager.ts:250-256`），缺失变量只会让该 server 进 `failed` 列表，错误文本会带上 `Configuration requires environment variable …`（`mcp_manager.interpolateEnvironment` 默认 `source='Configuration'`）。这就是「没配 `BIOFLOW_TAVILY_API_KEY` 也能启动后端」的原因，也是 `.env.example` 把它标注为「默认 MCP 启用时必需」的原因。

## 五、连接生命周期

### 5.1 每个 run 同步一次

`connectServers` 是**全量同步**语义（`mcp_manager.ts:222-260`）：

1. `wanted = new Set(configs.map(c => c.name))`；不在 wanted 里的既有会话 `disconnectServer` 并记入 `disconnected`。
2. 逐个 config：
   - 已有同名且 `connected` 的会话，且 `configKey` 未变 → 直接 `registerSessionCapabilities` 复用（不重启子进程）。
   - `configKey` 变了 → 先 `disconnectServer`，再新建会话。
   - 无既有会话 → `new MCPServerSession` → `start()` → 注册能力。
   - `start()` 抛错 → 该 server 进 `failed`，循环继续。
3. 返回 `{ tools, toolCatalog, connected, failed, disconnected }`。

`configKey` 覆盖 transport/command/args/url/env/headers 六项，其中 env/headers 用 `stableJson` 排序 key 后序列化（`mcp_manager.ts:341-350`、`:18-20`），所以**仅调整 key 顺序不会触发重连**。

推论：session 的键是 `name`，**不是 `id`**。同一个 `mcp.json` 里出现两个同名 server 时（`id` 不同但 `name` 相同），后一项会在 `sessions` Map 中覆盖前一项的会话：配置相同的两项会被 `registerSessionCapabilities` 重复执行一次（目录与 OpenAI schema 里出现重复条目），配置不同的两项则先断后连。`id` 只用于 `agents.json` 绑定与凭据变量命名。

### 5.2 跨 run 复用与进程边界

会话存在 `mcpManager` 单例内（`mcp_manager.ts:373`），而后端进程由单实例锁保证唯一（`http/server.ts` 的 `acquireSingleInstanceLock`）。因此：

- 同一进程内，连续多轮对话**只连接一次**（首轮），后续 run 命中 `configKey` 相等分支；
- 后端重启后，所有 stdio 子进程（如 `npx tavily-mcp`）随之重建；
- 每个 run 仍会重新调用 `connectServers`，所以**改 `mcp.json` 后无需重启后端**，下一次发消息即生效。

### 5.3 失败、超时与状态事件

| 阶段 | 超时 | 失败表现 |
| --- | --- | --- |
| `client.connect(transport)` | `MCP_CONNECT_TIMEOUT_MS = 15_000`（`mcp_manager.ts:24`、`:77-81`） | `Connection to '<name>' timed out after 15s`；`connected=false`、`error` 记录、`await this.stop()` 关掉 transport |
| `client.callTool` | 默认 `60_000`（`:169-175`） | `Tool '<tool>' timed out after 60s on '<name>'` 抛出，由 run 的工具结果路径捕获 |
| `listTools` | 无显式超时 | 异常冒泡到 `connectServers` 的 `catch`，该 server 进 `failed` |

`mcp_lifecycle.test.ts` 覆盖两条：空列表也会同步会话并发出 `mcp_status`（含 `disconnected: ['stale-server']`）；不响应的子进程在 `50ms` 超时后 `connected === false`。

### 5.4 退出清理

`shutdown` 流程显式 `await mcpManager.cleanup()`，逐个 `disconnectServer`（`mcp_manager.ts:321-325`），再清理分析内核、释放单实例锁、`process.exit(0)`（`http/server.ts:82-85`）。`MCPServerSession.stop()` 会 `transport.close()` 并清空 tools/prompts/resources 缓存（`mcp_manager.ts:206-214`）。

## 六、能力发现与工具注册

### 6.1 三个能力族

`registerSessionCapabilities` 并发拉取三族能力（`mcp_manager.ts:262-299`）：

| 能力 | 发现方法 | 缓存 | 是否进模型 | 计数落点 |
| --- | --- | --- | --- | --- |
| tools | `listTools` | `this.tools`（`refresh` 可强制刷新） | **展示层按需**（`toollibrary` 读取领域文件里的 name/description），**schema 按需**（`toolload({id})`） | `connected[].tools_count` |
| prompts | `listPrompts` | 失败即 `[]` | **否** | `connected[].prompts_count` |
| resources | `listResources` | 失败即 `[]` | **清单与正文都按需**（`toolload({server})` / `toolload({resource})`） | `connected[].resources_count` |

prompts 的读取入口 `getPrompt()` 在全仓**没有任何调用方**——MCP 的 prompt 能力目前只有「发现 + 计数」的可见性，模型侧无对应工具（**显式决策**，非遗漏）。resources 已接线：`MCPManager.readResource(server, uri)` 转发到会话的 `readResource`，由 `toolload` 的 `resource` 分支调用。`initialize` 返回的 instructions 仍被采集（`getInstructions()`），但不再渲染进任何常驻文本。

### 6.2 公开工具名规则

```ts
// mcp_manager.ts:352-357
const base = `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'mcp_tool';
if (base.length <= 64) return base;
const digest = crypto.createHash('sha1').update(`${serverName}:${toolName}`).digest('hex').slice(0, 8);
return `${base.slice(0, 55)}_${digest}`;
```

注意 `replace(/_+/g, '_')` 会把模板里的 `__` 压成一个，**实际公开名是 `tavily_tavily_search` 这类单下划线形态**（展示层文件与 `toolload` 都以此为准）。三张 Map 记录映射（`mcp_manager.ts:219-220`）：

- `toolToServer: publicName → serverName`
- `publicToolToMcpTool: publicName → 原始 toolName`
- `mcpToolsByName: publicName → OpenAI tool schema`（在 `agent_runtime.ts:156-169` 组装）

`removeToolRoutesForServer` 在重连/断连时先清掉旧映射（`:327-334`），因此同名工具不会残留指向上一个会话的路由。

### 6.3 OpenAI schema 形态

注册时同时生成两份表示（`mcp_manager.ts` 的 `registerSessionCapabilities`）：`serverCatalog` 条目（`{name, instructions, tools, resources}`，给 `toolload` 做资源解析与运行时校验用）与 `ChatCompletionTool`（给模型真正调用用）。注意 `description` 被加了前缀 `[server.tool]`：

```ts
openaiTools.push({
  type: 'function',
  function: {
    name: publicName,
    description: `[${session.name}.${tool.name}] ${tool.description || `Tool from ${session.name}`}`,
    parameters: tool.inputSchema as any,
  },
});
```

`inputSchema` **原样透传**，不做 JSON Schema 子集收敛；MCP 返回缺省 schema 时兜底为 `{ type: 'object', properties: {} }`（`:127`）。

## 七、模型侧暴露：懒加载展示层 + 按需 schema

### 7.1 常驻什么、按需什么

每轮装配顺序是固定的（`agent_runtime.ts` 装配段）：

```ts
addTools(buildResidentTools(agent.coreToolIds));
```

即 **Agent 已配置的 CoreTools 预加载（`coreToolIds` 为空则不注入），MCP 工具零预加载**；工具描述也不再随连接内容动态生成。`addTools` 用 `loadedToolNames` 去重，MCP 工具的 schema 只能通过 `toolload({id})` 成功返回进入 `tools`，并在**下一轮**才可见。

### 7.2 展示层：MCP 工具怎么被模型看到

- 每个当前 agent 已连接（`mcpServerIds` ∩ `enabled`）的 server 的工具，应当出现在 `agent-client/toollibrary/<领域>/index.md` 里，条目形如：

  ```markdown
  - Tavily 搜索（mcp：tavily_tavily_search）：通用网页搜索…
  ```

- L1 领域索引由 system prompt 的 `<tool_library_domains>` 段预注入（静态策展视图，不含实时工具计数）；模型从该段选域后调用 `toollibrary(domain)` 拿该领域的工具清单（name / kind / id / description）。无参 `toollibrary()` 仅为 fallback。
- `internal: true` 的 server 是例外：它们只服务内置 `web_search`，工具与 MCP 资源都不进展示层，也不能被 `toolload` 装载；当前 `tavily` / `exa` 即此类。过滤发生在 `RuntimeToolDispatcher.toolLibrarySnapshot()`，连接与 `web_search` 执行仍使用完整的 server 集合。
- 条目由人维护：server 新增工具不会自动出现在展示层；运行时也不会因为某个已连接工具没被列出而拒绝执行它（§7.4）。漂移靠 `toollibrary` 的 `unknown_tool` / `unlisted_tool` warning 与内容契约测试兜底。
- 资源不进展示层：模型用 `toolload({server})` 列出某 server 的资源，用 `toolload({resource, server?})` 读取正文。

### 7.3 `toolload` 的分支与结果契约

`RuntimeToolDispatcher.executeToolLibrary` 按参数分派（`id` 与 `resource`/`server` 互斥）：

| 分支 | 参数 | 成功返回 |
| --- | --- | --- |
| MCP 工具 schema | `id`（公开名） | `{ok:true,action:'mcp_tool',id,loaded,alreadyLoaded}` |
| MCP 资源清单 | `server`（省略 `resource`） | `{ok:true,action:'mcp_resource',server,resources:[…]}` |
| MCP 资源正文 | `resource`（可选 `server`） | `{ok:true,action:'mcp_resource',server,uri,content}` |
| Skill 正文 | `id`（skill id） | `{ok:true,action:'skill',skillId,skillName,content}` |

要点：

- `mcp_tool` 分支**只登记 schema，从不执行远端工具**；重复加载返回 `alreadyLoaded: true`；未知 id 返回 `ok:false` 并提示回 `toollibrary` 目录找精确名。
- `mcp_resource` 的读取经 `MCPManager.readResource(server, uri)`；同一 URI 存在于多个 server 且未显式传 `server` 时报错要求消歧；读取失败把会话返回的 `{error}` 原样透传成 `ok:false`。
- 资源正文与其它工具结果走**同一条** `createObservation` 流水线；`toolload` 的内联预算是 70 000 字符，超过才落盘 + 摘要 + 指针。
- `runtime_tool_dispatcher.test.ts` 固化「只推 schema、不执行 MCP 工具」与资源/参数互斥等失败路径。

### 7.4 dispatcher 路由与「未加载也能执行」

`RuntimeToolDispatcher.execute` 是工具的唯一分派点：

```ts
if (isToolLibraryCoreTool(toolName)) return this.executeToolLibrary(toolName, args);
if (isCoreToolCall(toolName)) return this.executeCoreTool(toolName, args);
return { result: await this.options.manager.executeTool(toolName, args), events: [] };
```

最后一行是关键：任何**不属于** `toollibrary` / `toolload` / CoreTool 的名字都会直接送进 `mcpManager.executeTool`。配合 §6.2 的公开名映射，模型只要猜中 `server_tool` 就能调用，无需先加载 schema。「先加载再调用」因此是**提示词约定 + schema 可见性约束**，不是运行时强制（§十二 缺口 1）。

## 八、执行路径与结果契约

### 8.1 调用链

```text
LLM 返回 tool_calls
  └─ agent_runtime.ts:450  assessRuntimeToolSecurity(...)        // 见 §8.4
  └─ agent_runtime.ts:492  toolDispatcher.execute(name, args)
       └─ runtime_tool_dispatcher.ts:38  manager.executeTool(publicName, args)
            └─ mcp_manager.ts:301-306  查 toolToServer → session.callTool(原始 toolName, args)
                 └─ mcp_manager.ts:169-182  client.callTool(...) → contentToText(...)
  └─ agent_runtime.ts:203-244  finalizeToolResult(...)            // 观测 + 失败守卫
```

`executeTool` 找不到路由时返回字符串 `Error: Tool '<name>' not found on any connected server`（`mcp_manager.ts:304`），不会抛异常。

### 8.2 结果 → 文本

`MCPTool` 的原始 `content` 数组被压缩成纯文本（`mcp_manager.ts:30-47`）：

| content 类型 | 模型看到的内容 |
| --- | --- |
| `text` | 原文 |
| `image` | `[image: <mimeType>]`（**不带 data**，模型看不到图） |
| `audio` | `[audio: <mimeType>]` |
| `resource`（内嵌 text） | 内嵌 text |
| `resource`（blob） | `[resource blob: <mimeType>]` |
| `resource_link` | `[resource: <uri>]` |

`isError: true` 时统一前缀成 `Error: tool '<tool>' reported failure: <text>`（`:176-180`）；非 `content` 形态整体 `JSON.stringify`（`:181`）。

### 8.3 失败守卫

工具结果统一走 `pushToolResult` → `ToolFailureTracker`（`agent_runtime.ts:184-201`）。判定器对「纯文本错误」有专门兜底，因为 MCP 常见返回非 JSON 文本：

```ts
// tool_failure_guard.ts:36-45
try { … return value.ok === false || value.isError === true || typeof value.error === 'string'; }
catch { /* MCP tool errors are commonly returned as plain text rather than JSON. */ }
return /^error\s*:/i.test(result.trim());
```

因此 `§8.2` 的 `Error: tool '…' reported failure: …` 前缀正好命中这条正则：**同一 MCP 工具连续失败 3 次**注入 `loop_health` 警告（`repeated_tool_failure`），**连续 10 次**抛 `RepeatedToolFailureError` 终止 run。成功一次即清零该工具的计数。

### 8.4 安全审批

风险判定对 MCP 工具没有专门分级（`security_policy.ts:49-56`）：

```ts
const coreToolRisk = getCoreToolRisk(toolName);
if (coreToolRisk === 'shell') return classifyShellCommand(String(args.cmd || ''));
if (coreToolRisk === 'code_execution') return 'unknown';
if (coreToolRisk) return coreToolRisk;
// MCP tools can mutate remote or local state. Without provider-declared
// metadata, an explicit confirmation is safer than assuming they are reads.
return 'unknown';
```

三种模式的后果（`security_policy.ts:20-42`）：

| `securityMode` | MCP 工具**执行** | `toolload`（`read_only`，含 MCP 加载） |
| --- | --- | --- |
| `unrestricted` | 直接放行 | 直接放行 |
| `auto` | `decision='classify'` → 交给独立分类模型（`runtime_security_gate.ts:11-25`） | 直接放行（`read_only` 在 `security_policy.ts` 早退 `allow`） |
| `approval` | `ask` → 弹审批；拒绝则返回 `{ok:false, error:'Operation was not approved by the user.'}` | 直接放行 |

注意：**加载 MCP schema / 读资源不触发审批**（走 `toolload`，所属注册条目 `risk: 'read_only'`）；只有 MCP 工具的**执行**是 `unknown`。

当前五个团队角色都是 `securityMode: "unrestricted"`（`backend/config/agents.json`），所以默认部署下 MCP 调用不弹审批。`classifyAutoToolCall` 的提示词明确把「unknown MCP effects」列入应返回 ask 的情形（`security_classifier.ts:16`）。

## 九、观测与上下文

### 9.1 `mcp_status` 事件

每个 run 的第一个 SSE 事件就是 MCP 状态（`agent_runtime.ts:158-164`）：

```ts
yield {
  type: 'mcp_status',
  connected: result.connected,   // [{ name, tools_count, prompts_count, resources_count }]
  failed: result.failed,         // [{ name, error }]
  disconnected: result.disconnected,
};
```

后端把它落成 run step（`agent_service.ts:458-460`，摘要为 `connected=N, failed=N, disconnected=N`），Web 侧渲染为 trace 条目（`web/src/domain/trace.js:168-180`；`failed>0` 时 `status: 'warning'`）。

### 9.2 `loadedCapabilities`：MCP 加载结果如何进上下文

加载成功的结果会被解析成能力标记，随观测载荷落盘（`agent_runtime.ts` 的 `finalizeToolResult` 与 `getLoadedCapability`）：

```ts
function getLoadedCapability(toolName: string, result: string) {
  if (toolName !== TOOLLOAD_TOOL_NAME) return null;
  const parsed = parseToolArguments(result);
  if (!parsed.ok) return null;
  switch (parsed.action) {
    case 'skill':        return typeof parsed.skillId === 'string' ? { kind: 'skill', id: parsed.skillId } : null;
    case 'mcp_tool':     return typeof parsed.id === 'string' ? { kind: 'mcp', id: parsed.id } : null;
    case 'mcp_resource': return typeof parsed.uri === 'string' ? { kind: 'mcp', id: parsed.uri } : null;
    default:             return null;   // 资源清单不上报
  }
}
```

判定依据是结果里的 `action`，**不是工具名** —— `toolload` 同时承担 skill 与 MCP 两类加载，只看工具名无法区分；`AgentService` 的历史回退解析同时接受旧 transcript 里的 `load_skill`。然后两个消费方各自记录：run 摘要侧 `AgentService.trackLoadedCapability`（同样按 action 判定：`mcp_tool` 记 id、`mcp_resource` 记 uri、`skill` 记 skillId），压缩载荷侧 `buildProgramState` 把 `kind === 'coretool' | 'mcp'` 的 id 合并进 `loadedCapabilitiesRemovedFromContext.coretoolsAndMcp`。也就是说，**被压缩掉的上下文里「哪些 MCP 工具已加载」会被显式保留**，避免压缩后模型重放加载调用。

### 9.3 pinned context 指纹

MCP server 的 `[id, name, description]` 参与 pinned context 指纹的计算（`context_manager.ts` 的 `fingerprintPinnedContext`），该指纹在 checkpoint 复活前被比对（2026-10 起，见 [`context-mechanism.md`](context-mechanism.md) §7.3）。因此改 server 的 `description` 会使同会话已有的旧 checkpoint **失效并被跳过注入**，处置方式见该文档缺口 1。

## 十、管理面

### 10.1 HTTP API

| 方法 | 路径 | 行为 | 副作用 |
| --- | --- | --- | --- |
| `GET` | `/api/settings` | 返回 `mcpServers`（密钥已掩码）+ `coreTools`（`toollibrary`/`knowledgebase` 作为普通 CoreTool 出现）+ `toolLibrary`（按域投影，MCP 条目带所属 `serverId`）+ `knowledgeBase` | 无 |
| `POST` | `/api/config/manage/mcp/import` | `importManagedMCPServers(body.content ?? body)` | 写 `mcp.json`，返回掩码后的 `servers` 与 `changedFiles: ['mcp.json']` |
| `DELETE` | `/api/config/manage/mcp/:id` | 按 `id` 删除 | 写 `mcp.json` + 清理 `agents.json` 引用（`changedFiles: ['mcp.json','agents.json']`） |

注意：**没有单个 server 的 `PUT`**。新增/修改统一走 import 的按 `id` 合并语义（`config_manage.ts:82-99`、`configuration_management_service.ts:52-58`）。删除时 `deleteManagedMCPServer` → `removeMCPServerReferences(id)`，把 `agents.json` 中所有 agent 的该 id 摘掉（`agent_config_store.ts:146-148`）。

`agents.json` 的绑定通过 `PUT /api/config/manage/agents/:id` 白名单字段维护，`mcpServerIds`、`coreToolIds`、`knowledgeEntryIds` 在允许列表内（`config_manage.ts`）。

### 10.2 Web

设置页不再有独立的 MCP 页：`McpSettings.jsx` 已随 2026-11-05 的控制台重构移除，MCP 连接只作为只读条目出现在 **Tool Library** 页（`ToolLibrarySettings.jsx`，数据源为 `GET /api/settings` 的 `toolLibrary` 投影），该页不提供导入/删除。导入与删除仍走 §10.1 的 REST 端点或 §10.3 的 CLI。绑定关系在 Agent 设置页的 **ToolLibrary** 区块勾选：MCP 服务器以工具库领域内的条目形式出现，勾选服务器即启用其全部工具，字段仍为 `mcpServerIds`（`CapabilityChecklists.jsx`，初值见 `fields.jsx` 的 `agentDraft`）。其余前端触点：设置页 tab `['library','Tool Library']`（`constants.js`）、trace 事件渲染（`domain/trace.js` 优先用 `observation.loadedCapability` 判定 MCP，失败时再看 `toolload` 参数）。

### 10.3 CLI：`bioflow mcp`

`agent-client/bin/bioflow.mjs` 提供免 Web 的维护路径（`package.json` 的 `bioflow` 脚本；用法见 `docs/development.md` §MCP 命令行配置）：

```bash
npm run bioflow -- mcp list [--scope project|local|user] [--json] [--show-secrets]
npm run bioflow -- mcp get <name> [--scope project|local|user] [--show-secrets]
npm run bioflow -- mcp add <name> --command <cmd> [--arg a]... [--env NAME=value]...
npm run bioflow -- mcp add <name> --url <url> [--transport sse|streamableHttp] [--header NAME=value]...
npm run bioflow -- mcp remove <name> [--scope project|local|user]
```

Scope 解析（`bioflow.mjs:214-224`）与环境文件落点（`:307-311`）：

| scope | 配置目录（`mcp.json`） | 凭据环境文件 |
| --- | --- | --- |
| `project`（默认） | `agent-client/backend/config/` | `agent-client/backend/.env` |
| `local` | `agent-client/.bioflow/config/` | `agent-client/.bioflow/.env` |
| `user` | `$XDG_CONFIG_HOME/bioflow/`（否则 `~/.config/bioflow/`） | 同目录上层 `.env` |

`--config-dir` 显式覆盖目录；`BIOFLOW_ENV_FILE` 显式覆盖环境文件。CLI 自建 server 时 `id = name`、`transportType = --transport || (url ? 'streamableHttp' : 'stdio')`、`enabled = !--disabled`（`:243-260`），并复用同一套明文转存逻辑（`:280-306`）。`mcp get` 按 `id` **或** `name` 匹配，`mcp add` 对已存在名字直接报错，`mcp remove` 同时按 `id`/`name` 过滤（`:163-187`）。默认 `maskMcpSecrets` 只遮蔽命中密钥正则的 key；`--show-secrets` 显示 JSON 原值，但 CLI 管理的凭据本身在 JSON 里只是引用，**不会读取或打印环境文件里的真实密钥**。

要让后端使用非默认目录，启动时对齐两个变量：

```bash
BIOFLOW_CONFIG_DIR="$PWD/.bioflow/config" BIOFLOW_ENV_FILE="$PWD/.bioflow/.env" npm run bioflow -- start
```

## 十一、测试覆盖

| 测试 | 覆盖的机制点 |
| --- | --- |
| `mcp_lifecycle.test.ts` | 空 server 列表仍同步会话并发 `mcp_status`（含 `disconnected`）；不响应子进程 15s 默认/自定义超时后 `connected === false`；**首轮模型请求只带常驻面**（CoreTools + `toollibrary`/`toolload`，无任何 MCP schema），工具描述不含 `<mcp_catalog>` |
| `runtime_tool_dispatcher.test.ts` | `toolload` 的 MCP schema 登记、skill 正文、资源列清单/读取/失败/URI 无人暴露、id 与 resource 互斥、空参数引导 |
| `toollibrary_executor.test.ts` / `toollibrary_content.test.ts` | 展示层解析与可见性过滤；MCP 条目 id 必须以已配置 server 的公开名前缀出现 |
| `secret_exposure.test.ts` | `GET /api/settings` 与 `/api/settings/reload` 不含明文；`llm.json`/`mcp.json` 文件浏览器 403；import 明文转成 `${BIOFLOW_MCP_UNSAFE_MCP_TEST_API_KEY}` 且环境文件落明文 |
| `config_manage_store_boundary.test.ts` | `{ "mcpServers": { "search": … } }` 导入后的完整字段规范化结果（`args` 数字字符串化、`transportType` 缺省、`headers` 保留引用） |
| `mcp_cli_secrets.test.ts` | CLI `add` 明文 → 引用 + 环境文件；已是 `${VAR}` 时不创建环境文件 |

`npm run test` 在 `agent-client/` 下同时跑 backend 与 web；MCP 相关用例集中在 backend。

## 十二、已知缺口

1. **「先加载再调用」不可强制。** 未加载的 MCP 工具名仍会被 dispatcher 透传执行，因为 OpenAI tool_calls 不受本地 `tools` 数组约束（§7.4）。要收紧需在 dispatcher 前增加「名字 ∈ 本 run 已加载集合」校验。
2. ~~**加载 MCP schema 在 approval 模式同样需要审批。**~~ **已解决**：加载改走 CoreTool `toolload`（所属注册条目 `risk: 'read_only'`），任何模式都直接放行；MCP 工具**执行**仍是 `unknown` → approval 模式照常弹审批。
3. **同名 server 未去重。** 会话与 catalog 都以 `name` 为键（`mcp_manager.ts:223`、`:252`），catalog/OpenAI schema 却按条目 push（`:274-292`）：两个同名同配置条目会产出重复的工具与重复的 `connected` 计数，同名不同配置则后者静默顶掉前者。
4. **公开工具名可能碰撞。** 净化会丢弃 `.`/`/`/CJK 等字符并压缩 `_`，`a/b` 与 `a.b` 会得到同一个公开名，Map 后写覆盖先写（`mcp_manager.ts:219-220`、`:352-357`），且 64 字符超长分支的 sha1 只取 8 位。
5. **prompts 与 resource templates 无出口（显式决策）。** `getPrompt` 全仓无调用方；`listResourceTemplates` 从未实现。resources 的固定清单与正文**已接线**（§6.1、§7.3）。两条都属于「明确不做」，不是遗漏。
6. **图片/音频能力被降级为文本占位。** `contentToText` 只保留 mimeType（`mcp_manager.ts:35-38`），即使模型支持视觉输入也拿不到 `data`。
7. **展示层与真实工具集可能漂移。** 展示层文件由人维护，server 新增/改名工具不会自动同步；`toollibrary` 的 `unknown_tool` warning 只在条目被列出但不可见时触发，**不可见且未列出**的工具不会产生任何提示。
8. ~~**旧的运行时加载工具没有参数兜底之外的保护。**~~ **已解决**：旧的 4-action `load_skill` 已整体删除，`toolload` 按 `id` / `resource` / `server` 互斥分派，缺失或冲突参数直接返回 `ok:false`。
9. **disconnect 通知不可见。** `disconnected` 只在 `mcp_status` 里出现一次，run 摘要与前端均不展示具体 server 名（`agent_service.ts:585-590` 只输出计数）。
10. **本地 scope 的 `.bioflow/` 未被 `.gitignore` 覆盖。** `agent-client/.gitignore` 只忽略 `.env`、`data/`、`workspace/`、`dist/`、`node_modules/`，CLI 的 `local` scope 会新建 `agent-client/.bioflow/config/mcp.json`（`bioflow.mjs:214-224`），存在被误提交的风险。
11. **读路径不校验 schema。** 手改 `mcp.json` 可绕过 `assertSecretReferences` 写入明文凭据（§3.5），且 `transportType` 拼写错误会使 `getAllMCPServers()` 整体抛错、连累所有 server。

## 十三、一手来源索引

| 主题 | 文件 |
| --- | --- |
| 会话、连接、超时、公开名、能力发现 | [`mcp_manager.ts`](../agent-client/backend/src/agent/mcp_manager.ts) |
| MCP 类型定义（`MCPServerConfig`/`MCPConnectResult`/`mcp_status`） | [`types.ts`](../agent-client/backend/src/agent/types.ts) |
| 每 run 连接、装配、失败守卫接线 | [`agent_runtime.ts`](../agent-client/backend/src/agent/agent_runtime.ts) |
| `toolload` 的 MCP 分支 / MCP 透传分派 | [`runtime_tool_dispatcher.ts`](../agent-client/backend/src/agent/runtime_tool_dispatcher.ts) |
| MCP catalog 类型与展示层解析 | [`types.ts`](../agent-client/backend/src/agent/types.ts)、[`toollibrary_executor.ts`](../agent-client/backend/src/agent/core_tools/toollibrary_executor.ts) |
| 磁盘契约、导入、明文转存 | [`mcp_config_store.ts`](../agent-client/backend/src/agent/config/mcp_config_store.ts) |
| `${ENV}` 插值与明文拒绝 | [`secret_config.ts`](../agent-client/backend/src/agent/config/secret_config.ts) |
| 环境文件原子写入与变量命名 | [`environment_file_store.ts`](../agent-client/backend/src/agent/config/environment_file_store.ts) |
| Agent 绑定解析 | [`agent_context_resolver.ts`](../agent-client/backend/src/agent/service/agent_context_resolver.ts:171-176) |
| 删除 server 后的引用清理 | [`agent_config_store.ts`](../agent-client/backend/src/agent/config/agent_config_store.ts:146-148) |
| MCP 风险兜底 `unknown` | [`security_policy.ts`](../agent-client/backend/src/agent/security_policy.ts:49-56) |
| 安全网关闭口 | [`runtime_security_gate.ts`](../agent-client/backend/src/agent/runtime_security_gate.ts) |
| HTTP import / delete / settings / 403 | [`config_manage.ts`](../agent-client/backend/src/http/routes/config_manage.ts:82-99)、[`settings.ts`](../agent-client/backend/src/http/routes/settings.ts:31)、[`config_files.ts`](../agent-client/backend/src/http/routes/config_files.ts:139-143) |
| 进程退出清理 | [`server.ts`](../agent-client/backend/src/http/server.ts:82) |
| Web 设置卡片与导入弹窗 | [`McpSettings.jsx`](../agent-client/web/src/components/settings/McpSettings.jsx) |
| Web trace 渲染 | [`trace.js`](../agent-client/web/src/domain/trace.js:168-180) |
| CLI `mcp` 子命令 | [`bioflow.mjs`](../agent-client/bin/bioflow.mjs:145-190) |
| 默认 server 与必需变量 | [`mcp.json`](../agent-client/backend/config/mcp.json)、[`.env.example`](../agent-client/.env.example)、[`config/README.md`](../agent-client/backend/config/README.md) |
| 测试 | `backend/test/{mcp_lifecycle,runtime_tool_dispatcher,toollibrary_executor,toollibrary_content,secret_exposure,config_manage_store_boundary,mcp_cli_secrets}.test.ts` |
