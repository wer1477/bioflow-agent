# CoreTool 机制

> 基线：`0b50110`（`chore: stop tracking workspace conversation history`）
> 范围：`agent-client/backend/src/agent/core_tools_runtime.ts` 与 `agent-client/backend/src/agent/core_tools/` 下的执行器实现。
> 本文描述**当前实现事实**，用于新增或修改 CoreTool 前的第一事实来源核对；文中标注了已知设计缺口。
> 工具批次分岔、审批挂起、结果降级流水线属于主循环职责，见 [`agent-loop.md`](agent-loop.md)，本文不重复。

## 一、结论速览

- CoreTool 是**进程内、由后端代码实现**的基础工具族：schema 与系统提示片段由**单张注册表**声明，执行收敛到**单一入口函数**。
- 注册表 `CORE_TOOL_REGISTRY` 当前有 **11 条定义、20 个 function schema**（`shell` 3 个、`file` 4 个、`goal` 3 个、`search` 2 个、`toollibrary` 2 个，其余各 1 个）。
- 构建期**无延迟加载**，但**按 Agent 配置注入**：`buildResidentTools(agent.coreToolIds)` 产出该 Agent 显式启用的静态 schema（`agent_runtime.ts` 装配段）；未配置的 CoreTool 既不注入 schema，也不注入 system prompt 片段。只有无 Agent 的直接调用（`undefined`）才回退到 `buildAllCoreTools()`。按需加载只发生在 `toolload`：Skill 正文、MCP 工具 schema 与 MCP 资源；`toollibrary` / `knowledgebase` 的浏览类调用只是只读查询，不装载任何 schema。
  - **例外（2026-11-01）**：`toollibrary` / `knowledgebase` 两个能力族**始终注入**角色上下文（`residentCoreToolIds` 把两个 id 并入任何显式列表），绑定与否只决定选择权：绑定 → 默认交给 biod；未绑定 → 退化为模型自行浏览选择（`biod.status="off"`、`reason="not_configured"`）。biod 失效仍是 fail-open，回到同一浏览路径。
- 执行入口 `executeCoreTool`（`:708-715`）统一做 abort 竞速；实现分支集中在 `executeCoreToolInternal`（`:717-...`）。
- 返回**一律是 JSON 字符串**；失败必须收敛为 `{ ok: false, ... }`，`ToolFailureTracker` 依赖该形态累计连续失败（`tool_failure_guard.ts:18-33`）。
- 注册表同时是**权限元数据的唯一来源**：`risk` 驱动审批（`getCoreToolRisk`，`:662-668` → `security_policy.ts:49-57`），`parallelizable` 驱动批次并行（`isParallelizableCoreTool`，`:676-681`）。
- `toollibrary` / `toolload` / `web_search` 的 schema 在注册表内，但**执行不在本模块**，而在 `RuntimeToolDispatcher`（前两者需要 agent 能力快照，`web_search` 需要已连接的 MCP 会话）——这是一个隐式的顺序依赖（见缺口 6/9）。
- **子 Agent 委派是异步的**：`subagent` 为一个独立会话的子 Agent 起一次完整 run 后立即返回；结果以 `[subagent ...]` 通知在父会话的下一个模型步注入（父 run 已结束时只落库，等下一次 run 读取）。深度、并发、超时与"子级审批不可用"都有默认安全值。
- **长任务与多模态是本轮新增的两条横切能力**：`exec_command(run_in_background=true)` 的任务跨 run 存活（`core_tools/shell_tasks.ts`）；`read_file` 的图片/PDF 页与 `execute_python` 的 figure 以 `image_url` content part 回传模型（`core_tools/image_payload.ts` + `agent_runtime.ts`），不进入 observation/transcript 的文本。

## 二、四类工具的边界

同一轮请求里的工具来自四个互不相同的体系，容易混淆：

| 类别 | 载体 | 注册/声明位置 | 是否延迟加载 schema | 是否可被 Agent 配置 |
| --- | --- | --- | --- | --- |
| **CoreTool** | 后端进程内函数 | `CORE_TOOL_REGISTRY` + `agents.json` 的 `coreToolIds` | 否，每轮注入已配置的 schema | 是，按 `coreToolIds` 绑定（未配置即不加载；`toollibrary` / `knowledgebase` 两个能力族例外，始终注入） |
| 运行时工具 | 后端进程内函数 | `agent_runtime.ts` 硬编码注册 | 否 | 否，注册表注释明确排除 |
| MCP 工具 | 外部进程 / 远端服务 | `backend/config/mcp.json` | 是，先 `toolload({id})` 装载 | 是，按 `mcpServerIds` 绑定 |
| Skill | 说明书文本（`SKILL.md`） | `agent-client/skills/<name>/` | 是，先 `toolload({id})` 读取正文 | 是，按 `skillIds` 绑定 |

运行时工具当前为空：`history_lookup`（按需召回被裁剪的历史）已于 2026-11-01 临时下线，上下文机制重建后再接回；注册点仍是 `agent_runtime.ts` 装配段。Skill 与 MCP 的加载入口统一为 CoreTool `toolload`。

选型规则：**能力需要真实副作用（读写文件、执行进程、发起网络请求）→ CoreTool；能力只是一段给模型看的说明文本 → Skill。**

## 三、注册表结构

```ts
interface CoreToolDefinition {
  id: string;                 // 配置与目录中的稳定标识
  name: string;               // 人类可读名
  description: string;        // 设置页与目录展示
  toolNames: readonly string[];  // 该定义暴露的全部 function name
  buildSchemas: (context) => ChatCompletionTool[];  // 产出 OpenAI function schema
  prompt: string | null;      // 注入 system prompt 的用法说明
  dispatch: 'core_executor' | 'tool_library';  // 执行归属
  risk: CoreToolRisk | ((toolName) => CoreToolRisk);
  parallelizable?: boolean | ((toolName) => boolean);
}
```

来源：`core_tools_runtime.ts:322-332`。`risk` 与 `parallelizable` 支持函数形态，是因为一条定义可以覆盖多个工具名（`file` 定义下 `read_file` 只读、`write_file` 可写）。

### 11 条定义全貌

| id | name | 暴露的工具名 | `risk` | 可并行 | dispatch |
| --- | --- | --- | --- | --- | --- |
| `shell` | Shell | `exec_command`、`shell_output`、`shell_kill` | `exec_command`/`shell_kill` 为 `shell`，`shell_output` 为 `read_only` | 仅 `shell_output` | core_executor |
| `execute_python` | Python Analysis | `execute_python` | `code_execution` | 否 | core_executor |
| `file` | Files | `read_file`、`write_file`、`edit_file`、`apply_patch` | `read_file` 为 `read_only`，其余 `project_write` | 仅 `read_file` | core_executor |
| `search` | Search | `glob`、`grep` | `read_only` | 是 | core_executor |
| `web_fetch` | Web: Fetch URL | `web_fetch` | `network_or_external` | **是** | core_executor |
| `web_search` | Web: Search | `web_search` | `network_or_external` | 否 | **web_search** |
| `planning` | Planning Panel | `planning` | `project_write` | 否 | core_executor |
| `goal` | Goal | `get_goal`、`create_goal`、`update_goal` | `get_goal` 为 `read_only`，其余 `project_write` | 否 | core_executor |
| `toollibrary` | Tool Library: Capabilities | `toollibrary`、`toolload` | `read_only` | 否 | **tool_library** |
| `knowledgebase` | Knowledge Base | `knowledgebase` | `read_only` | 是 | core_executor |
| `subagent` | Subagent | `subagent` | `code_execution` | 否 | core_executor |

来源：`core_tools_runtime.ts` 的注册表。注意 `shell` / `file` / `search` 三条定义有独立 `id`，另外几条**直接复用自己的工具名作为 `id`**——两套命名并存（缺口 4）。

`prompt` 字段不会被无条件使用：只有 **Agent 已配置**的定义才会把它拼进 system prompt（`buildCoreToolsPrompt`，`:519-524`）。

### Agent 配置契约

- **存储**：`agents.json` 的 `coreToolIds` 是该 Agent 唯一的 CoreTool 白名单（`agent_config_store.ts`）。数组内的 id 不做存在性校验，运行时按注册表过滤；显式 `[]` 表示不加载任何 CoreTool——**两个能力族除外**：`residentCoreToolIds()` 会把 `toollibrary` / `knowledgebase` 并进任何显式列表（`core_tools/capability_selection.ts`）。绑定这两个 id 只决定选择权归 biod，不决定工具是否存在。
- **迁移**：旧记录没有 `coreToolIds` 时按「全部已注册 CoreTool」读取（等价于改造前的行为），一旦在设置页保存就写入显式列表；`createAgent` 与 `ensureDefaultAgents` 写入显式空数组。
- **注入**：`AgentContextResolver.resolveCoreTools(agent)` 用同一个 `residentCoreToolIds` 过滤注册表 → `buildResidentTools(ids)` 产出 schema、`buildCoreToolsCatalogPrompt(ids, { capabilitySelection })` 产出 system prompt 片段（能力族按 biod/llm 模式取不同文案）；上下文计价与运行时使用同一列表（`context_manager.ts` 从 `context.coreTools` 取 id）。
- **选择权**：`capabilitySelectionMode(agent.coreToolIds, id)` —— id 在列表里为 `biod`，否则为 `llm`；无 Agent profile 的调用按 `biod` 处理（改造前行为）。
- **防御**：`RuntimeToolDispatcher` 对不在 `coreToolIds` 内的 CoreTool 调用返回 `CoreTool ... is not configured for this agent.`，两个能力族放行；正常运行时模型看不到未配置 schema，此分支只防御重放 transcript 或直接调用。
- **设置页**：`/api/settings` 的 `coreTools` 是注册表目录（id/name/description，两个能力族带 `alwaysAvailable: true`），勾选状态在 `agents[].coreToolIds`，见 `web/src/components/settings/CapabilityChecklists.jsx`。

## 四、生命周期：从注册到执行

```text
① 构建 schema   buildResidentTools(agent.coreToolIds)                  resident_tools.ts
                     └─ 显式绑定 ∪ {toollibrary, knowledgebase}；全部为静态 schema，不读取运行时上下文
② 注入本轮请求  addTools(...)                                      agent_runtime.ts 装配段
   注入系统提示  buildCoreToolsCatalogPrompt(enabledIds, {capabilitySelection})  agent_context_resolver.ts
③ 路由         RuntimeToolDispatcher.execute()                     runtime_tool_dispatcher.ts
④ 执行         executeCoreTool() → raceWithAbort()                 core_tools_runtime.ts:545-552 / 620-637
⑤ 结果后处理   finalizeToolResult()（观测降级/失败计数/审计/事件）   agent_runtime.ts 循环内
```

**①构建**：`buildCoreToolsForIds(ids)` 不需要任何运行时上下文：所有 schema 都是静态文本；`buildResidentTools(undefined)` 仍回退到 `buildAllCoreTools()`，供不经过 Agent profile 的直接调用。旧 `CoreToolSchemaContext`（skills / skillDirectories / mcpServers）已随 `load_skill` 一起删除。

**③路由**：`RuntimeToolDispatcher.execute` 按固定顺序判定（`runtime_tool_dispatcher.ts`）：

```text
isToolLibraryCoreTool（`toollibrary` / `toolload`）→ isCoreToolCall → MCP 兜底
```

顺序有实质影响：`toollibrary` / `toolload` 同时满足 `isToolLibraryCoreTool` 与 `isCoreToolCall`，**必须先判前者**，否则会落入 `executeCoreTool` 并返回 `Unknown core tool`（缺口 6）。

**④执行**：`executeCoreTool` 先检查已中止信号，再用 `raceWithAbort` 把长任务与 abort 事件竞速；取消统一抛 `CoreToolExecutionAbortedError`（`shared.ts:7-11`），`name` 被设为 `AbortError`。每个执行分支各自 `try/catch`，把异常收敛成 `{ ok: false, error }`——**唯一例外是取消**，它会继续向上抛（`:570`、`:542`）。

**⑤后处理**：见 `agent-loop.md` 第六节。CoreTool 只负责两件事：返回 JSON 字符串，以及在 JSON 里埋 `file` / `uiEvent` 字段供 `extractToolResultEvents`（`tool_result_events.ts:13-24`）抽取为 UI 事件。

## 五、逐个工具

### 5.1 `exec_command` / `shell_output` / `shell_kill`（定义 id：`shell`）

实现：`shell_executor.ts:11-100`（前台/后台入口）+ `shell_tasks.ts`（后台任务管理器）。

| 参数 | 语义 |
| --- | --- |
| `cmd`（必填） | shell 命令；提示词要求用 `workdir` 而不是 `cd &&` |
| `workdir` | 工作目录；**为空时落到当前会话绑定的项目目录** |
| `timeout_ms` | 默认 30 000，钳制到 1 000–300 000（仅前台） |
| `max_output_chars` | 每路输出上限，默认 50 000，钳制到 1 000–200 000（仅前台） |
| `run_in_background` | 为 true 时启动后台任务并立即返回 `task_id`，任务跨 run 存活 |

- **前台**：POSIX 下用 `/bin/sh -lc` 且 `detached: true`，让 shell 成为独立进程组 leader；取消/超时时 `process.kill(-pid)` 杀整棵进程树；超时先 `SIGTERM`，宽限 3 000 ms 后 `SIGKILL`；输出超限保留头尾各一半（`shell_executor.ts:11-50`、`process_tree.ts:3-24`）。
- **后台**（`shell_tasks.ts`）：`/bin/sh -lc` detached 启动，stdout+stderr 合并写入 `RUNTIME_STATE_ROOT/shell-tasks/<id>.log`；返回 `task_id`、`status:'running'`、`cwd`、`command`。任务**不随 run 结束清理**，只能由 `shell_kill`、自然退出或后端停止回收。
- `shell_output`：`{task_id?, offset?, wait_ms?, max_chars?}`；省略 `task_id` 列出本会话任务；按字节 offset 增量读取，`wait_ms`（≤30 000）等待新输出或退出，避免轮询；返回 `status/exit_code/signal/output/next_offset/truncated`。
- `shell_kill`：`{task_id, signal?}`，默认 `SIGTERM`，3 s 后 `SIGKILL`；进程树整体终止。
- 限额：单任务日志默认 64 MiB（可配到 256 MiB）、每会话同时最多 16 个 running 任务；pid+token 写入 `RUNTIME_STATE_ROOT/shell-tasks.json`，启动时 `recoverOrphans` 清理上次崩溃残留（`http/server.ts` 启动/停止钩子）。
- PATH 会前置 `BIOAGENT_ENV_BIN` 与 Node 可执行文件目录，与前台一致（`shared.ts` 的 `toolProcessEnvironment`）。
- 非零退出**不抛异常**：前台返回 `ok:false` 但带 `exit_code/stdout/stderr`；后台在 `shell_output` 的 `status`/`exit_code` 中体现。

### 5.2 `execute_python`（定义 id：`execute_python`）

实现：`analysis_kernel_manager.ts` + `assets/python_kernel_worker.py`。

| 参数 | 语义 |
| --- | --- |
| `code`（必填） | 一个分析 cell |
| `timeout_ms` | 默认 30 000，钳制到 1 000–300 000 |

- **会话键为 `conversationId`**：同一会话的多次调用与**后续用户轮次**复用同一内核，`session` 为 `resumed`；跨 run 不再销毁。空闲 30 min 或 backend 停止时回收，最多保留 4 个会话内核（LRU 淘汰）；超时/取消仍会关闭内核，下一次为 `recreated`。
- `session` 三态：`new`（本会话首次）、`resumed`（复用成功）、`recreated`（上次已因超时/取消/异常被关闭，本次是全新解释器）。模型必须据此判断是否需要重新加载数据。
- 同一内核的并发 cell 经 `tail` 链串行化；超时或 abort 直接关闭内核，不仅是中断当前 cell。
- 输出：`stdout`/`stderr` 各截断到 12 000 字符；cell 最后一个表达式结果以 `resultPreview` 返回。
- matplotlib 强制 `MPLBACKEND=Agg`，cell 结束后 figure 存为 PNG workspace artifact；同时把最多 4 张 PNG（单张 ≤6 MiB）作为 `images` 字段回传 runtime，由 runtime 转成 `image_url` content part 给模型看（`analysis_kernel_manager.ts` 的 `readFigureImages` + `image_payload.ts`）。
- **环境隔离**：仅白名单透传 `HOME`/`LANG`/`TMPDIR`/`CONDA_PREFIX`/`VIRTUAL_ENV` 等；内核是宿主进程、无沙箱，唯一控制点是审批门。
- **回收**：pid+token 写入 `workspace/.runtime/analysis-kernels.json`；backend 停止 `cleanupAll`，启动时 `recoverOrphans`；`cleanupRun()` 保留为兼容 no-op（run 结束不再杀内核）。
- 解释器解析顺序：`BIOAGENT_PYTHON` → `BIOAGENT_ENV_BIN/python` → `python3`/`python`。

### 5.3 `file` 族

实现：`file_executor.ts` + `file_state.ts`（观察表/队列/原子写）+ `edit_diff.ts`（匹配/多编辑/diff）+ `read_media.ts`（图片/PDF）。四个工具共享同一个 `workdir` 基准（默认项目根）。

| 工具 | 关键行为 |
| --- | --- |
| `read_file` | 带行号文本 + `offset`/`limit`/`max_chars` 分页；**图片**（PNG/JPEG/GIF/WebP/BMP）以 `images` 字段返回给模型；**PDF** 返回 `content` + `page_count` + 渲染页 `images`（`pages` 可选，如 `"1-3"`）；其他二进制需 `encoding="base64"`。读取成功会记录文件观察（mtime/size） |
| `write_file` | 整体覆盖，自动建父目录；**已存在文件必须先在本会话读过**，否则 `FS_NOT_OBSERVED`；读后被改则 `FS_STALE_VERSION`；写入为 temp+rename 原子写 |
| `edit_file` | 支持单个 `old_string/new_string` 或 `edits[]` 多编辑；精确匹配优先，失败后逐行 NFKC/trimEnd/智能标点模糊匹配；默认唯一匹配，多命中列出行号；返回 `diff`；同样受 read-before-write/staleness 约束 |
| `apply_patch` | 统一 diff 补丁；**先解析并计算所有目标文件的更新内容、全部校验通过后才写盘**；hunk 定位支持 `@@` 锚点 → 全局唯一 → trimEnd/trim 模糊回退；每个已存在目标都要求本会话读过且未变；支持 `\ No newline at end of file`；部分写失败返回 `FS_PATCH_WRITE_FAILED` + `completed[]` |

- 失败统一 `{ ok:false, error:{ code, message } }`；文件安全码为 `FS_NOT_OBSERVED`/`FS_STALE_VERSION`，其余为 `FS_READ_FAILED`/`FS_WRITE_FAILED`/`FS_EDIT_*`/`FS_PATCH_*`。
- 同一路径的写操作经 `withFileMutationQueue` 串行（多路径按字典序加锁），避免并行工具互相覆盖；原子写保留原文件 mode。
- 图片读取上限 8 MiB；PDF 文本 ≤50 000 字符、最多渲染 3 页；PDF 渲染依赖 `pdf-parse` 的 `@napi-rs/canvas`，不可用时降级为纯文本 + `warnings`（不报错）。
- 读游标：`total_lines`（完整读到底才有）、`returned_lines`、`next_offset`、`truncated`；单行超过 `max_chars` 直接报错。
- 行尾：`edit_file` 在 LF 视图匹配并恢复原文件的主导行尾（CRLF 保留）；`apply_patch` 保留被改文件行尾与末尾换行语义。

### 5.4 `search` 族

实现：`search_executor.ts`。

- 默认排除 `!.git/**` 与 `!node_modules/**`；`glob` 使用 `rg --files --hidden`，支持 `include`/`exclude`，`max_results` 默认 100、上限 2 000。
- `grep` 是 rg 的参数投影：`query`、`path`、`regex`、`case_sensitive`、`include`/`exclude`、`type`，以及 **`context`（0–10）**、**`head_limit`（默认 100，上限 2 000）**、**`offset`**、**`output_mode`（content|files|count）**。
  - `content`：`matches:[{path,line,preview,context?}]`，`context` 含前后文行；保留旧 `path/query/count/matches` 字段。
  - `files`：唯一路径列表；`count`：每文件匹配计数。
  - 返回 `truncated`/`next_offset` 支持翻页；`total_matches` 在 content/files 截断时为下界（提前停止 rg），count 模式为精确值（受 200k 事件解析上限约束）。
- 单条 ripgrep JSON 记录超过 64 KB 视为异常输入并终止；`path` 指向文件时自动切父目录 + basename 搜索。

### 5.5 `web_fetch`（定义 id：`web_fetch`）

实现：`web_fetch_executor.ts`。

- **不是搜索工具**：只接受已知的 http/https URL；搜索请用 `web_search`。
- 跟随重定向；UA 固定 `BioflowAgent/0.1 web_fetch`；响应体上限 25 MB；PDF → `pdf-parse` 文本；XML/JATS → 标题/摘要/分节；HTML → 去脚本样式转纯文本并抽链接；其他按纯文本。
- `access_status` 五态（`available`/`bot_challenge`/`paywalled`/`http_error`/`parse_error`）；返回内容恒带不可信外部文本 warning。
- `ok` 直接取自 HTTP 状态，404 等仍会计入 `ToolFailureTracker`（见缺口 7）。

### 5.6 `web_search`（定义 id：`web_search`，显示名 `Web: Search`）

实现：`runtime_tool_dispatcher.ts` 的 `executeWebSearch` + `core_tools/web_search.ts`。schema 静态声明，执行必须由 dispatcher 完成（需要已连接的 MCP 会话）。

- 参数：`query`（必填）、`max_results`（默认 5、上限 10）。
- **provider 发现**：扫描当前 agent 绑定的 MCP catalog，选择名称匹配 `/search/i` 且不匹配 `extract|crawl|map|research|agent|fetch` 的工具（典型为 `tavily_tavily_search`、`exa_web_search_exa`），按 Tavily → Exa → 其它顺序。
- **provider 的目录边界**：`tavily` / `exa` 在 `mcp.json` 标记 `internal: true`——它们保持连接并参与 fan-out，但工具与 MCP 资源不进入 `toollibrary`、不可 `toolload`；过滤只发生在 Tool Library 快照（`runtime_tool_dispatcher.ts` 的 `toolLibrarySnapshot()`），不影响 `web_search` 执行。
- **参数映射**：从 provider 的 input schema 推断 query 键与结果数键（`max_results`/`numResults`/`num_results`/`limit`/`num`），只传 query + 数量，不猜其它 required 字段。
- **执行与合并**：并行调用所有可用 provider，`parseSearchOutput` 解析 `results/data/items`/裸数组/MCP content block 中的 JSON，归一 title/url/snippet/score/published；`mergeSearchResults` 去重（host 大小写 + trailing slash）并按 provider 交错合并，最多 `max_results` 条；返回 `{ok, query, providers:[{server,ok,error?}], results, truncated}`。
- 单 provider 失败不影响其它 provider；全部失败返回 `WEB_SEARCH_FAILED`；未连接任何可用 provider 返回 `NO_WEB_SEARCH_PROVIDER`。
- `risk: network_or_external`、不可并行（避免并行批次绕过审批，见缺口 1）；返回结果附不可信外部文本 warning。

### 5.7 `planning`（定义 id：`planning`）

实现：`planning_executor.ts`。这是唯一的**协议型工具**——返回值里的 `instruction` 字段要求模型立刻停止，等待用户交互。

| action | 必填参数 | 副作用 |
| --- | --- | --- |
| `clarify` | `questions`（每项恰好 3 个选项） | 无落盘；返回 `planning_panel` / `clarify` / `waiting` |
| `publish_plan` | `markdown` | 写入会话工作区 `planning/<name>.md`，登记为 `type=plan` 产物；返回审批面板 |
| `update_todo` | `todos` | 无落盘；返回待办面板 |
| `complete` | 无 | 清空待办面板 |

- `clarify` 的问题经 `normalizePlanningQuestions` 净化：缺 `id` 自动生成，选项过滤空值后 **不足 3 个即整题丢弃**（`:110-124`）。
- `publish_plan` 的文件名净化到 ≤80 字符、去特殊字符并强制 `.md` 后缀（`:141-150`）。
- 只有 `publish_plan` 依赖 `conversationId`（缺失时返回 `{ ok: false, error: 'conversationId is required...' }`）。
- UI 事件契约（`panel` ∈ {`clarify`,`plan`,`todo`}，`status` ∈ {`waiting`,`active`,`complete`}）由 `tool_result_events.ts:46-63` 校验，因此**面板字段拼错会被静默丢弃**。

### 5.8 `toollibrary` / `toolload`（定义 id：`toollibrary`，显示名 `Tool Library: Capabilities`）

两层渐进披露的能力目录与按需加载器。**一个注册表定义暴露两个工具名**（与 `file` / `search` 的多工具名形态一致）：`toollibrary` 负责浏览，`toolload` 负责加载。展示层内容在 `agent-client/toollibrary/`：根 `index.md` 是领域索引，`<领域>/index.md` 列出该领域工具（skill + MCP）的 name/description。执行器是 `core_tools/toollibrary_executor.ts`，由 `RuntimeToolDispatcher.executeToolLibrary` 路由（不经 `executeCoreTool`）。

- **L1 领域索引预注入 system prompt**（`<tool_library_domains>`，`SystemPromptSection.kind='tool-library'`，source=`toollibrary/index.md`）：`agent_context_resolver.ts` 在 core-tools 段之后渲染，约 1.3k 字符，只含领域 name/description，不含工具计数。模型从该段直接选域，不再先调用 `toollibrary()` 发现领域。
- `toollibrary`：传 `domain`（正常路径）→ L2 目录 `{ok,action:'catalog',domain,entries:[{name,kind,id,description}],total,offset,limit,has_more,warnings}`，按 name 排序，默认 100 条/页、上限 200，并受 30 000 字符预算约束；省略 `domain`（fallback）→ 运行时 L1 索引 `{ok,action:'index',domains:[{name,description,tools}],warnings}`，含 `Unclassified` 兜底域。
- `toolload`：`id` → 加载一个具体能力（skill 返回 `{ok,action:'skill',skillId,skillName,content}`；MCP 工具登记 schema 后返回 `{ok,action:'mcp_tool',id,loaded,alreadyLoaded}`）；`resource`（可选 `server`）→ 读 MCP 资源；`server`（省略 `resource`）→ 列该 server 的资源。`id` 与 `resource`/`server` 互斥。
- **可见性**：只展示当前 agent 已启用且已绑定的 skill、已启用且已绑定的 MCP server 工具；运行时 L1 fallback 会隐藏没有可见工具的领域，静态 L1 则列出全部策展领域（prompt 早于 MCP 连接装配）。索引文件漏列的能力进入运行时兜底领域 `Unclassified`；列了但不可见的条目隐藏并返回 warning。
- **schema 是静态的**：不内嵌任何目录；L1 由 system prompt 携带，L2 由带 `domain` 的 `toollibrary` 调用按需放进上下文——这是与旧 `load_skill` 的关键差异。
- `risk: 'read_only'` → 任何安全模式直接放行；`toolload` 会改下一轮 `tools`，因此所在定义 `parallelizable: false`。
- 预算：观测层内联上限为 `toollibrary` **30 000**、`toolload` **70 000** 字符；`toolload` 的 skill 正文由 `formatLoadedSkill` 拼装，资源文本单条截到 4 000 字符、总计 8 000 字符。
- 漂移：warning 代码与解析规则见 [`toollibrary-mechanism.md`](toollibrary-mechanism.md)；内容契约测试锁住当前仓库的领域覆盖与绑定一致性。

### 5.9 `knowledgebase`（定义 id：`knowledgebase`，显示名 `Knowledge Base`）

两层渐进披露的只读知识库加载器，与 Skill 无关。内容在 `agent-client/knowledgebase/`：根级 `skill.md` 是领域索引，`<领域>/<条目>/skill.md` 是知识条目，条目内可带 `resources/`（仅可查看资料，不含可执行脚本）。执行器是 `core_tools/knowledgebase_executor.ts`，由 `executeCoreToolInternal` 直接调用（不经 dispatcher）。

- 三个 action：`index`（领域索引 + 条目数）、`catalog`（某领域的条目 name/description，支持 `offset`/`limit` 分页）、`read`（条目正文 + 资源列表）。
- schema 是**静态**的：不内嵌知识库目录，`buildSchemas` 也不读取 `CoreToolSchemaContext`。L1 索引由第一次 `index` 调用加载，这是与 §5.8 的关键差异。
- `risk: 'read_only'`、`parallelizable: true`：任何安全模式直接放行，可与其它只读工具同批并行。
- 返回 JSON 字符串；`read` 的正文是去掉 frontmatter 的 Markdown，`resources` 中文本 ≤2 000 字符内联，二进制只给 `path/mimeType/size/encoding`。
- 预算：观测层对 `knowledgebase` 结果的内联上限是 **30,000 字符**（其它工具 6,000）；单条正文软上限 28,000 字符（超过返回 `body_exceeds_budget` warning，不截断）；单领域 catalog 页按 **30,000 字符**预算自动填充，默认最多 100 条、上限 200 条；单条 description 建议 ≤700 字符。
- 校验：frontmatter 只读 `name`（允许中文，≤120 字符）与 `description`（非空）；坏条目在 `catalog` 中跳过并返回 `malformed_entry` warning，在 `read` 中直接失败。
- 工具 description 与系统提示明确要求：在工具返回前不得声称已读过条目。

详见 [`knowledgebase-mechanism.md`](knowledgebase-mechanism.md)。


### 5.10 `subagent`（定义 id：`subagent`）

实现：`core_tools/subagent_executor.ts` + 进程内状态 `core_tools/subagent_runtime.ts`。

一个工具用 `action` 分四态，而不是四个 schema——schema 每轮常驻，四个工具会为同一能力付四份描述成本：

| action | 参数 | 行为 |
| --- | --- | --- |
| `start` | `description`（3–5 词）、`task`（自足提示）、可选 `timeout_ms` | 校验深度/并发/项目后创建子会话并起一次子 run，**立即返回** `{conversationId,status:'running'}` |
| `status` | 可选 `conversation_id` | 列出本会话的子 Agent（运行中来自内存，已完成来自子会话最新 run） |
| `result` | `conversation_id` | 读取子会话最后一条非空 assistant 文本；仍在运行时返回 `subagent_running` |
| `cancel` | `conversation_id` | abort 子 run；父 run 被取消时子 run 通过同一 signal 一起中止 |

生命周期与边界：

- **独立上下文**：子会话是普通会话（`parentConversationId` / `subagentDepth` / `subagentDescription` / `agentId` 四个可选字段），继承父的项目目录与 Agent 配置（工具、Skill、MCP、知识条目），但**不继承父对话历史**。`agentId` 是创建它的角色，落盘在会话记录里：子 run 本来就用这个角色解析上下文，落盘后任何后续 run（API/CLI 直接对子会话发起）也按同一个角色解析，不会退回调用方选中的 agent。团队通信权是唯一例外：`delegationDepth > 0` 时 `team_message` 从生效 profile 里摘掉。
- **异步通知**：子 run 结束后把 `[subagent completed|failed|cancelled|timed out] ...` 作为 **user 角色**写入父会话模型转录；父 run 活着时同时入队，主循环在下一个模型步前用 `pushRuntimeGuidance` 注入（必须是 user，见 `agent-loop.md` 的单 system message 约束）。
- **深度**：`AgentChatRequest.delegationDepth` 默认 0，子 Agent 为父 +1；`>= maxDepth` 时直接 `subagent_depth_exceeded`，工具参数不能覆盖深度。
- **并发**：进程级闸门，满了返回 `subagent_busy`，**不排队**（排队会让父等自己持有的槽位而自锁）。
- **审批钉死**：子 run 的 `approvalPolicy: 'never'`。需要审批的动作不创建审批条目、不阻塞，直接回 `approval_unavailable`（子会话没有审批 UI，等待只会空转到 10 分钟超时）。
- **取消级联**：父 run abort → 子 controller abort；`subagent cancel` 同理；两种情况都会照常发取消通知。
- **子会话归属**：子会话**不在**项目会话列表 / 侧栏 / 未分组里（`GET /api/conversations` 与 `listProjects()` 都排除 `parentConversationId`），入口只有父会话标题右侧的「子 Agent N」触发器（`GET /api/conversations/:id/subagents` → 前端 `SubagentBar`）。点开是主面板里的只读视图：面包屑指回父会话、composer 换成只读说明（`ChatView` 的 `subagentView`）、不提供 goal 写入。因此"子会话被手动续聊"只可能来自 API 直调，`POST /:id/runs` 用 `resolveAnsweringAgentId()` 按 `roleId → agentId → 请求体 agentId` 的顺序决定谁来答。删除父会话时子会话一并删除——否则它们会变成任何入口都到不了的孤儿记录。
- **标题**：子会话标题固定为创建时的 `Subagent · <description>`；`maybeUpdateConversationTitle` 对委派会话直接返回，不会被首条消息（委派前缀）改成 `You are a delegated…`。

## 六、风险分级与审批

`CoreToolRisk` 五档经 `classifyToolRisk` 映射为 `CommandRisk`（`security_policy.ts:49-57`）：

| 注册表 `risk` | 映射结果 |
| --- | --- |
| `shell` | 交给 `classifyShellCommand` 按命令内容细分（`destructive` / `network_or_external` / `read_only` / `project_write` / `unknown`）；`shell_kill` 也走这一档 |
| `code_execution` | `unknown`（不尝试静态判定，一律交审批/复审） |
| `read_only` / `project_write` / `network_or_external` | 原样透传；`shell_output`/`toollibrary`/`toolload`/`knowledgebase` 为 `read_only`，`web_search`/`web_fetch` 为 `network_or_external` |
| 未注册的工具（MCP 执行） | `unknown` |

审批矩阵见 `agent-loop.md` 第四节。两点与 CoreTool 直接相关：

1. 并行批次**只按 `parallelizable` 判定，完全跳过审批**（`agent_runtime.ts:396-434`）——见缺口 1。
2. 用户拒绝时**仍写入一条 tool result 回喂模型**，让它知晓被拒并换策略，而不是直接失败（`:479-488`）。
3. 委派子 Agent 的 run 使用 `approvalPolicy: 'never'`：`ask` 判定不进入 `securityApprovalStore`，直接以 `approval_unavailable` 回喂模型。`subagent` 本身登记为 `code_execution`，因此在 `approval` 模式下"启动委派"仍需要用户确认一次。

## 七、路径与作用域

- 会话绑定**项目目录**（`projectPath`），所有路径型工具默认以它作为根：`exec_command` 的 `workdir`、文件工具的 `workdir`、`glob`/`grep` 的 `path`（`project_paths.ts`、`shared.ts`）。
- `resolveTerminalPath` 仍接受绝对路径（`:14-18`）；是否越出项目由安全门 `assessProjectBoundary` 判定，串行路径下越界会进入审批（`project_boundary.ts`）。**注意**：并行批次会跳过该安全门（缺口 1）；`apply_patch` 补丁内路径、shell 的 `cmd` 目标与 MCP 的 `input_file` 等参数仍不在这套边界检查内（缺口 3）。
- 文件工具的 **read-before-write** 以会话为单位记录 `(path, mtimeMs, size)` 观察（`file_state.ts`），只影响写前校验，不改变路径解析。
- 工具拿不到 `conversationId` 时（例如直接单元测试调用）文件安全校验自动 no-op，但仍使用项目根解析路径。

## 八、结果契约

- 成功：`{ ok: true, ... }`；失败：`{ ok: false, error: { code, message } }`。新工具与文件工具统一返回结构化错误；`execute_python` 历史上就是 `{ code, message }`。`tool_failure_guard.ts` 仍兼容 `error` 为字符串、`isError:true` 与 `ok:false` 三种失败形态。
- 埋给 UI 的字段（`extractToolResultEvents`，`tool_result_events.ts`）：
  - `file: { id, title, path, workspacePath, type }` → `workspace_artifact` 事件；
  - `uiEvent: { type: 'planning_panel', panel, status, ... }` → `planning_panel` 事件。
- **图片**：工具结果 JSON 里的 `images`/`image` 由 `image_payload.ts` 抽出，从 observation/transcript 的文本中删除，再以 `[{type:'text'}, {type:'image_url'}]` 形式作为 **tool message content parts** 回传模型（`agent_runtime.ts` 的 `finalizeToolResult`）。图片不会进入 `tool_call_result.result` 文本、transcript 的 `rawResult` 或事件预览；模型不支持图片时 `llm_client.ts` 会一次重试并降级为文本占位。
- 结果长度由 Observation 三级降级处理（≤6 000 内联 / 超限落盘并回传路径引用）；`toollibrary`/`toolload`/`knowledgebase` 有独立的更大预算。图片不参与该预算，token 估算按每张约 1 024 tokens 计（`context_manager.ts`）。

## 九、扩展指引

新增一个 CoreTool 需同步五处：

1. `agent/core_tools/ids.ts` 添加工具名常量。
2. 在 `core_tools_runtime.ts` 的 `CORE_TOOL_REGISTRY` 注册定义，**同时声明 `risk` 与 `parallelizable`**；若声明可并行，必须确认为只读操作（缺口 1）。
3. 实现执行器，并在 `executeCoreToolInternal`（`:717-...`）接上分支，把异常收敛为 `{ ok: false, error: { code, message } }` 形态。
4. 若工具需要 dispatcher 能力（MCP 会话、agent 能力快照、下一轮 tools 修改），把 `dispatch` 设为新的路由类型（参考 `web_search` 的 `web_search` dispatch 与 `runtime_tool_dispatcher.ts`）。
5. 若工具会产生图片，返回 JSON 里的 `images` 数组（base64，无 data: 前缀），由 `image_payload.ts` 统一抽取/限额；若需要 UI 副作用，复用 `file` / `uiEvent` 约定。

若工具需要 `conversationId`、`runInstanceId` 或 `delegationDepth`，从 `CoreToolExecutionContext` 取（`:695-704`）；当前 shell_output/shell_kill、execute_python、planning、文件安全、后台任务都依赖它，`subagent` 另外依赖 `delegationDepth`。工具若会创建子 run，注意子 run 的审批策略固定为 `never`。

## 十、测试覆盖

| 测试文件 | 覆盖内容 |
| --- | --- |
| `test/core_tools_runtime.test.ts` | grep 前导短横线字面量、abort 信号、默认工作区、PATH 注入、web_fetch 的反爬/PDF/JATS、edit_file CRLF 保真、schema/注册表元数据、read_file 游标与越界、apply_patch 锚点与歧义拒绝、shell 后台工具 schema、web_search 注册、grep 新参数、read-before-write 集成 |
| `test/file_safety.test.ts`（23 例） | 未读/过期拒绝、读后可写、新建允许、原子写与 mode、文件队列串行/多路径不死锁、apply_patch 两阶段/stale/未读/创建/删除/no-newline/歧义/部分写失败 |
| `test/edit_diff.test.ts`（15 例） | 精确/replaceAll/未命中/多命中/无变化/非法、模糊单行与跨行、重叠、多 edit 原文基准、CRLF→LF、diff 截断 |
| `test/shell_tasks.test.ts`（10 例） | 前台兼容、后台完成/增量 offset/wait_ms、kill、任务列表隔离、日志上限、每会话上限、跨 run 存活、孤儿恢复、executeShellCommand 集成 |
| `test/analysis_kernel_manager.test.ts`（8 例） | 跨 run 持久、环境隔离、timeout/abort 重建、cleanupRun no-op、LRU 4、TTL、figure 图片附件 |
| `test/web_search.test.ts`（19 例） | provider 发现/排序/排除、参数映射（含 schema 包装）、Tavily/Exa/content-block 解析、URL 去重、round-robin 合并、失败状态 |
| `test/grep_search.test.ts`（15 例 + 5 个 rg 集成） | grep 参数/事件解析/context/offset/files/count/type；rg 缺失时 skip |
| `test/read_media.test.ts` / `test/image_payload.test.ts`（25 例） | 五种图片 magic/尺寸/base64、PDF 文本/页渲染/降级、图片抽取限额、消息 content part 构造、文本降级 |
| `test/runtime_tool_dispatcher.test.ts` | `toolload` 的 MCP schema 装载不执行 MCP 工具本身、skill 正文、资源列表/读取、id 与 resource 互斥、web_search fan-out/合并/缺 provider/单 provider 失败 |
| `test/agent_runtime_images.test.ts` | 图片工具结果以 `image_url` content part 回传模型，base64 不进入事件文本 |
| `test/context_manager.test.ts` / `test/transcript_store.test.ts` | 图片 token 估算不按 base64 文本计；transcript 不存 base64 |
| `test/knowledgebase_executor.test.ts` / `test/knowledgebase_content.test.ts` | 知识库索引/目录/正文/预算/内容契约；Agent 知识条目白名单对 index/catalog/read/候选的影响 |
| `test/agent_config_store.test.ts` | 旧记录迁移为全部 CoreTool/全部知识条目（含旧域绑定展开）、显式空数组保留、新 Agent 为空、字段落盘 |
| `test/agent_capability_catalog.test.ts` | 设置页 ToolLibrary/KnowledgeBase 目录投影、MCP 公开名到 server 的最长前缀匹配、`Unclassified` 兜底 |
| `test/toollibrary_executor.test.ts` / `test/toollibrary_content.test.ts` | 展示层解析、可见性过滤、分页预算；内容契约 |
| `test/subagent_core_tool.test.ts`（9 例） | 注册面（schema/risk/prompt）、深度闸门、参数校验、并发闸门、start 建链会话、完成/取消/父级取消通知、status/result 读取、父 run 空闲时不入队 |
| `test/subagent_role_persistence.test.ts`（3 例） | `resolveAnsweringAgentId` 优先级（roleId → agentId → 请求体）、子会话把创建角色落盘到 `session.json`、调用方没有 agent 时的旧回退 |
| `test/subagent_capability_inheritance.test.ts`（2 例） | 子 agent 继承角色 prompt/CoreTool/skill/MCP/知识/模型，唯独不继承 `team_message`（工具列表与 prompt 目录都不出现） |
| `test/subagent_approval_policy.test.ts`（1 例） | 委派子 run 在 `approval` 模式下 fail-closed：不产生审批事件、回喂 `approval_unavailable`、run 继续而不空转 |

> **剩余测试缺口**：`glob` 默认排除与路径越界、`planning` 全部 action、并行批次绕过审批仍无回归测试；PDF 页渲染在 canvas 不可用的环境只走降级分支。

## 十一、已知缺口汇总

| # | 类型 | 描述 | 位置 |
| --- | --- | --- | --- |
| 1 | 安全 | 并行批次（须全部 `parallelizable`）完全跳过 `assessRuntimeToolSecurity`；`web_fetch` 与 `shell_output` 等可并行工具在 `approval` 模式下可与 `read_file` 混批绕过审批。`parallelizable` 与 `risk` 之间无一致性断言 | `agent_runtime.ts` 并行分支、`core_tools_runtime.ts` 注册表 |
| 2 | 安全 | 项目边界只覆盖 `workdir`/`file_path`/`path` 三个参数：`apply_patch` 补丁内路径、shell 的 `cmd` 目标、MCP 的 `input_file`/`output_file`/`directory` 不在边界检查内；路径边界用纯词法 `path.resolve`，未解析 symlink | `project_boundary.ts`、`file_executor.ts`、`config/project_files.ts` |
| 3 | 一致性 | 两套 id 命名并存：`shell`/`file`/`search` 用短名，其余定义直接复用工具名作为 id | `core_tools_runtime.ts` 注册表 |
| 4 | 健全性 | 非 Linux 平台上内核/后台任务的 `processHas*Token` 恒返回 `false`（只实现 `/proc/<pid>/environ`），崩溃残留只能靠人工清理 | `analysis_kernel_manager.ts`、`shell_tasks.ts` |
| 5 | 耦合 | `toollibrary`/`toolload` 与 `web_search` 同时满足 `isCoreToolCall` 和各自 dispatch 判定，dispatcher 的判定顺序成为正确性前提；直接调用 `executeCoreTool` 会得到明确错误但功能不可用 | `runtime_tool_dispatcher.ts`、`core_tools_runtime.ts` |
| 6 | 语义 | `web_fetch` 把 HTTP 状态直接映射为 `ok`，404/403 会计入 `ToolFailureTracker`，连续多次可能触发 10 次熔断 | `web_fetch_executor.ts`、`tool_failure_guard.ts` |
| 7 | 依赖 | 图片/PDF 多模态依赖模型端点接受 `image_url` part；不支持时 `llm_client` 会降级为文本占位，但 PDF 页渲染依赖 `@napi-rs/canvas`，缺 canvas 时只有文本 | `image_payload.ts`、`read_media.ts`、`llm_client.ts` |
| 8 | 运维 | 后台 shell 任务只在 backend 停止或显式 kill 时回收；backend 崩溃后原任务进程由 `recoverOrphans` 按 pid+token 清理，但任务结果不可恢复（只清理孤儿，不恢复） | `shell_tasks.ts`、`http/server.ts` |
| 9 | 语义 | 子 Agent 完成通知只在下一次模型步或下一次 run 生效；父 run 已结束时不会自动唤醒父会话（本阶段是产品选择，不是缺陷修复项） | `core_tools/subagent_runtime.ts`、`agent_runtime.ts` |
| 10 | 产品 | 子会话入口只做到直接子级：下拉不展开多级树（`maxDepth` 默认 1，够用），也没有"给子会话补充指令"的通道——一次性委派，视图只读；禁用委派只能靠深度 0 或移除定义 | `subagent_catalog.ts`、`web/src/components/chat/SubagentBar.jsx` |
| 11 | 性能 | 子会话查询（`subagent action=status` 与 `GET /:id/subagents`）都用 `getAllConversations()` 线性过滤，会话数很大时是 O(n)；后续可换成按父会话索引 | `subagent_catalog.ts`、`core_tools/subagent_executor.ts` |

## 十二、一手来源索引

| 主题 | 位置 |
| --- | --- |
| 注册表与全部 schema | `agent-client/backend/src/agent/core_tools_runtime.ts` |
| 注册表查询与元数据 API | `agent-client/backend/src/agent/core_tools_runtime.ts` 的 `buildAllCoreTools` / `buildCoreToolsForIds` / `getCoreToolCatalog` / `isToolLibraryCoreTool` |
| Agent CoreTool 配置与迁移 | `agent-client/backend/src/agent/config/agent_config_store.ts`、`agent-client/web/src/components/settings/CapabilityChecklists.jsx` |
| 执行入口与 abort 竞速 | `agent-client/backend/src/agent/core_tools_runtime.ts:708-...` |
| 工具名常量 | `agent-client/backend/src/agent/core_tools/ids.ts` |
| 路径解析与数值钳制 | `agent-client/backend/src/agent/core_tools/shared.ts` |
| 进程组终止 | `agent-client/backend/src/agent/core_tools/process_tree.ts` |
| shell 执行（前台/后台入口） | `agent-client/backend/src/agent/core_tools/shell_executor.ts` |
| 后台 shell 任务管理 | `agent-client/backend/src/agent/core_tools/shell_tasks.ts` |
| Python 内核生命周期 | `agent-client/backend/src/agent/core_tools/analysis_kernel_manager.ts` |
| Python worker 协议 | `agent-client/backend/src/agent/core_tools/assets/python_kernel_worker.py` |
| 文件工具与 patch 解析器 | `agent-client/backend/src/agent/core_tools/file_executor.ts` |
| 文件观察/队列/原子写 | `agent-client/backend/src/agent/core_tools/file_state.ts` |
| 编辑匹配/多编辑/diff | `agent-client/backend/src/agent/core_tools/edit_diff.ts` |
| 图片/PDF 媒体读取 | `agent-client/backend/src/agent/core_tools/read_media.ts` |
| 工具结果图片抽取/消息构造 | `agent-client/backend/src/agent/core_tools/image_payload.ts` |
| glob/grep | `agent-client/backend/src/agent/core_tools/search_executor.ts` |
| web_fetch | `agent-client/backend/src/agent/core_tools/web_fetch_executor.ts` |
| web_search | `agent-client/backend/src/agent/core_tools/web_search.ts`、`runtime_tool_dispatcher.ts` |
| planning 协议 | `agent-client/backend/src/agent/core_tools/planning_executor.ts` |
| 子 Agent 委派与通知 | `agent-client/backend/src/agent/core_tools/subagent_executor.ts`、`core_tools/subagent_runtime.ts` |
| 子会话清单与状态（工具与 Web 共用） | `agent-client/backend/src/agent/subagent_catalog.ts`、`agent-client/web/src/components/chat/SubagentBar.jsx`、`web/src/hooks/useSubagents.js` |
| 工具路由 / toolload / web_search 执行 | `agent-client/backend/src/agent/runtime_tool_dispatcher.ts`、`core_tools/toollibrary_executor.ts` |
| 风险映射与审批 | `agent-client/backend/src/agent/security_policy.ts:20-57` |
| 并行/串行分岔与审批挂起 | `agent-client/backend/src/agent/agent_runtime.ts:383-496` |
| 结果契约与失败判定 | `agent-client/backend/src/agent/tool_failure_guard.ts` |
| 图片消息/token 估算/transcript 裁剪 | `agent_runtime.ts`、`core_tools/image_payload.ts`、`context_manager.ts`、`transcript_store.ts` |
| UI 事件抽取 | `agent-client/backend/src/agent/tool_result_events.ts:13-63` |
| system prompt 注入点 | `agent-client/backend/src/agent/service/agent_context_resolver.ts:221-236` |
| 设置页工具目录 API | `agent-client/backend/src/http/routes/settings.ts:24-79` |
| 测试 | `agent-client/backend/test/core_tools_runtime.test.ts`、`analysis_kernel_manager.test.ts`、`runtime_tool_dispatcher.test.ts` |
