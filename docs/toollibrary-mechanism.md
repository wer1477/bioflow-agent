# Tool Library 机制

> 基线：`e66665e`（`refactor: migrate doc-only skills into the skillbook`）
> 范围：`agent-client/toollibrary/`（展示层内容）、`agent-client/backend/src/agent/core_tools/toollibrary_executor.ts`、`core_tools_runtime.ts` 的 `toollibrary` 注册条目、`paths.ts` 的 `TOOLLIBRARY_ROOT`、`runtime_tool_dispatcher.ts` 的 `executeToolLibrary`、`service/agent_context_resolver.ts` 的 prompt 装配与 `agent/types.ts` 的 section kind，以及 `backend/test/toollibrary_*.test.ts`、system prompt 相关测试。
> 本文描述**当前实现事实**，用于新增 / 维护能力目录前的核对；文末标注已知缺口。
> 与 Skill（[`skill-mechanism.md`](skill-mechanism.md)）、MCP（[`mcp-mechanism.md`](mcp-mechanism.md)）、Knowledge Base（[`knowledgebase-mechanism.md`](knowledgebase-mechanism.md)）的关系：Tool Library 是**能力**的展示层 + 加载入口（skill + MCP），Knowledge Base 是**纯知识**的只读库，两者是独立 CoreTool。

> 2026-10-21：展示层领域目录与领域 name/description 已整体英文化（目录名 = 英文领域名）；`skills/生信分析/` 更名为 `skills/bioinformatics/`，条目 id 现为全英文；运行时合成的兜底领域由 `未归类` 更名为 `Unclassified`。

> 2026-11-05：skill 目录树退役，45 个 skill 全部平铺在 `skills/` 根目录，条目里的 skill id 变为裸 slug（如 `scanpy`、`bio-seq`），不再带 `bioinformatics/` 前缀。
>
> 2026-10-21：`tavily` / `exa` 在 `mcp.json` 标记 `internal: true`（内置 `web_search` 的 provider），其工具与 MCP 资源退出可见集合；展示层 `Scientific Search and External Data/index.md` 同步删除 8 条对应条目。
>
> 2026-10-31：L1 领域索引改为 **system prompt 常驻**（`<tool_library_domains>`，`SystemPromptSection.kind='tool-library'`，source=`toollibrary/index.md`）；模型不再需要先调 `toollibrary()` 才发现领域，`toollibrary` 的正常路径改为只取 L2，无参调用降级为运行时 fallback。
>
> 2026-11-01：L1 改为**按 agent 可见能力过滤**。`renderToolLibraryDomainIndexPrompt(root, visibility)` 会读每个领域的 `index.md`，只有当该领域里至少有一条条目属于当前 agent 的已绑定能力（skill 按 id 精确匹配，MCP 条目按 `<server>_` 公开名前缀匹配）时才渲染这个领域；一个都匹配不到时不产生 `<tool_library_domains>` 段。角色能力按职责分配后，窄角色不再为一个只能拿到空 catalog 的领域付上下文。
>
> 2026-11-01：`toollibrary` / `toolload` 改为**始终注入角色上下文**（`residentCoreToolIds`），`coreToolIds` 里的绑定只决定 `select` 是否交给 biod；未绑定时 `select` 退化为浏览结果，由模型自行 `catalog` → `toolload`。biod 失效的回落路径不变。
>
> 2026-11-07：shipped 配置**不再把 `toollibrary` 绑进 `coreToolIds`**，`biod.json` 的 `tool_select.mode` 也改为 `off`：`select` 统一退化为浏览结果，由模型自行 `catalog` → `toolload`。工具仍然常驻，只是选择权回到模型。
>
> 2026-11-07：新增 L1.5 `<cli_capabilities>`（`toollibrary/cli.md`）：把已安装 CLI 的命令名 + 一句话放进系统提示，按角色绑定过滤；参数契约由 `<command> --describe --format json` 提供，正文/流程/风险仍由 `toolload` 提供。

## 一、结论速览

- Tool Library 是**两层渐进披露的能力目录**：第一层领域索引（`toollibrary/index.md`）→ 第二层领域内工具目录（`toollibrary/<领域>/index.md`，只有 name/description/kind/id）→ 需要时用 `toolload` 取正文或 MCP schema。
- **L1 预注入 system prompt**：`agent_context_resolver.ts` 在 core-tools 段之后、workspace 段之前渲染 `<tool_library_domains>`，只含领域 name/description。模型看到领域索引后直接选域，无需为“有哪些域”花一个 discover turn。渲染按当前 agent 的绑定过滤：领域内没有任何属于它的 skill/MCP 条目时，这一行不出现（PI 全量绑定约 1.5k 字符，窄角色只有自己可用的几个域）。
- **L2 不预注入**：`toollibrary({domain})` 才把该领域目录放进上下文；工具 schema 仍是静态文本，不进目录内容。无参 `toollibrary()` 保留为 fallback（运行时索引，含 `Unclassified`），仅在 prompt 段缺失或怀疑有未列出能力时使用。
- **CLI 默认可见（L1.5）**：`toollibrary/cli.md` 中每个已绑定命令渲染成一行 `<cli_capabilities>` 段（命令名 + 一句话 + skill id，单角色上限 4 000 字符）；参数契约由 `<command> --describe --format json` 提供，正文/流程/风险仍由 `toolload` 提供。它解决的是"命令在 PATH 上但模型不知道"的 unknown unknown，不把 SKILL.md 预注入上下文。
- `toollibrary/cli.md` 当前 18 条命令：12 个原有 CLI + `bio-sc` / `bio-bulk` / `bio-qc` / `bio-report` / `bio-align` / `bio-metagenomics`。
- 一个 CoreTool 定义（`id: toollibrary`，显示名 `Tool Library: Capabilities`）暴露**两个工具名**：`toollibrary`（浏览）与 `toolload`（加载）；`dispatch: 'tool_library'`，由 `RuntimeToolDispatcher` 执行（需要 `request.skills`、`mcpToolsByName`、`mcpServers`、`addTools`）。
- `risk: 'read_only'`：任何安全模式都免审批；`parallelizable: false`（`toolload` 会改下一轮 tools 集合）。
- **配置是存在性权威，磁盘文件是展示层**：能力是否可用由 `agents.json` 的 `skillIds` / `mcpServerIds` 与 skills / MCP 的 enabled 状态决定。列为不可见 → `unknown_tool` warning + 隐藏；已配置但未列 → 运行时兜底领域 `Unclassified` + `unlisted_tool` warning。
- 观测层内联上限：`toollibrary` **30 000 字符**、`toolload` **70 000 字符**。浏览页本来就受 30k 预算约束；单条 SKILL.md 可能很长（当前最长约 5.3 万字符），需要整篇交给模型，所以加载预算单独放大。资源正文另有 **8 000 字符**共享内联预算，超出部分只列文件名/类型/大小。
- 当前内容：**8 个领域、114 个工具**（51 个已绑定 skill + 4 个可浏览 MCP server 的 63 个工具；`tavily` / `exa` 作为 `web_search` 的 internal provider 不再进入展示层）。

## 二、磁盘契约

```text
agent-client/toollibrary/          ← TOOLLIBRARY_ROOT（模块相对，不可配置）
├── index.md                       ← L1：`- <领域>：<描述>`
├── cli.md                         ← L1.5：`- <command>（skill：<id>）：<描述>`（已安装 CLI 的一行广告）
└── <领域>/                        ← 领域目录（目录名 = 英文领域名）
    └── index.md                   ← L2：`- <name>（<kind>：<id>）：<description>`
```

规则：

- **领域**：`TOOLLIBRARY_ROOT` 的直接子目录（忽略 `.` 开头）；领域目录内**只有 `index.md`** 被读取，其它文件忽略。
- **条目语法**：`- <name>（skill：<skill-id>）：<description>` 或 `- <name>（mcp：<public-tool-name>）：<description>`；全角/半角括号与冒号都接受。
- **非 bullet 行**（标题、空行、说明文字）忽略；bullet 但语法不匹配 → `malformed_entry` warning 并跳过。
- **name**：展示名，建议 ≤120 字符（超出 warning）；允许中文。
- **description**：必填，建议 ≤700 字符（超出 `description_exceeds_budget` warning）；它就是模型在 L2 做选择的主要依据。
- **kind**：只接受 `skill` / `mcp`。
- **id**：`skill` 为 `skills/` 下的目录名（等于 `slug(name)`，如 `scanpy`、`bio-seq`）；`mcp` 为 MCP 公开名（如 `tavily_tavily_search`、`context7_resolve-library-id`）。
- L1 的领域顺序 = 根索引顺序；磁盘上未列出的领域按目录名排序追加并返回 `unlisted_domain`；索引有而磁盘无返回 `unknown_domain` 并丢弃。
- L1 有两个消费方，共用 `readDomainIndex()`：`toollibrary()` fallback 返回带 `tools` 计数与 warning 的运行时视图；system prompt 只渲染 name/description，不含计数、也不含 warning。
- 同一领域内重复 id 首条为准 + `duplicate_entry_id`；跨领域重复同一 id 视为前一个领域已收录，后一个隐藏；重复 name 返回 `duplicate_entry_name`。
- `TOOLLIBRARY_ROOT` 定义在 `backend/src/paths.ts`：`path.join(AGENT_CLIENT_ROOT, 'toollibrary')`。

## 三、可见性与漂移

可见集合来自 `AgentChatRequest`：

- skill：`resolveAgentSkills` 的「已启用 ∩ 已绑定」交集（与旧 `load_skill` 的默认目录规则一致，但现在覆盖全部绑定 skill）。
- MCP 工具：`connectServers(request.mcpServers)` 返回的已连接 server 的工具（`mcpServerIds` ∩ `enabled`），再**排除 `mcp.json` 中 `internal: true` 的 server**（当前 `tavily` / `exa`；过滤在 `RuntimeToolDispatcher.toolLibrarySnapshot()`，工具与 MCP 资源都不可见、不可 `toolload`）。

合成与过滤：

| 情况 | 行为 | warning |
| --- | --- | --- |
| 条目 id 可见 | 保留 | — |
| 条目录了但不可见（未绑定 / 已停用 / 不存在） | 隐藏 | `unknown_tool` |
| 可见能力没写进任何领域文件 | 进入运行时兜底领域 `Unclassified`（L1 最后一项） | `unlisted_tool` |
| 领域目录缺 `index.md` | 领域仍存在但 0 工具 | `missing_domain_index` |
| 领域内没有任何可见工具 | 从**运行时 L1 fallback** 和 **system prompt 的静态 L1** 都隐藏（直接调用该 domain 仍返回空 catalog） | — |

> **静态 L1 vs 运行时 L1**：system prompt 在 MCP 连接之前装配（`AgentContextResolver.resolve()` → `AgentRuntime.chat()` 才 `connectServers`），拿不到实时工具集，因此静态 L1 只能按**已解析的绑定**过滤：skill 用 `resolveAgentSkills()`（enabled ∩ bound），MCP 用 `resolveAgentMcpServers()`（enabled ∩ bound）的 server id 去匹配条目里的 `<server>_` 公开名前缀。它不带 `tools` 计数，也不做工具级校验——只回答“这个域里有没有属于我的东西”。带 `domain` 的 L2 仍按本表逐条过滤；两者的领域顺序由同一个 `readDomainIndex()` 保证一致，且过滤后一个域都不剩时 `<tool_library_domains>` 整段缺席。

warning 上限 20 条，超出追加 `N more warnings omitted.`。

## 四、工具协议

### `toollibrary`（浏览）

| 调用 | 返回 |
| --- | --- |
| `toollibrary({action:"select"})`（默认） | biod 选一个能力并在同一调用内加载：`{ ok, action:"select", selected:{id,name,kind,description,domain}, load:{…}, decision:{…} }` |
| `toollibrary({action:"catalog", domain})` | `{ ok, action:"catalog", domain, entries:[{name, kind, id, description}], total, offset, limit, has_more, warnings:[] }` |
| `toollibrary({action:"index"})` / 回落 | `{ ok, action:"index", domains:[{name, description, tools}], warnings:[] }` |

- **默认路径由 biod 决策**（`action` 省略 = `select`）：候选 = 当前 agent 可见能力的实时快照；biod 选中后直接 `toolload`，结果只含选中的能力（skill 正文 / MCP schema + 登记）。`tau`、`noToolMargin` 见 `config/biod.json`。
- **选择权随角色绑定退化**（2026-11-01）：`toollibrary` / `toolload` 始终注入角色上下文。角色在 `coreToolIds` 里绑定了 `toollibrary` 才把 `select` 交给 biod；未绑定时 `select` 不调用 biod，直接返回 `index`/`catalog` 浏览结果并追加 `biod={status:"off",reason:"not_configured"}`，由模型自行 `catalog` → `toolload`。biod 失效的回落路径与它完全一致。
- 低置信、`NO_TOOL`、sidecar 失败或版本不匹配时**回落**到 `catalog`/`index`，只在结果里追加 `biod` 元数据；回落响应与接入前同形。
- `catalog`/`index` 不调用 biod，是显式浏览路径。详见 `docs/biod-integration.md`。

- 正常路径只读 L2：模型从 system prompt 的 `<tool_library_domains>` 选一个精确领域名传入。
- `toollibrary()` 是运行时索引 fallback：当 prompt 段缺失（展示层读不到）或模型怀疑存在未列出的能力时使用；`domains[].tools` = 该领域对当前 agent 可见的工具数，`Unclassified` 只在该领域非空时出现。
- L2 按 `name` 的 Unicode 码点升序、`id` 次键排序；`offset` 默认 0，`limit` 默认 100、上限 200；单页同时受 **30 000 字符**预算约束（首条总是返回），`has_more` 提示翻页。
- 未知领域返回 `{ok:false,error}`：提示从 `<tool_library_domains>` 取精确领域名，或调用无参 `toollibrary()` 读取运行时索引。

### `toolload`（加载）

| 参数 | 行为 | 成功返回 |
| --- | --- | --- |
| `id`（skill） | 返回 SKILL.md 正文 + 资源（同旧 `load_skill` 的 `skill` action） | `{ ok, action:"skill", skillId, skillName, content }` |
| `id`（MCP 公开名） | 把该工具 schema 登记进**下一轮** `tools`，不执行远端工具 | `{ ok, action:"mcp_tool", id, loaded, alreadyLoaded }` |
| `resource` + 可选 `server` | 读取一个 MCP 资源 | `{ ok, action:"mcp_resource", server, uri, content }` |
| `server`（省略 `resource`） | 列出该 server 的资源 | `{ ok, action:"mcp_resource", server, resources:[…] }` |

- `id` 与 `resource`/`server` 互斥；三者都缺 → `{ok:false,error}` 引导回 `toollibrary`。
- skill 匹配顺序：精确 id → 归一化 name 精确 → 唯一子串；歧义失败。MCP 匹配：精确公开名 → 唯一 raw 工具名后缀（`x` 命中 `<server>_x`）。
- `mcp_resource` 的 URI 在多个 server 重复时必须显式传 `server`；读取失败原样透传。
- `content` 不是 SKILL.md 原始字节：由 `formatLoadedSkill` 拼成 `## Skill: <name>` + 重新序列化的 frontmatter/正文 + 资源清单；文本资源单条截断到 4 000 字符、总计最多 8 000 字符，超出的与 base64 资源只列文件名/类型/大小。

## 五、预算与 loadedCapability

- system prompt：`<tool_library_domains>` 全量约 **1.5k 字符**（8 个领域），按角色过滤后只含该角色能用的域（PI 8 个、Researcher 7 个、Reviewer 6 个、Searcher/Writer 各 5 个）。同一角色每次请求恒定、可被 provider prefix cache 复用；L2 目录与正文仍只在工具结果里出现。
- 观测层：`INLINE_RESULT_CHARS_BY_TOOL` 给 `toollibrary` 设 **30 000**、`toolload` 设 **70 000** 字符；超过后才落盘为 run 的 Observations 文件。`toolload` 的正文上限依赖「正文 + 8 000 字符资源」的当前规模（最长约 6.2 万字符）。
- `agent_runtime.ts` 的 `getLoadedCapability` 识别 `toolload` 结果：`skill` → `{kind:'skill',id}`，`mcp_tool` / `mcp_resource` → `{kind:'mcp',id}`，资源清单不上报。它驱动 run 的 `loadedTools`/`loadedSkills`、compaction 的 `loadedCapabilitiesRemovedFromContext` 与 transcript 回放。
- `AgentService.trackLoadedCapability` 的历史回退解析同时接受 `toolload` 与旧 transcript 里的 `load_skill`。

## 六、与配置 / 管理面的关系

- 运行时**不写** `agent-client/toollibrary/`：没有写入口，目录靠 git 维护。
- **Agent 设置页按域展示**：`/api/settings` 返回 `toolLibrary.domains`（`agent_capability_catalog.ts` 只读投影：领域名/描述 + 每个条目的 name/description/是否可用），前端 `CapabilityChecklists.jsx` 按领域渲染。技能勾选项落到 `agents.json` 的 `skillIds`；MCP 条目按公开名反向解析到所属 server（最长前缀匹配），勾选落到 `mcpServerIds`——因此勾选任一 MCP 工具等于启用该服务器，页面文案已说明。
- **只读 Tool Library 页**：`/api/settings` 的 `toolLibrary` 同时被只读目录页消费（`web/src/components/settings/ToolLibrarySettings.jsx`）：展示全部领域与条目、kind、可用/启用状态与所属 server，无写操作；能力绑定仍在 Agent 设置页。
- **`Unclassified` 兜底域**：设置页把「磁盘领域未收录」的技能/MCP 服务器（含 `internal` 的 tavily/exa 与已禁用 server）放进该域，保证保存表单不会静默解绑配置里的能力；这与运行时合成的 `Unclassified` 是同一语义、两个消费者。
- skills 的导入/删除与 MCP 的导入/删除仍走既有 API（前端只读，无管理入口）；`skills/move` 与目录管理端点已随目录树移除。这些操作**不会**自动更新展示层文件。配置变化后由人同步领域文件，未同步的能力走 `Unclassified` / `unknown_tool` 兜底。
- Skill 目录树已退役：`skill.directory` 与 `skillpack.md` 已删除，skill id 即根目录名（`slug(name)`）。

## 七、测试覆盖

| 测试 | 覆盖 |
| --- | --- |
| `backend/test/toollibrary_executor.test.ts` | 临时根：索引解析、漂移 warning、可见性过滤、兜底领域、分页与 30k 预算、skill/MCP id 解析、坏条目、缺根；`readDomainIndex()` 单一合成规则；`renderToolLibraryDomainIndexPrompt()` 的顺序/描述/计数缺席/缺 root 返回 null，以及按 visibility 过滤时 skill 精确匹配、MCP 前缀匹配、全空返回 null、不传 visibility 保持全量 |
| `backend/test/toollibrary_content.test.ts` | 仓库内容契约：领域覆盖与排序、36 个绑定 skill 恰好各一次、MCP 条目前缀、name/description 预算、无重复 id |
| `backend/test/core_tools_runtime.test.ts` | 两个 schema 的参数、prompt、dispatch、risk、审批放行；description/prompt 引用 `<tool_library_domains>` |
| `backend/test/system_prompt_provenance.test.ts` | system prompt 含 `<tool_library_domains>`、lead 角色的 8 个领域全部预注入、section `kind='tool-library'`/source 正确 |
| `backend/test/tool_library_prompt_scope.test.ts` | 每个角色渲染出的 L1 域集合 == 该角色绑定下“至少有一条可见条目”的域集合；窄角色严格少于 lead；块内无 `Unclassified`、无工具计数 |
| `backend/test/prefix_stability.test.ts` | 领域索引为静态段，跨 run 逐字节不变 |
| `backend/test/runtime_tool_dispatcher.test.ts` | `toolload` 的 skill/MCP schema/资源分支与参数互斥；无参 fallback 路由；未配置 CoreTool 的拒绝 |
| `backend/test/agent_capability_catalog.test.ts` | 设置页按域投影、`Unclassified` 兜底、MCP 公开名到 server 的最长前缀匹配 |
| `backend/test/mcp_lifecycle.test.ts` | 首轮工具集合包含 `toollibrary`/`toolload`、不含旧 `load_skill`、description 引用 `<tool_library_domains>` 且不含 `<mcp_catalog>` |
| `backend/test/observation_manager.test.ts` | 浏览页 30k / 加载 70k 内联预算 |
| `web/test/tool_kind.test.mjs` | 卡片分类映射 |

## 八、已知缺口

1. **无写入口**：领域目录靠 git 与手写维护；Agent 设置页只做投影与能力绑定，不写 `toollibrary/`。增删 skill/MCP 后需要人工同步领域文件，并会让 system prompt 的 L1 段变化（prefix cache 失效，属可接受的配置变更）。
2. **无缓存 / watcher**：每次调用重新读盘；当前 7 个文件，规模可接受。
3. **无全文搜索**：只有两层浏览；模型不知道关键词属于哪个领域时可能漏检。
4. **MCP 工具集变化不可见**：展示层不会自动发现新工具；已连接但既没列出、也没出现在任何目录里的工具不会触发 warning。
5. **无 per-agent 领域视图**：领域归属仍是全局文件，不随 agent 变化；per-agent 的只有 L1 的**过滤**（按绑定决定哪几个域出现），不是按 agent 定制域内容。
6. **资源不参与展示层**：MCP 资源只能通过 `toolload({server})` 现场列举。
7. **`Unclassified` 是运行时合成领域**：不会写回磁盘，也不参与排序稳定性（永远最后）；它只出现在无参 fallback 的结果里，不在静态 L1 中。
8. **L1 的 MCP 可见性是 server 级近似**：prompt 装配时没有连接结果，只能用 `<server>_` 前缀判断；若某 server 的某个工具已被上游删除，域仍会因该 server 的其他条目而保留，L2 才会暴露 `unknown_tool`。

## 九、一手来源索引

| 主题 | 位置 |
| --- | --- |
| 展示层根常量 | `agent-client/backend/src/paths.ts`（`TOOLLIBRARY_ROOT`） |
| 工具名常量 | `agent-client/backend/src/agent/core_tools/ids.ts`（`TOOLLIBRARY_*` / `TOOLLOAD_TOOL_NAME`） |
| 解析 / 可见性 / 分页 / 加载 / L1 渲染 | `agent-client/backend/src/agent/core_tools/toollibrary_executor.ts`（`readDomainIndex`、`renderToolLibraryDomainIndexPrompt`） |
| system prompt 装配 | `agent-client/backend/src/agent/service/agent_context_resolver.ts`（`kind='tool-library'`） |
| schema、注册表条目、dispatch 元数据 | `agent-client/backend/src/agent/core_tools_runtime.ts`、`runtime_tool_dispatcher.ts` |
| 观测预算 | `agent-client/backend/src/agent/observation_manager.ts`（`TOOLLIBRARY_INLINE_RESULT_CHARS`） |
| loadedCapability | `agent-client/backend/src/agent/agent_runtime.ts`（`getLoadedCapability`） |
| 设置页域投影 | `agent-client/backend/src/agent/config/agent_capability_catalog.ts`、`web/src/components/settings/CapabilityChecklists.jsx` |
| 展示层内容 | `agent-client/toollibrary/**` |
| 作者指引 | [`development.md`](development.md) 的「新增能力库条目（toollibrary）」 |
