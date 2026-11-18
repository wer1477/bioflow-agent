# Context 机制

> 基线：`0b50110`（`chore: stop tracking workspace conversation history`）
> 范围：`agent-client/backend/src/agent/context_manager.ts`、`context_window.ts`、`observation_manager.ts`、`config/context_store.ts`，以及三处调用方（`service/agent_context_resolver.ts`、`service/agent_service.ts`、`agent_runtime.ts`）。
> **2026-11-01 临时变更**：`history_lookup` 已从运行时下线（schema、注册、dispatcher 分支、模型提示词引用一并删除）；§8.2 的回读链路当前不可用，`config/context_store.ts` 的 `lookupConversationHistory` 保留待重接。本文其余提到该工具的位置均按此注记理解。
> **2026-11-01 累积变更**：模型输入不再只由 `messages`（UI 聊天记录）投影——新增 append-only 的 `contextMessages`（`config/context_message_store.ts`）：每个模型步一条 assistant（含 tool_calls）、每条工具结果一条 tool，run 结束不再丢弃；装配按 `seq` 全量重放，旧会话首次运行从 `messages` 惰性播种。窗口与水位线（0.6/0.8）未改，也没有新增压缩。
> 本文描述**当前实现事实**，用于修改上下文行为前的第一事实来源核对；文中标注了带实测证据的已知缺口。
> 「主循环什么时候因上下文压力收敛」「工具批次如何分岔」属于循环职责，见 [`agent-loop.md`](agent-loop.md)；本文按**装配生命周期**补齐其未展开的机制（全量装配、冷区分流、`history_lookup` 分类、checkpoint 结构与失效、观测降级流水线）。

## 一、结论速览

- 「上下文」在本项目是**五层叠加**：静态运行时上下文（进程内对象）→ 持久化会话记录（磁盘事件日志）→ **append-only 模型转录 `contextMessages`**（每个模型步 + 每条工具结果）→ 装配后的模型输入（每 run 按 `seq` 重放）→ 运行内累积（循环内 `push`）。
- **固定开销**是主体：`system prompt`（Agent 人格 + CoreTool 目录 + **tool library 领域索引** + **pinned workspace 块**）+ Agent 已配置的 CoreTool schema。Skill / MCP 的 L2 目录与正文不常驻，只有约 1.3k 字符的 tool library L1 领域索引常驻。实测空 workspace 会话的 system prompt 为 **2,395 tokens**，而带有 9 个观测产物的会话为 **41,799 tokens**——其中 **94%** 来自 artifact 摘要注入，合计占该会话总预算的 **83%**（口径见 §3.2 的过时说明）。
- **可缓存前缀（2026-10 起）**：`systemPrompt` 在同会话内**逐字节不变**——当前日期与产物列表已移出 system，改由 `pinnedTail` 在用户消息前以 user 角色注入。配合 provider 的前缀缓存，每个 run 的首个请求只需为新增的几十行付费，见 §十二。
- **水位线以下一条不丢**：装配发送全部历史，不再有滑动窗口。「丢弃」只作为压缩动作的一部分发生，且只在预算真正被突破时发生（2026-10 起，见 §5.2、§6.2）。被归档的内容**当前无法回读**（`history_lookup` 已临时下线，见 §8.2）。
- 水位判定采用**两套限制**：输入预算 = `window − reservedOutput`，`reservedOutput` 按窗口比例预留（`max(1_024, window×0.2)`，且不超过 requested 与 `window/2`，§4.3）。窗口 ≥40k 时输入上限恒为窗口 80%；窗口更小时预留按比例收缩，不再塌缩（缺口 3 已修）。
- 压缩分两层：**运行内**（临时、LLM 摘要、只留在 `messages` 数组）与**运行后**（持久 `ContextCheckpoint`，含机械提取的 `programState` + 结构化 `modelSummary`）。checkpoint **不再注入请求**（那会让同一段内容既发原文又发摘要），而是作为下一次压缩的起点被复用；只有最新一条有效。
- 长工具结果**不原样进上下文**：默认 ≤6,000 字符走原文（`inline`），超过即降级为「JSON 元数据 + 摘要 + 前 6,000 字符 + 回读指引」，完整内容由 transcript 内容寻址 blob 持有，**当前不回读**（`history_lookup` 已临时下线；`observation_manager.ts`、`config/context_store.ts`）。唯一例外是 `knowledgebase`：它的结果内联上限是 **30,000 字符**（知识库目录/条目要一次完整交付），超过才走同一降级流水线。
- `pinnedFingerprint` 在**复用前**比对校验（§7.3）：agent / system prompt / CoreTool / MCP / Skill 任一变化都视为失效，旧 checkpoint 不再作为压缩起点。`workspace artifact.summary` 无长度上限，是固定开销失控的直接原因（缺口 2）。

## 二、四层上下文模型

| 层 | 载体 | 生存期 | 变更时机 |
| --- | --- | --- | --- |
| **① 静态运行时上下文** | `AgentRuntimeContext` 进程内对象 | 单次请求 | 每请求由 `agentContextResolver.resolve()` 重算（`agent_context_resolver.ts:52-98`） |
| **② 持久化会话记录** | `<WORKSPACE_ROOT>/.sessions/<projectKey>/<sessionId>/history.jsonl` + `session.json` | 跨进程 | `createMessage` / `updateMessage` / `createContextCheckpoint` 追加补丁；**但每次 run 结束（completed/error）会无条件折叠为单条 snapshot，因此该文件并非 append-only**（`agent_service.ts:385-387`）。真正 append-only 的是 `transcript/events.jsonl` |
| **③ 模型输入** | `ChatCompletionMessageParam[]` | 单 run | 进入循环前装配一次（`agent_service.ts:74-79`），循环内被就地压缩改写 |
| **④ 运行内累积** | 同上数组 + `tool` 角色消息 | 单 run | 每轮 `push` assistant(`tool_calls`) / `tool` 结果（`agent_runtime.ts:185`、`:393`） |

关键区分：**上下文装配发生在 `AgentRuntime.chat()` 之外**。循环收到的 `request.messages` 已是本次 run 的完整历史；循环本身不读会话存储，只对自己持有的数组做压缩（`agent_runtime.ts:136-147`）。跨 run 的连续性由 ② 承担——装配发送全量历史，压缩只发生在本 run 真正超额时。

② 采用追加补丁 + 定期折叠的写放大控制（`config/conversation_file_store.ts:10-19`、`:181-195`）：补丁数达 **500**、或文件 ≥**1 MiB** 且快照后补丁 ≥**100** 时，`compactRecord` 把日志整体重写为一条 `snapshot`。这是**存储层**压缩，与 §六/§七的**模型上下文**压缩是两件独立的事——前者只影响磁盘体积与读取成本，不改变送进模型的内容。

```text
AgentService.runCompletion()                       agent_service.ts:43
  ├─ prepareConversationHistory()                  写入用户消息 → 取回全部历史（去掉刚写的最后一条）
  ├─ agentContextResolver.resolve()                ① 静态上下文
  ├─ RuntimeContextManager.buildManagedHistory()   ③ 全量历史 + 预算（不裁剪、不注入 checkpoint）
  └─ AgentRuntime.chat()                           循环：每轮重算预算 → 压缩/熔断 → 模型 → 工具
        └─ compactRuntimeMessages()                ④ 运行内压缩（改写本地数组）
  完成后（水位曾超）：
  └─ RuntimeContextManager.compactAfterRun()       ② 写 ContextCheckpoint 到会话记录
```

## 三、① 静态运行时上下文

### 3.1 system prompt 的五段构成

`buildRuntimeSystemPrompt`（`agent_context_resolver.ts`）按顺序拼接，全部落在**唯一一条** system 消息里：

| 段 | 来源 | 每 run 重建 | 同会话内恒定 |
| --- | --- | --- | --- |
| Agent 人格 | `agent.systemPrompt` / `prompts/pi.md`（`buildAgentSystemPromptParts`） | 是 | ✅ |
| 内置指引（planning 协议等 5 条） | 代码内常量（`buildAgentSystemPromptParts`） | 是 | ✅ |
| CoreTool 提示片段 | `buildCoreToolsCatalogPrompt`，仅 Agent 已配置（`coreToolIds`）的 CoreTool `prompt` 字段 | 是 | ✅ |
| tool library 领域索引 | `renderToolLibraryDomainIndexPrompt(TOOLLIBRARY_ROOT)`：`toollibrary/index.md` + 磁盘领域，`kind='tool-library'`；仅当 `toollibrary` CoreTool 已配置时注入 | 是 | ✅（仅索引文件变化时变） |
| pinned workspace 规则 | `formatWorkspacePrompt(workspace)` | 是 | ✅（会话内路径不变） |

> 领域索引进 system prompt 是 2026-10-31 的改动：L1 只有约 1.3k 字符且由人策展，常驻后可省掉“先调 `toollibrary()` 才知道有哪些域”的发现 turn；L2 目录与正文仍按需加载（见 [`toollibrary-mechanism.md`](toollibrary-mechanism.md)）。

**变的那两块已经不在 system 里了**。当前日期与最近产物列表由 `buildPinnedTail`（`:304-323`）生成，运行时在用户消息前以 user 角色注入（`agent_runtime.ts:144-152`）：

```text
messages[0]   system（上述五段，逐字节恒定）
messages[1..] 历史 / checkpoint
messages[k]   user: <runtime_context_snapshot>  当前日期
messages[k+1] user: <recent_project_artifacts> 最多 20 条产物（有产物时）
messages[k+2] user: 本轮输入
```

设计动因是 provider 前缀缓存**只从 token 0 起匹配**：任何字节变化都会让其后全部内容失效。把易变块放在历史之后，代价从“整段历史重算”降为“几十行重算”。语义上不受损——`<pinned_project_workspace>` 仍声明这些块是系统事实、不得当作压缩摘要的替代，而它们每 run 重新注入，因此无需“幸存”于压缩；run 内压缩另有提升规则把它们从冷段捞出（`context_manager.ts:290-337`，见 §十二）。

### 3.2 artifact 摘要的膨胀路径（历史实测，口径已变）

> **2026-10 更新**：本节数字采集于 `0b50110`。当时 `createObservation` 会把观测写入项目 workspace 并注册为 artifact，`artifact.summary` 因此把前 12 行原文带进每请求的 system prompt。
> 当前 HEAD 的 `createObservation` **不再注册 artifact**（`observation_manager.ts:42` 的 `artifact` 字段全仓没有任何赋值点），这条路径已不成立；仍存在的同源风险是 `planning` / `analysis_kernel` 产出的 artifact 带无长度上限的 `summary`。
> 同时产物列表已移出 system prompt、进入 `pinnedTail`，因此即使膨胀，也不会再摧毁可缓存前缀——但**仍会占预算**。以下数字保留作为“为什么必须给 summary 设上限”的证据。

`formatWorkspacePrompt` 取 `workspace.artifacts.slice(0, 20)`，每条输出：

```text
- {title} ({type}): {path}{summary ? ` - ${summary}` : ''}
```

`artifact.summary` 来自 `createObservation` 的 `buildTextObservationSummary`（`observation_manager.ts:119-137`），它把**前 12 行非空内容**原样嵌入摘要，可能长达数千字符。而 `formatWorkspacePrompt` **只限制条数（20），不限制单条长度**。

实测会话 `4616fef6`：9 个 `observation` 产物的 `summary` 合计 **121,339 字符**，全部进入每请求的 system prompt。

| 指标 | 实测值 |
| --- | --- |
| 9 个 artifact 的 `summary` 总字符 | 121,339 |
| 同上估算 tokens | 39,406 |
| 其中最长一条 | 21,454 字符（`exec_command_obs_36a8e5ae5909`） |
| system prompt 总字符 | 130,363 |
| system prompt 估算 tokens | 41,799 |
| 该会话 `messages` 估算 tokens | 5,391 |
| 总预算 | 47,202 / 1,000,000（4.76%） |

**校验**：`41,799 − 39,406 = 2,393`，即该 system prompt 中非 artifact 摘要的部分。而同行空 workspace 会话的 system prompt 实测为 **2,395 tokens**（多出的约 2 tokens 是 `Recent workspace artifacts: none` 与有产物时段落的措辞差异）。两条独立测量互相印证：**基座恒定且很小，而 artifact 摘要占了 system prompt 的 94%、该会话总预算的 83%**。

### 3.3 三个 Skill 相关的可见性边界

- Skill / MCP 能力的 name + description 已移入 CoreTool `toollibrary` 的两层展示层，不再进 system prompt；正文/工具 schema 必须用 `toolload` 读取。
- `skill-catalog` 与 `skill-directories` 两个 prompt section kind 已删除；运行期装配只剩 agent prompt / guidance / core-tools / workspace 四类块。
- 结论：Skill 的**内容不占常驻上下文**，被移出上下文的已加载 Skill 由 `programState.loadedCapabilitiesRemovedFromContext` 记账（见 §7.2）。

## 四、Token 估算与校准

### 4.1 字符启发式

`estimateTextTokens`（`context_manager.ts:411-438`）按 Unicode 脚本分四类字符加权求和：

```text
tokens = ceil( CJK × 1.15 + 拉丁数字 ÷ 3.8 + 空白 ÷ 8 + 其他 ÷ 2.2 )
```

实测验证（与实现注释一致）：

| 样本 | 字符数 | 估算 tokens | chars/token |
| --- | --- | --- | --- |
| 纯英文句子 | 63 | 16 | 3.94 |
| 纯中文句子 | 25 | 29 | 0.86 |
| Python 代码片段 | 31 | 8 | 3.88 |
| 基因 ID / 坐标 | 37 | 10 | 3.70 |
| 纯空格 | 32 | 4 | 8.00 |

CJK 走独立系数是必要的：生信对话里中文提问与中文结论文本占比高，若统一按 ÷3.8 会系统性低估约 4 倍。

**计费口径是整条序列化消息**，不只是 `content`——ASSISTANT 的 `tool_calls` 参数在 `content` 之外（`context_manager.ts:201-203` 注释与 `test/context_manager.test.ts:12-25` 覆盖）。`estimateToolsTokens` 另按 `JSON.stringify(tools)` + 每工具 12 tokens 计（`:405-409`）。

### 4.2 P90 校准

启发式必然有偏差，故用 provider 回传的 `usage.prompt_tokens` 校正（`context_manager.ts:379-403`）：

- 记 `observed / heuristic` 比值，按 `baseUrl + model` 分桶，保留最近 **24** 次（`TOKEN_USAGE_OBSERVATION_LIMIT`）。
- 取 **P90**，并 `Math.max(1, p90)` —— **只保守、不放宽**，避免低估导致超窗。
- 比值本身 clamp 到 `[0.25, 4]` 防止异常观测污染。

循环每收到一次 `usage` 即 yield `loop_health{reason:'token_usage_observed'}`，把该轮 heuristic 与校准后倍数一并暴露（`agent_runtime.ts:364-382`）。

### 4.3 输出预留（水位判定的关键）

`resolveReservedOutputTokens`（`context_manager.ts:451-469`）：

```ts
const requested = configured > 0 ? configured : 8_000;   // 配置值或缺省值
const proportional = Math.max(1_024, floor(window * 0.2)); // 比例下限
return Math.max(1, Math.min(requested, proportional, floor(window / 2)));
```

早期实现是 `min(requested, max(8_000, window × 0.25))`——外层取 min、内层却是 `max(8_000, …)`，**8,000 成了硬下限**，小窗口直接塌缩。2026-10 改为比例式，并把预留封顶在窗口的一半。代入实测：

| 窗口 | reservedOutput | contextLimit | 说明 |
| --- | --- | --- | --- |
| 1,000,000 | 8,000 | 992,000 | 20% = 200k，取 requested |
| 200,000 | 8,000 | 192,000 | 同上 |
| 64,000 | 8,000 | 56,000 | 20% = 12.8k，仍取 8k |
| 32,000 | 6,400 | 25,600 | 20% = 6.4k < 8k，比例开始生效 |
| 16,000 | 3,200 | 12,800 | 原先只留 8,000 |
| 8,000 | 1,600 | 6,400 | 原先 `contextLimit = 1` |
| 4,000 | 1,024 | 2,976 | 1,024 下限生效 |
| 1,000 | 500 | 500 | 半窗口上限生效 |

由此得出：窗口 **≥40k** 时硬水位对应的输入上限仍是窗口的 80%（8,000 恰好是 40k 的 20%）；窗口更小时预留按比例收缩，输入预算始终 ≥ 窗口的一半，任何已接受的窗口配置都有可用预算。这解释了 `agent-loop.md` 所述「收敛靠上下文压力」在超长窗口下为何总是推迟到约 80% 才发生——1M 窗口下预留只占 0.8%，几乎不参与。

## 五、③ 每请求装配：`buildManagedHistory`

`RuntimeContextManager.buildManagedHistory`（`context_manager.ts:58-105`）是上下文装配的唯一入口，被三处调用：正式运行（`agent_service.ts:74`）与两个共享 `resolveManagedContext` 的只读探针——`GET /api/conversations/:id/context-budget` 和 `GET /api/conversations/:id/stats`（`routes/conversations.ts`）。

### 5.1 组装顺序

```text
[ system prompt（四段，同会话内恒定） ]                 ← request.systemPrompt
[ ...全部历史，逐条 {role, content}... ]                ← 不再裁剪
[ user: <runtime_context_snapshot> 当前日期 ]           ← request.pinnedTail[0]
[ user: <recent_project_artifacts> 最近产物 ]           ← request.pinnedTail[1]（有产物时）
[ 当前 userMessage ]                                   ← 由 agent_runtime 追加
```

`buildManagedHistory` 只负责前三行；`pinnedTail` 与当前用户消息由 `agent_runtime.chat()` 追加（`agent_runtime.ts:144-152`）。

**checkpoint 不在这里注入**。装配发送全量历史，若同时追加一条摘要，同一段内容会被付费两次（原文一次、摘要一次）。checkpoint 改为走 `AgentChatRequest.priorCheckpoint` 交给运行时：只有本 run 真的要压缩时，它才作为 `previousCheckpoint` 进入摘要提示词。0.6 软水位写出的 checkpoint 因此只承担「预计算」职责，不产生任何上下文成本。

### 5.2 不再裁剪历史（2026-10 变更）

旧实现是从尾部取 `min(20_000, max(6_000, window × 0.25))` token 的滑动窗口。它与水位线是两套互不相干的判断，后果是：窗口大于约 80k 时，每轮都在丢 20k 之外的历史，而窗口占用率永远到不了 0.6——**丢弃发生了，摘要一次都没生成**。实测 677 个会话、681 次 run：压缩 0 次、checkpoint 0 个。

现在装配只做两件事：全量历史 + 预算估算。「全量历史」指 `contextMessages`（旧会话回退到 `messages`）：模型上一步看到的 assistant tool_calls 与 tool 结果会在下一次 run 原样重放，不再只留一份文本总结。由此产生三条结论：

1. 首个请求若已 ≥0.8，运行时在第 1 轮顶部就会压缩（`shouldCompactInRun` 在首次模型调用前判定），不需要新的调用点；
2. 装配不再插入 `Older conversation history is available through history_lookup.` 这句提示——没有东西被裁掉，这句话会让模型去找已经存在的内容；
3. 预算由 `llm.json` 的 `contextWindowTokens` 决定，它在这里的含义是「单次请求愿意花多少」，可以低于模型物理上限。窗口下调，压缩就更早发生。

> 2026-10 起 `contextMode`（`minimal` 4 条 / `focused` 10 条 / `full`）整条维度已删除：当前只有 `main` 一个 agent，实际一直用 `full`，而「保留 N 条」与 token 预算不可换算。旧 `agents.json` 中的同名字段被忽略。

### 5.3 预算快照

装配完成后立即算一次 `estimateContextBudget`（含 `systemPrompt`、全量 `messages`、当前 `userMessage`，**并把常驻工具 schema 一并计价**），存入 `ManagedHistory.budget`，并以 `loop_health{reason:'context_watermark_exceeded' | 'context_watermark_checked'}` 事件对外暴露完整分解（`formatBudgetStatus`，`:414-433`）。

**是否在 run 结束写 checkpoint 由 run 自己决定，不读装配快照**：运行时每轮回报预算、结束时再回报一次（`onRuntimeContext`），service 用**最后一次**预算判断 `softExceeded`。装配快照只描述第一个请求，看不到这个 run 后来长到了多大；用粘性标记“曾经超过”会让一个已经回落的 run 仍然付一次摘要调用。

> **口径（2026-10 起统一，2026-11-01 按 Agent 配置调整）**：装配快照与循环内每轮预算用**同一个 builder** 取常驻 schema——上下文侧 `buildResidentTools(context.coreTools 的 id)`、运行时侧 `buildResidentTools(agent.coreToolIds)`（`resident_tools.ts`）。schema 集合随 Agent 配置变化：注册表当前 11 条定义、20 个静态 schema（`shell` 3 个、`file` 4 个、`goal` 3 个、`search` 2 个、`toollibrary` 2 个，其余各 1 个，见 [`core-tools.md`](core-tools.md)），未配置的定义不计价也不注入。此前装配侧不传 `tools`、把 schema 记为 0，导致 `/context-budget` 与前端 `ComposerStats.jsx` 显示的比例**系统性偏低约 3k tokens**（1M 窗口下 0.3%，16k 窗口下不可忽略）。
>
> 仍存在且已显式标注的差异：`toolload` 在运行中装入的 MCP schema **只出现在后续轮次的预算里**，装配快照不可能预知。因此 `ContextBudgetStatus.toolsScope` 区分 `'resident'`（装配）与 `'request'`（具体某一轮，含已装入的 MCP 工具），`formatBudgetStatus` 输出 `tools_scope=` 便于对照。

工具消息里的图片不按 base64 文本计入预算：`estimateContextBudget` 先用 `stripImageParts` 替换 `image_url` 部分，再按每张 `IMAGE_TOKEN_ESTIMATE = 1024` tokens 估算；transcript 只保存图片占位符，不保存 base64。

## 六、④ 运行内：每轮预算与压缩

每轮迭代开始都**重算**预算（`agent_runtime.ts:255-266`），此时口径与装配时略有不同：`systemPrompt: ''`、`userMessage: ''`，因为二者已在 `messages` 数组内；`tools` 则是**该轮真实发送的数组**（含 `toolload` 装入的 MCP schema），因此 `toolsScope = 'request'`。

### 6.1 两个水位

| 阈值 | 常量 | 动作 | 位置 |
| --- | --- | --- | --- |
| ratio ≥ **0.6** | `SOFT_WATERMARK` | 只发 `context_watermark_exceeded`，把本次 run 标记为「结束后写 checkpoint」；**不改写 messages** | `agent_runtime.ts:311-319` |
| ratio ≥ **0.8** | `HARD_WATERMARK` | 先就地压缩一次（`shouldCompactInRun`，每 run 最多 3 次尝试）；压缩后仍 ≥0.8、压缩失败或次数用尽 → 注入收尾提示 + **本轮撤掉整个 `tools` 字段** | `:266-310`、`:320-335` |

**为什么压缩只在 0.8 发生（2026-10 调整）**：压缩会重写 `messages[1..]`，而 provider 的前缀缓存只从 token 0 匹配，每一次压缩都让本次 run 后续所有轮次失去缓存，并额外付一次摘要调用。0.6 时窗口还有 40% 余量，没有立刻改写的必要；0.6 的职责是「标记这次 run 值得在结束后固化」，0.8 才是「不改写就继续不下去」的点。这也让两个水位各自只做一件事：**0.6 → 运行后持久 checkpoint；0.8 → 运行内续命**。

**次数上限**：`shouldCompactInRun(status, attempts)`（`context_manager.ts:110`）要求 `hardExceeded && attempts < MAX_RUNTIME_COMPACTIONS`。运行时没有 turn 上限，若不设限，长 run 可以「涨到 0.8 → 压缩 → 再涨」无限循环；**失败也计入尝试次数**，避免摘要器每轮失败、每轮重试、每轮付一次调用。次数用尽后守卫照常触发，detail 写明 `In-run compaction budget exhausted (3/3)`。

硬水位的关键后果（与 `agent-loop.md` 的收敛链路一致）：

```ts
const toolsForTurn = runtimeBudget.hardExceeded ? undefined : tools.length ? tools : undefined;
```

撤掉 `tools` 后模型无法再发起工具调用，只能输出文本，从而走正常出口。**这是收敛机制而非兜底报错**。

### 6.2 `compactRuntimeMessages`：冷区流水线

设计约束有两条：**不得破坏 tool-call 配对**，以及**不得在没有超预算时丢弃内容**。

```text
[system ...] │ 冷区（会被处理）           │ 尾区（原样重发）
             │                           │ min(40k, 0.25W, max(3%W, 20k))
```

1. **固定 system 前缀**永不压缩。
2. **切尾**：从尾部倒序累加，遇到 `tool` 消息继续回退到它的调用方，保证尾区不以孤儿结果开头（`cold_zone.ts: splitColdZone`）。
3. **冷区四通道**（`planColdZone`）：
   - `keep` 整组原文（结构完整）
   - `evidence` 只保留路径 / 命令行 / 错误串等不可改写的行
   - `index` 移出上下文，只留一行索引 + blob 指针
   - `summarise` 交给摘要器
4. **摘要**：`summariseColdZone` 对 `summarise` 组按 8k token 分块，逐块带着上一次的摘要递进，**覆盖整段冷区**（旧实现只读冷区末尾 24k 字符，更早的部分被丢弃却没有记录）。
5. **写回**：`[summary] + 保留的原文组（按时间序） + pinned 块 + 尾区`。

各段配额（`CONTEXT_POLICY`，`context_manager.ts`）：

| 段 | 公式 | 1M | 200k | 128k |
|---|---|---|---|---|
| 尾区 | `min(40k, 0.25W, max(0.03W, 20k))` | 30k | 20k | 20k |
| 冷区原文/证据 | `min(4k, 0.02W)`，最多 12 组 | 4k | 4k | 2.56k |
| 用户原话 | `min(8k, 0.05W)`，最近 10 条整条 | 8k | 8k | 6.4k |
| 摘要 | 3k | | | |
| 归档索引 | 1k，最多 80 条 | | | |

**用户原话不参与打分、不占冷区配额**：超额时只把最近 10 条以前的消息压成首行（规则切句），最近 10 条永远是原文。

**为什么证据行单独成通道**：摘要是复述，复述路径会变成错的路径、复述错误串会变成错的错误串。命中路径 / 文件名 / 命令行 / 错误串 / 数值结论的行在摘要之前先被抽出来（每组 ≤3 行、每行 ≤160 字），保留为精确文本。

**打分器的位置**：规则负责机械部分（打包、元信息、成败、重复、保真度、证据行），打分器只回答「这组对当下任务还重不重要」。规则先验是 `0.6×recency + 0.4×typeWeight`（`baselineScore`）；2026-11 起，当 `config/biod.json` 的 `context_retention.mode="select"` 且 sidecar 可用时，`buildBiodColdZoneScorer` 会**一次批量**给非 user 组打分并替换这一项；失败/禁用时完全不传 `scorer`，回到规则先验。配额、dropThreshold、证据行、摘要与归档逻辑都不变。详见 `docs/biod-integration.md` §七。

**摘要形态（2026-10 统一）**：run 内与 run 后共用 `SUMMARY_JSON_SCHEMA`；run 内注入时由 `formatRuntimeSummary` 渲染成紧凑文本（Goal / Status / Decisions / Facts / Pending / Next / **Archived**），run 后直接复用同一个对象落盘。

**摘要失败时的行为**：`summariseColdZone` 把「抛错」「空文本」「非 JSON」都视为失败，`compactRuntimeMessages` 返回 `{ compacted: false, degraded }` 并**原样返回输入消息**。调用方发 `loop_health{level:'warning', reason:'context_compaction_failed'}`，run 继续，硬水位守卫仍在后续轮次生效。

**压缩后的形状**：首条非 system 消息是 assistant（摘要），其后是按时间序保留的用户原话与高价值组，最后是尾区。原始首条 user 消息可能被移出——但只要它仍属于用户原话，就会以原文形式保留在保留段中。

## 七、② 运行后：持久 checkpoint

触发由 `planRunEndCompaction`（`context_manager.ts`）决定，输入是**run 结束时的运行内预算**和**run 内是否已产出摘要**：

| run 内有摘要 | 结束时 ratio | 动作 | LLM 调用 |
| --- | --- | --- | --- |
| 有 | <0.6 | `saveCheckpoint` 直接落盘（复用摘要 + 重新提取 programState） | **0** |
| 有 | ≥0.6 | 调一次摘要器，把已有摘要作为 `priorSummary` 带着走 | 1 |
| 无 | ≥0.6 | 调一次摘要器 | 1 |
| 无 | <0.6 | 跳过 | 0 |

运行内预算由 runtime 通过 `onRuntimeContext` 回报（每轮回调一次，run 结束时再测一次），因为 service 层看不到 runtime 的内存数组。**压缩发生在 run 正常收敛之后**，不阻塞用户看到最终答复。

摘要源与 run 内一致：冷区（尾部之前的全部历史）经同一套 `planColdZone` 分流后进入摘要器，分块递进覆盖全部。checkpoint 不总结尾区——那段内容下一次仍会原样发送。

**一处刻意的模式差异**：run 后调 `planColdZone(..., { mode: 'checkpoint' })`。run 内造的是一个**请求**，所以 `keep` / `evidence` 有意义（原文要写回去）；run 后不造请求，只有摘要会落盘，这两个通道没有任何消费者。若沿用请求模式，被判「值得原文保留」的组会既不进摘要也不落盘——checkpoint 的覆盖面会比它声称的窄一截。因此 checkpoint 模式下：分数 ≥ 阈值的组一律进摘要，只有低于阈值的才归档为索引行。

**产物的用途（2026-10 变更）**：checkpoint 不再注入请求，而是作为下一次压缩的起点（`priorCheckpoint`）。因此装配在未超预算时不会因为“有 checkpoint”而多发一段摘要；超预算时压缩器直接带着它继续，只总结新增部分。0.6 软水位的产物实质上是**预计算**。

### 7.1 结构（`context_store.ts:6-18`）

```ts
interface ContextCheckpoint {
  id, conversationId, runId, schemaVersion,
  triggerReason,        // 目前恒为 'soft_watermark_after_task'
  tokenEstimate, watermarkRatio,   // 压缩时刻的预算快照
  pinnedFingerprint,               // 见 §7.3：复用前比对，不匹配即拒绝作为压缩起点
  programState,         // 代码机械提取（确定性）
  modelSummary,         // LLM 生成（结构化 JSON）
  createdAt,
}
```

### 7.2 两部分的分工

**`programState`（`context_manager.ts:455-497`，不交给模型）**：

- `latestUserPrompt` + `recentUserPrompts`（最近 8 条）
- `loadedCapabilitiesRemovedFromContext`：从 run 事件里的 `observation.loadedCapability` 聚合出被移出上下文的 CoreTool / MCP / Skill 名单——这些能力已不在 `tools` 数组里，模型需要知道「我用过但现在看不到了」
- `workspaceMap`：workspace artifacts 前 30 条 + 从 run 事件提取的 `workspace_artifact` 路径

**`modelSummary`（`callSummariser`）**：要求严格 JSON，schema 含 `taskState` / `decisions` / `stableFacts` / `completedActions` / `pendingActions` / `discardedContext` / `continuationPrompt`。提示词要求携带 `previousCheckpoint` 中仍然有效的事实、只删除被新消息取代的部分。输入是冷区各组的**浓缩形态**（工具名、参数、成败、产出文件、证据行），不是工具结果原文——原文在归档里，重发它会让摘要源和它要替代的历史一样大。

**失败语义（2026-10 修正）**：抛错回退为由 `programState` 拼出的最小 JSON，返回体带 `degraded: { reason }`；回复不是合法 JSON 时保留原文但同样标记 `degraded`。checkpoint 仍然落盘（`programState` 是机械提取的，依然正确），但 `compactAfterRun` 把 `degraded` 一并返回，`agent_service` 据此改发 `loop_health{level:'warning', reason:'context_compaction_degraded'}` 而不是 `context_compaction_completed`——否则一个持续失败的摘要器会完全隐形。

### 7.3 复用（不再注入）

`buildManagedHistory` 调 `getLatestContextCheckpoint`（`context_store.ts`，按 `createdAt` 倒序取**第一条**），校验指纹后把它放进 `ManagedHistory.checkpoint`；service 再通过 `AgentChatRequest.priorCheckpoint` 交给运行时。它只在**本 run 需要压缩**时被读取，作为 `previousCheckpoint` 进入摘要提示词，**不进入请求的 messages**。

只有最新一条会被复用，历史 checkpoint 全部忽略——旧信息若未被新 checkpoint 携带即退出上下文（`history_lookup` 已下线，当前不可召回）。

**准入条件（`checkpointMatchesContext`）**：复用前重算 `fingerprintPinnedContext` 并与 checkpoint 里的 `pinnedFingerprint` 比较，不相等就**不传给运行时**，并让 `ManagedHistory.discardedCheckpoint = { id, reason: 'pinned_context_changed' }` 一路透到 `GET /conversations/:id/context-budget` 的响应里。

- 指纹覆盖 `agentId / systemPrompt / coreTools[id,name,description] / mcpServers[id,name,description] / skills[id,name,description,directory]`，即摘要语义所依赖的全部输入；
- 指纹**不含** workspace artifact 列表与当前日期——它们每 run 重建，且已移出 system prompt（§十二），让它们参与指纹会在每次改文件时把摘要打成失效；
- `pinnedFingerprint` 为空的 checkpoint（字段引入前写入、或由其他构建写入）**无法验证**，按失效处理而不是默认信任；
- LLM 切换**不在**指纹内：换模型不改变摘要的语义，只改变生成它的模型。


## 八、观测降级与检索恢复

### 8.1 长结果的四级降级（`observation_manager.ts`）

| 结果长度 | mode | 进入上下文的形态 |
| --- | --- | --- |
| ≤ 6,000 字符（`knowledgebase` ≤30,000） | `inline` | 原文 |
| > 阈值，有 `conversationId` | `file` | JSON 元数据 + 摘要 + **前 6,000 字符**（`history_lookup` 下线后不再附回读指引） |
| > 阈值，无 `conversationId` | `preview` | 同上但无回读指引 |
| （所有 mode） | — | ~~落盘文件另生成 workspace artifact~~（2026-10 起不再注册：`observation.artifact` 全仓无赋值点） |

阈值按工具名解析（`inlineResultBudget(toolName)`，默认 6,000，`knowledgebase` 为 `KNOWLEDGEBASE_INLINE_RESULT_CHARS = 30,000`）；inline 结果的 `eventPreview` 仍截断到 12,000，避免 UI 事件流携带整篇知识正文。

**回读链路（2026-10 起；2026-11-01 起工具下线，链路休眠）**：观测文件落在 `.sessions/<projectKey>/<sessionId>/observations/`，**在项目目录之外**，所以路径不能交给模型——按路径读会撞项目边界、变成一次无法完成读取的审批。因此 `file` 模式的 modelContent **不含 `observationPath`**，也不再指向已下线的 `history_lookup`；全文仍写入 transcript 的内容寻址 blob：`recordToolResult` 写入 `blobs/sha256-<hash>.txt`，投影事件 `tool_call_result` 带回 **blob 引用**（`rawResult`，不是内容），`readToolResultContent` 用 `resolveTranscriptBlobPath` 校验后读回。整条链路不新增存储，也不要求模型读项目外的文件。`observation.id` 是 `sha1(toolName + result)` 前 12 位，**天然幂等**：同一工具同一结果重复出现不会产生新产物。

### 8.2 `history_lookup`（已临时下线；底层 `context_store.ts:71-197` 保留）

以下描述的是**保留待重接**的检索能力：schema、注册与 dispatcher 分支已于 2026-11-01 删除，重接前模型无法调用。按 6 类条目扫描会话消息（`HistoryLookupType`）：

| type | 来源 | 说明 |
| --- | --- | --- |
| `user_prompt` | user 消息 | |
| `assistant_text` | assistant.content | |
| `assistant_tool_call` | run 事件 `tool_call_start` | 含 arguments |
| `tool_result` | run 事件 `tool_call_result` | `includeFullContent` 时按事件的 `rawResult` blob 引用读回原文（`readToolResultContent`）；blob 不可读时回落到事件本身 |
| `system_event` | 7 类 run 事件 | `loop_health` / `workspace_artifact` / `error` 等 |
| `summary_checkpoint` | 会话记录里的 checkpoint | 最近 20 条 |

行为要点：`limit` clamp 到 `[1, 50]`（缺省 10）；排序按 `createdAt` 升序后 `slice(-limit)`（**取最近的 limit 条**）；`includeFullContent` 默认 false，只返回 `previewText(…, 1200)`；未传 `types` 则 6 类全开。工具描述明确写「This tool never searches other conversations.」

## 九、上下文窗口的来源

`resolveContextWindow`（`context_window.ts`）**不支持自动探测**：`contextWindowTokens` 是 `llm.json` 中用户必填项，缺失或非正数直接抛错（`当前 LLM 未设置"最大上下文"`）。`source` 字段恒为 `'configured'`（保留枚举是为了未来扩展）。

选择这一设计的直接后果是**水位正确性依赖用户填对窗口**。当前 `config/llm.json` 中 provider `d1` 配置为 `1,000,000`；配合 §4.3 的 80% 上限，软水位（决定是否写 checkpoint）需约 600k tokens，硬水位（触发运行内压缩）需约 800k；实测 20 个真实会话中**没有任何一个产生 checkpoint**，压缩路径在真实使用中几乎未被走到。

## 十、已知缺口

按影响排序，前两条有实测证据。

> **缺口 1（失效保护未接线）——2026-10 已修，编号保留供对照**：原实现只写不读 `pinnedFingerprint`，配置切换后旧 checkpoint 仍会作为「当前对话摘要」注入。现在 `buildManagedHistory` 在复用前比对指纹（`checkpointMatchesContext`），不匹配则不传给运行时并在 `/context-budget` 响应里带 `discardedCheckpoint`；空指纹按失效处理。实现与边界见 §7.3。残余风险：指纹只能覆盖**进入 system prompt 的内容**——任何影响 prompt 装配的配置（agent、skill/MCP 目录、`main.md`）都会使摘要失效，而不影响 prompt 的配置变化（例如换 LLM）不会，后者是刻意保留的。

> **缺口 2（固定开销无界）**：`formatWorkspacePrompt` 只限制 artifact **条数（20）**，不限制 `artifact.summary` 长度；而 `buildTextObservationSummary` 会把前 12 行原始内容塞进摘要。实测单个会话 9 个 artifact 的 summary 达 **121,339 字符 / 39,406 tokens**，且该块**每请求重建**，会挤占窗口并抬高水位。对照 `observation_manager.ts:6` 对模型可见内容设了 `MODEL_PREVIEW_CHARS = 6000` 的上限，workspace 摘要绕过了同一约束，两处口径不一致。建议：给 summary 设同量级上限，或只注入 `path + type` 而把 summary 留给 `read_file`。

> **缺口 3（小窗口塌缩）——2026-10 已修**：原实现 `min(requested, max(8_000, window × 0.25))` 把 8,000 变成硬下限，`window ≤ 8_000` 时 `contextLimit = max(1, window − 8000) = 1`，ratio 直接 1700%，任何请求都立刻 hardExceeded 并撤 tools；16,000 窗口也有 50% 被预留。现在改为比例式 `min(requested, max(1_024, window × 0.2), window/2)`（`context_manager.ts:451-469`），输入预算恒 ≥ 窗口一半，窗口 ≥40k 时行为与旧实现完全一致。边界由 `test/context_manager.test.ts` 的 1k/4k/8k/16k/32k 用例保护。

> **缺口 4（摘要截断语义）**：`buildTextObservationSummary` 用 `lines.slice(0, 12)`，而 `lines` 由按 `\n` split 后 `trim()` 得到。JSON 单行输出（本项目工具结果的常见形态）会得到**一条极长行**，摘要因此是「前 N 字符处被硬切」的内容，缺少结束语义，也没有总行数之外的结构提示。实测最长 summary 21,454 字符即此形态。这与缺口 2 叠加放大了固定开销。

> **缺口 5（`programState` 回流膨胀）——推测，未实测**：`buildProgramState` 收集的 `workspaceMap`（前 30 条 artifact）与 `buildModelSummary` 会一起进入 checkpoint；而 checkpoint 复活时整个 JSON 又进 system 侧上下文。若 artifact `brief` 字段取自同样的长 summary，则压缩产物本身可能携带与缺口 2 同源的膨胀。建议在验证长会话 checkpoint 实际体积后决定是否需要截断。

> **缺口 6（压缩路径缺少真实覆盖）——2026-10 补齐**：`test/context_manager.test.ts` 覆盖预算估算、输出 cap 与校准倍数；`test/cold_zone.test.ts` 覆盖打包、证据行、保真度、配额、阈值、归档索引与尾段回退；`test/context_cold_zone_compaction.test.ts` 覆盖归档 + 索引上报、全保留时零摘要调用；`test/context_assembly.test.ts` 覆盖「全量发送」与「checkpoint 不进请求」；`test/context_compaction_failure.test.ts` 覆盖成功 / 抛错 / 空文本 / 非 JSON 四条分支与 run 后降级上报。

## 十一、关键常量与代码位置

| 项 | 位置 |
| --- | --- |
| 水位与压缩常量（`SOFT/HARD_WATERMARK`、`MAX_RUNTIME_COMPACTIONS`、`SUMMARY_SOURCE_CHUNK_TOKENS`、`CONTEXT_POLICY`） | `agent/context_manager.ts:10-40` |
| 静态上下文装配（system prompt 五段） | `agent/service/agent_context_resolver.ts:220-260` |
| 每 run 易变块（日期 / 产物列表） | `agent/service/agent_context_resolver.ts:316-335`（`buildPinnedTail`） |
| 易变块注入点 | `agent/agent_runtime.ts:144-152` |
| 受管历史装配（唯一入口） | `agent/context_manager.ts:79-162` |
| 模型转录（append-only，模型可见） | `agent/config/context_message_store.ts` |
| 常驻工具 schema（装配与运行共用） | `agent/resident_tools.ts` |
| 冷区打包 / 证据行 / 保真度 / 配额与阈值 | `agent/context/cold_zone.ts`、`agent/context/cold_zone_pack.ts` |
| 预算估算与分解 | `agent/context_manager.ts:212-277` |
| 输出预留（比例式，§4.3） | `agent/context_manager.ts:451-469` |
| 输出调用上限 | `agent/context_manager.ts:283-294` |
| 运行内压缩（tool 配对不变量 / 失败语义） | `agent/context_manager.ts:296-368`、`:426-459` |
| P90 校准 | `agent/context_manager.ts:484-514` |
| 字符启发式系数 | `agent/context_manager.ts:516-559` |
| `programState` / `modelSummary` 构造 | `agent/context_manager.ts:560-616` / `:617-708` |
| 指纹计算与复活准入 | `agent/context_manager.ts:718-727` / `:710-716` |
| checkpoint 结构与读接口 | `agent/config/context_store.ts:6-71` |
| `history_lookup` 六类扫描 / 全文回读（底层保留，工具已下线） | `agent/config/context_store.ts:73-199` / `:188-211` |
| 观测降级四级 | `agent/observation_manager.ts:5-152` |
| 投影事件带 blob 引用 | `agent/transcript_reader.ts:164-190`、`:274-282` |
| 窗口解析（必填、无探测） | `agent/context_window.ts` |
| 每轮预算 / 软硬水位 / 撤 tools | `agent/agent_runtime.ts:270-340` |
| 运行后压缩触发与降级上报 | `agent/service/agent_service.ts:74-158` |
| 只读预算探针 API | `http/routes/conversations.ts`（`GET /api/conversations/:id/context-budget`；与 `GET /api/conversations/:id/stats` 共享 `resolveManagedContext`） |
| 前端水位与统计 | `web/src/components/chat/ComposerStats.jsx`（上下文三分类环形表）、`web/src/hooks/useConversationStats.js` |
| 会话统计聚合 | `agent/conversation_stats.ts`（transcript 折叠：轮/步/时序/token/缓存） |

## 十二、可缓存前缀与观测（2026-10 新增）

### 12.1 为什么不把日期和产物放进 system prompt

Provider 的前缀缓存**只从第 0 个 token 起匹配**：请求开头只要有任意字节变化，该位置之后的内容全部重新 prefill。对 agent 来说，一个 run 要发几十次请求、每次都重发 system + 全部历史，前缀是否稳定直接决定每轮成本和首 token 延迟。

旧实现把两处易变内容放进了 system prompt：

| 内容 | 变化频率 | 位置 | 后果 |
| --- | --- | --- | --- |
| `Current date:` | 每天 | 第 2 段 | 跨天后 ③④ 段与全部历史失效 |
| 最近 20 条产物及 `summary` | 每次产出文件 | **第 4 段（system 末尾、紧挨历史）** | 产物一变，整段历史失效 |

改法（`agent_context_resolver.ts`）：system prompt 只保留**同会话内恒定**的五段；日期与产物改由 `buildPinnedTail` 生成，`agent_runtime.chat()` 在用户消息前按 user 角色追加。于是一次 run 的首个请求只需为“两个小块 + 本轮输入”付费，其余前缀可复用。

注：`cache_control` 之类的客户端标记只在 Anthropic 类 API 需要；本项目两个 provider（自建 OpenAI 兼容端点、DeepSeek）都走服务端自动前缀缓存。因此本节讨论的是**命中率**，不是“能否开启缓存”。

### 12.2 压缩不得把易变块摘要掉

`pinnedTail` 里的内容（今天的日期、文件在哪）是**精确事实**，不能被 LLM 摘要在语义上改写。但长 run 中这些消息会随历史向后漂移、最终落进 `compactRuntimeMessages` 的冷段。

处理方式：压缩时把带 `<runtime_context_snapshot>` / `<recent_project_artifacts>` 标记的消息从冷段中提出来，重新锚定在 checkpoint 之后（`context_manager.ts:377-400`，`extractPinnedRuntimeBlocks`）。每个标记只保留最后一份，因此反复压缩不会堆积副本。若冷段被提空，则本次压缩直接跳过。

**摘要失败时连缓存都不打断**：失败路径现在不替换任何消息（§六），因此 `messages[1..]` 原地不动、可缓存前缀保持完整——这是把「失败不伪装成功」和「前缀缓存」两件事连起来的意外收益。

### 12.3 观测手段

| 想知道什么 | 看哪里 |
| --- | --- |
| 组装出的前缀是否稳定 | transcript `model_request.prefixHash`，四段各自独立：`tools` / `system` / `head`（前 3 条消息）/ `full`（全部消息），每段 sha256 前 16 位 |
| provider 实际复用了多少 | `loop_health{reason:'token_usage_observed'}.tokenUsage.cachedPromptTokens` |
| 这个数字可不可信 | `GET /api/conversations/:id/stats` 的 `tokenUsage.cacheReportedSteps` / `cacheTotalSteps`（上报覆盖率） |
| 端点不报表时怎么观测 | `activity.prefillMsPerKTok`：首 token 延迟 / 1k prompt token。前缀命中时它塌缩一个数量级（实测冷 ~0.32、热 ~0.02 ms/token） |
| 解析了哪些字段 | `llm_client.ts` 的 `readCachedPromptTokens`：`prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`cache_read_input_tokens` |

为什么 `prefixHash` 要分段：chat template 把 **tools 渲染在 system 之前**，所以 tools 一变，整段 prompt 从第 0 个 token 起就作废；只哈希“前几条消息”永远看不出这件事。四段分别对应四种失效：tools 变了（装配重新声明工具）、system 变了（配置/目录漂移）、head 变了（首部历史被改写）、others 不变而 `full` 变了（更深处被改写，只允许压缩这么做）。

口径的两次修正（2026-11）：

1. **字段缺失的含义由 provider 声明决定，不再一律是“未知”**。`llm.json` 的 provider 增加 `cacheReport`：
   - `none`（默认）：端点不报表，缺失 = **未知**；
   - `hits-only`：端点**只在命中时才发字段**（SGLang 即使加了 `--enable-cache-report` 也如此），缺失 = **未命中**。把它当未知会吞掉所有 miss，把冷启动会话显示成 100%；
   - `full`：端点总是发，包括显式的 0（OpenAI / DeepSeek）。

   不做这个区分的话，「未知」和「命中」在数据上无法区分，只能二选一地系统性高估或低估。

2. **百分比必须带样本量**。旧口径只在 `cacheReportedSteps > 0` 时给百分比，分母只算上报过的请求——于是 64 步里有 3 步报了 0，整个会话就显示「缓存命中 0%」，而其余 61 步其实什么也没说。现在 `cacheHitPercent` 始终与 `cacheReportedSteps/cacheTotalSteps` 一起输出，前端在覆盖率不足时显示 `缓存命中 0%（3/64 步）`，一次都没上报时显示 `缓存未上报`。

诊断口径：

- `prefixHash` 稳定 + `cachedPromptTokens` 高 → 正常命中。
- `prefixHash.tools` 在 run 边界变化 → 工具集不跨 run 稳定，回到 §12.4。
- 四段都稳定 + `cachedPromptTokens: 0` → provider 侧（缓存没铺开、被驱逐，或多副本路由打散）。
- `cacheReportedSteps = 0` → 端点根本不报表：先确认 `cacheReport` 配置，再确认服务端开关（SGLang 需要 `--enable-cache-report`），最后退到 `prefillMsPerKTok`。

### 12.4 尚未处理的部分

- **~~工具集不跨 run 稳定~~（2026-11 已修）**：`addTools` 只在 run 内追加，每个 run 开始时 `tools` 又回到
  resident-only，而 tools 序列化在 messages 之前——于是「缩小 → 再增长」交替发生，**每次变化都让整段消息
  前缀从 token 0 作废**。现在会话级记录已激活的 MCP 工具（`<session>/tool-set.json`，
  `conversation_tool_set_store.ts`），run 开始时按首次激活顺序重新声明，只恢复本 run 仍然发现的工具；
  运行中新装载的工具立即落盘。数组因此单调，代价从 O(runs) 降到 O(activations)——每次新激活仍付一次
  re-prefill，这是无法回避的（改 tools 就会移动所有后续 token）。
  回滚开关：`BIOFLOW_TOOL_SET_STABILITY=off` 同时关闭读取与写入，行为回到「每 run 只有 resident」。
- **~~pinned tail 不落库~~（2026-11 已修）**：`buildPinnedTail` 的块现在先以 user 行写进 transcript
  （`appendPinnedTail`），解析出的 live 数组仍在用户消息前注入同样的字节。于是 run N 发
  `[S, H, P, U]`，run N+1 回放 `[S, H, P, U, A, T, …, P', U']`——分叉点从 `H` 之后推到上一轮的末尾，
  上一轮的工具结果不再是白算的。回归用例：`prefix_stability.test.ts` 的
  “the pinned tail is persisted where it is sent”。
- **run 内压缩仍会打断缓存**：`compactRuntimeMessages` 把 `messages[1..]` 整体重写为一条 checkpoint，之后所有轮次从该位置起需要重新 prefill。这是压缩的固有代价，当前未做“复刻前缀以命中缓存”（DSH 的做法）或预计算。1M 窗口下实际不触发。**node 0 现在有守卫**：压缩候选若改写了 `messages[0]`，splice 会被跳过并发出 `context_compaction_head_rewrite_blocked`。
- **~~跨 run 的历史起点仍会滑动~~（2026-10 已修）**：装配不再裁剪历史，请求前缀随会话追加而稳定。
- **多副本路由**：RadixAttention 的树在进程内，round-robin 会把命中率打到 1/N。当前是单实例，未处理。

### 12.5 服务端开关（自建 SGLang 必读）

`usage.prompt_tokens_details` 默认不返回，即使缓存正在命中。必须在启动参数里加：

```
--enable-cache-report
```

两条实现细节会误导排查：

- 加了之后**只有命中才发字段**，miss 是 `null` 而不是 `{"cached_tokens": 0}`——所以 provider 的 `cacheReport` 必须声明成 `hits-only`，否则 miss 会被记成「未知」。
- 流式请求需要客户端带 `stream_options.include_usage`（本仓库一直带），否则整个 `usage` 都不会出现。

`/metrics` 需要 `--enable-metrics`，且 nginx 默认不转发；`/v1/loads` 无需任何开关，可直接读聚合 `cache_hit_rate`（承 sglang 版本支持）。

### 12.6 显式 breakpoint（只对 Anthropic 类端点）

自动缓存之外还有一类端点**只缓存请求显式标记的块**（Anthropic Messages、DashScope）。这类 provider 在
`llm.json` 里声明 `cacheMode: "explicit"`，客户端 `applyExplicitCacheBreakpoints` 会加三处
`cache_control: {type: "ephemeral"}`：

1. system 消息（必须跨 run 字节稳定）；
2. **最后一个** tool 声明（tools 序列化在所有消息之前，这是唯一能单独缓存工具块的位置）；
3. 最后一条消息的最后一个 content block（会话的增长边缘）。

只有三处而不是四处的上限，留一个余量。文本只被包装不被改写：支持 block 内容的端点照常拿到同样的文字，
不支持的在第一个 HTTP 请求就会明确失败，而不是静默地什么都不缓存。`auto` 端点完全不经过这段代码。
