# Planning 机制

> 基线：`062f4a1`（`docs: document MCP connection, lazy tool loading and credential boundary`）
> 范围：`agent-client/backend/src/agent/core_tools/planning_executor.ts`、`core_tools_runtime.ts` 的 `planning` 注册条目与 function schema、`tool_result_events.ts` 的面板抽取、`service/agent_service.ts` 的 plan 折叠与叙事剥离、`config/workspace_store.ts` 的 `planning/` 目录与 `type=plan` 产物、`web/src/components/chat/PlanningPanel.jsx` + `TodoDock.jsx` + `web/src/domain/trace.js` + `web/src/domain/panels.js`。
> 本文描述**当前实现事实**，用于修改规划行为前的第一事实来源核对；文中标注了已知设计缺口。
> 2026-11-01：待办清单改为三态并接入服务端投影（`GET /:id/panels` + `domain/panels.js`），常驻 dock 不再倒扫事件；见 §四、§五。
> 工具注册表元数据、风险分级与执行入口属于 CoreTool 职责，见 [`core-tools.md`](core-tools.md) §5.6；面板事件如何进上下文与压缩见 [`context-mechanism.md`](context-mechanism.md)；工具批次何时被调用见 [`agent-loop.md`](agent-loop.md)。本文按**协议 → 跨 run 生命周期 → 状态载体 → UI → 提示词注入 → 安全交互**补齐其未展开的部分。

## 一、结论速览

- 本项目**没有独立的 planner agent、没有 plan→execute 状态机、没有 DAG/步骤调度器**。规划的唯一运行时实体是一个 CoreTool：`planning`，四个 action：`clarify` / `publish_plan` / `update_todo` / `complete`（`planning_executor.ts:13-106`）。
- 它是**协议型工具 + UI 面板**：工具几乎无副作用，真正约束模型「停下来等用户」的是返回值里的 `instruction` **自然语言字段**，**运行时不做任何强制**（`planning_executor.ts:28`、`:68`）。
- 规划与执行**分属不同 run**：面板只是把一条事件写进 run 流；用户点「赞同」时前端把一段中文 + `{"type":"planning_plan_approved"}` 作为**普通用户消息**提交，由模型在新 run 里自行解读（`PlanningPanel.jsx:62`）。后端**没有任何**协议解析分支。
- 面板状态**没有独立存储，但有了服务端折（fold）**：`planning_panel` 事件仍混在 run events 里持久化（`agent_service.ts`），`buildMessageParts` 逐条回放成**行内**面板；**常驻待办**改由服务端 `foldConversationPanels` 从 transcript 折出当前列表，经 `GET /api/conversations/:id/panels` 下发（`conversation_panels.ts`、`conversations.ts`）。前端不再倒扫历史事件（旧 `getActiveTodoPanel` 已删除）。
- 计划的**内容权威是一份真实文件**：`<项目目录>/planning/<name>.md`（项目目录 = 该会话绑定的 `projectPath`，经 `resolveToolRoot` 解析，`planning_executor.ts:41-43`），产物 `type=plan`（`:44-57`）。它每请求经 pinned workspace 块重新注入 system prompt（前 20 条 artifact），所以压缩后仍可见（`agent_context_resolver.ts:268-292`）。
- `planning` 的 `risk` 恒为 `project_write`（`core_tools_runtime.ts:414`），且**未声明 `parallelizable`** → 串行执行且**每次调用都走审批矩阵**：`approval` 模式一律弹审批、`auto` 模式交给分类模型。轻量的 `clarify` / `update_todo` 与落盘的 `publish_plan` **共用同一风险等级**。
- 机制里有一条**没有生产者的 legacy 通道**：`plan_update`（`title` + `steps`）在 `types.ts:38`、`agent_service.ts:321-324`、`web/src/domain/trace.js:59` 三处都有完整处理，但**全仓库没有一处 emit 它**；配套的 `planStepIndex`、`AgentRun.plan` 也**恒为 `null` / `{}`**（`agent_runtime.ts:228`、`:417`、`:490`）。
- 模型看到 `planning` 能力**不走延迟加载**：它在 `CORE_TOOL_REGISTRY` 内，Agent 配置 `planning` 后 schema 每轮注入（未配置则不注入也不出现在 system prompt），但其自身 description 第一句写着 "Use this **delayed** tool"（`core_tools_runtime.ts:240`）——描述与实现不符。

## 二、四个 action 的完整契约

注册条目：`id: 'planning'`、`toolNames: ['planning']`、`dispatch: 'core_executor'`、`risk: 'project_write'`（`core_tools_runtime.ts:401-415`）。
function schema 的 `required` **只有 `action`**，其余参数全部可选，因此「缺参数」只能靠执行器返回 `ok:false` 兜住（`core_tools_runtime.ts:305`、`planning_executor.ts:16`、`:36`、`:75`）。

| action | 必填参数 | 副作用 | `uiEvent.panel` / `status` | `instruction` |
| --- | --- | --- | --- | --- |
| `clarify` | `questions` | **无落盘** | `clarify` / `waiting` | 要求停下等用户确认（`:28`） |
| `publish_plan` | `markdown`（+ 可选 `file_name`、`todos`） | 写 `planning/<name>.md`，登记 `type=plan` 产物 | `plan` / `waiting` | 要求停下等用户批准或反馈（`:68`） |
| `update_todo` | `todos` | **无落盘** | `todo` / `active` | **无**（模型可继续执行） |
| `complete` | 无 | **无落盘** | `todo` / `complete`（`todos: []`，投影据此清空） | **无** |

四个分支之外的 `action` 统一返回 `ok:false`（`:106`）。`title` 缺省为 `任务规划`（`:11`）。

### 参数净化（唯一的输入校验层）

- `normalizePlanningQuestions`（`:110-124`）：选项去空值后 **`length !== 3` 即整题丢弃**；`id` 缺省生成 `q{index+1}` 并过滤到 `[a-zA-Z0-9_-]`。全部问题被丢弃时返回 `ok:false`（`:15-17`）。
- `normalizeTodoItems`（`:127-138`）：空 `text` 项丢弃；`done` 用 `Boolean()` 强转；`id` 缺省 `todo{index+1}`。全部为空时 `update_todo` 返回 `ok:false`，而 `complete` **不带 `todos`** 所以不受影响（`:73-75`、`:91-104`）。
- `normalizePlanFileName`（`:141-150`）：剥 `.md` → 非法字符替换为 `-` → 空白转 `-` → 去首尾 `-` → 截断 80 字符 → **强制补 `.md`**；全空时回退 `plan.md`。

### 副作用落点

`publish_plan` 是唯一有副作用的分支（`:32-47`）：先要求 `conversationId`（缺失返回 `ok:false`，`:33`、`:4-6`），再 `writeConversationWorkspaceFile(conversationId, 'planning/<fileName>', markdown, { title, type: 'plan', tags: ['planning','plan-md'], metadata: { source: 'planning-core-tool' } })`。返回值同时带 `file`（→ `workspace_artifact` 事件）与 `uiEvent`（→ `planning_panel` 事件）。

## 三、跨 run 的规划生命周期

规划**不是一个 run 内的循环**，而是「run 停下来 → 用户消息 → 新 run」的四段式。事件流里看不到任何调度器，全部靠会话历史 + pinned workspace 传导：

```text
run A  ── planning(action=clarify) ──► planning_panel(clarify/waiting) ──► 模型按 instruction 停 ──► run A completed
   │
   ├─ 用户在面板选答案 → PlanningPanel 拼 "规划询问面板已确认：\n{planning_clarification_response}" → 普通用户消息
   ▼
run B  ── planning(action=publish_plan) ──► 写 planning/<name>.md + workspace_artifact + planning_panel(plan/waiting) ──► run B completed
   │
   ├─ 用户点「赞同」→ "我赞同这个 plan.md…\n{planning_plan_approved, filePath}" → 普通用户消息
   │  用户点「否认」+ 意见 → "我否认这个 plan.md…\n{planning_plan_rejected, feedback}" → 普通用户消息
   ▼
run C  ── planning(action=update_todo) ──► planning_panel(todo/active) ──► 继续执行工具 …
   │
   └─ planning(action=complete) ──► planning_panel(todo/complete) ──► 前端待办 dock 消失
```

四条事实值得单独记下：

1. **「批准」不改变任何后端状态。** `planning_plan_approved` 只出现在用户消息文本里（`PlanningPanel.jsx:62`），后端全仓库无解析分支。模型若不理会这条 JSON，流程照样继续——约束力等于提示词。
2. **`filePath` 只用于回显。** 批准消息里带的 `filePath` 无人校验；模型要真正读计划，得自己调 `read_file`（`agent_context_resolver.ts:258-261` 的提示词要求它「按 plan.md 执行」）。
3. **面板的 `waiting` 与 run 终态无关。** `planning_panel` 不会触发 `waiting_user_input`（该状态只由 `security_approval_request` 设置，`agent_service.ts:478-480`）；run 正常 `completed` / `final_answer`，面板仍在 UI 里显示「等待确认」。
4. **每个 `planning` 调用在 run 流里产生两条事件**：`tool_call_result`（模型合同）+ `planning_panel`（UI 副作用），由 `extractToolResultEvents` 在 `finalizeToolResult` 之后逐个 yield（`agent_runtime.ts:203`、`:430-431`、`tool_result_events.ts:13-23`）。

## 四、状态载体：plan 存在于哪里

| 载体 | 内容 | 生命周期 | 读方 |
| --- | --- | --- | --- |
| `<项目目录>/planning/<name>.md` | Markdown 全文（**内容权威**） | 落盘，永久 | 模型（`read_file`）；UI（产物侧栏 / 预览） |
| `planning_panel` 事件 | panel / status / title / questions / markdown / todos / note | run events → 消息 `toolCalls.run.events` → runs 索引 → **transcript `engine_event`** | Web `buildMessageParts`（行内面板）；服务端 `foldConversationPanels`（常驻待办） |
| Run step `kind='planning_panel'` | 同一事件的快照 + `status: waiting/complete` | run steps | trace 面板（`agent_service.ts:473-475`） |
| 用户消息文本 | `planning_plan_approved` / `planning_plan_rejected` / `planning_clarification_response` | 会话历史 | **只有模型**（无后端解析） |
| pinned workspace 块 | artifact 列表前 20 条（含 `plan.md` 的 title/path/summary） | **每请求重建** | 模型 |
| checkpoint `programState` | `workspaceMap` = 前 30 条 artifact + run 内 file hints；`recentUserPrompts` = 最近 8 条用户输入 | 软水位触发后持久 | 压缩后的模型（`context_manager.ts:455-497`） |

**不存在**的载体：`AgentRun.plan`（`run_store.ts:11` 恒 `{}`）、`AgentRunStep.planStepIndex`（恒 `null`）、任何独立的 plan 表 / plan API。

一个直接后果：计划正文**同时存在于三处**——落盘文件、`planning_panel.markdown` 事件、以及工具结果的 `result`（模型侧）。`update_todo` 的每个 todo 也重复出现在事件与工具结果里。

## 五、UI 机制

### 5.1 渲染路径

```text
message.toolCalls.run.events
  └─ buildMessageParts(events, plan, namespace)        web/src/domain/trace.js:39
       ├─ event.type === 'planning_panel' → parts.push({ type: 'planning', panel: event })   :65-68
       └─ event.type === 'plan_update'    → plan trace item（死路径，见缺口 3）              :59-63
  └─ FlowMessage 逐个 part → <PlanningPanel panel onRespond />                FlowMessage.jsx:68-69
```

面板自身无状态存储：`PlanningPanel` 内只有 `useState` 的本地输入，**刷新页面后面板状态完全由事件流回放**（`PlanningPanel.jsx:4-5`）。

### 5.2 三种面板行为

- `panel === 'clarify'`：每题的三个选项渲染为**可单击 chip**，「其他」才展开自定义输入；全部答完前「确认并继续」禁用，提交后按钮转为「已提交」并把逐题答案拼成 `planning_clarification_response`（`PlanningPanel.jsx`）。
- `panel === 'plan'`：只读展示 `markdown`；「赞同」直接提交批准消息；「否认」展开 textarea，**按 Enter 提交**（`isComposing` 已排除中文输入法回车），提交后清空意见（`PlanningPanel.jsx:60-96`）。
- `panel === 'todo'`：**不在消息流里渲染**——`buildMessageParts` 会把 `todo` panel 也 push 成 `planning` part，但 `PlanningPanel` 对非 `clarify`/`plan` 返回 `null`；待办由 composer 上方的 `TodoDock` 渲染**服务端下发的当前值**（`TodoDock.jsx`、`ChatView.jsx`、`domain/panels.js`）。

### 5.3 待办的「当前态」由服务端 fold 决定

`foldConversationPanels(records)` 顺序扫 transcript 的 `engine_event`：`planning_panel`（`panel === 'todo'`）整表替换，`status === 'complete'` 置 `null`；`event.todos` 支持三态 `status` 与 legacy `done`。结果经 `GET /:id/panels` 下发，前端 `TodoDock` 只渲染该值，live 运行期间用同样的整值事件叠加（`domain/panels.js` 的 `applyPanelEvents`）。

**这条修改修掉的正是旧实现的根因**：旧 `getActiveTodoPanel` 必须在「live 事件」与「重建的历史事件」之间二选一，刷新后 live 为空就只能读最新一条 assistant run，模型不调 `complete` 列表就永久驻留、且与日志可能不一致。现在刷新、重连、切回会话读的都是同一个 fold。

三态语义：`pending` / `in_progress` / `completed`；`update_todo` 强制**至多一个** `in_progress`，重复文本与空文本直接拒绝（`planning_executor.ts` 的 `readTodoList`）。

### 5.4 与安全审批面板共用样式

`SecurityApprovalPanel` 复用 `planning-panel` / `planning-markdown` / `planning-actions` 类名（`SecurityApprovalPanel.jsx:18-28`），两者在视觉上是同一族组件。

### 5.5 事件契约校验（静默丢弃）

`parsePlanningPanelEvent` 要求 `ok === true`、`event.type === 'planning_panel'`、`panel ∈ {clarify, plan, todo}`、`status ∈ {waiting, active, complete}`，否则返回 `null`；`questions` / `todos` 仅做 `Array.isArray` 检查，**元素结构不校验**（`tool_result_events.ts:25-33`、`:46-63`）。字段名写错 = 面板静默消失。

## 六、模型侧的提示词注入（三层重复）

| 层 | 位置 | 是否可配置 |
| --- | --- | --- |
| Agent system prompt 尾部 4 条硬规则 | `agent_context_resolver.ts:257-262`（`buildAgentSystemPrompt`） | **否**，硬编码；`agents.json` 里没有任何 planning 字段 |
| CoreTool catalog 片段 | `core_tools_runtime.ts:407-412` 的 `prompt` 字段，经 `buildCoreToolsPrompt` 注入（`agent_context_resolver.ts:214-217`、`core_tools_runtime.ts:519-524`） | 否（CoreTool 按 `agents.json` 的 `coreToolIds` 配置，见 `core-tools.md` §三「Agent 配置契约」） |
| function schema description + 参数说明 | `core_tools_runtime.ts:235-309` | 否 |
| workspace 目录约定 | `backend/config/prompts/pi.md`（`planning` 存放详尽计划 md） | **是**（用户可在设置里改 `pi` prompt） |

前两层是同一套规则的两种措辞（都是「复杂任务才用 / 先 clarify / 再 publish_plan / 批准后 update_todo→complete」），第三层补充了「每题必须恰好 3 个选项、UI 会加自定义输入框」这类 UI 细节。

## 七、与安全、失败熔断、循环的交互

- **审批**：`risk: 'project_write'` 经 `classifyToolRisk` 原样透传，于是 `approval` 模式一律 `ask`、`auto` 模式一律 `classify`（交独立模型复审）、`unrestricted` 放行（`security_policy.ts:20-57`）。`clarify` 这种纯读取也要走同一审批，是粒度问题（缺口 4）。
- **批次**：未声明 `parallelizable` → `isParallelizableCoreTool` 为假 → 与任何其他工具混批时整批走**串行**分支，因此不会遇到 `agent-loop.md` 缺口 1 的「并行绕审」。
- **失败熔断**：`planning` 的 `ok:false` 形态（参数缺失、选项数不对、action 非法）会被 `isFailedToolResult` 判为失败并累计到 `ToolFailureTracker`；连续 10 次仍会终止 run（`tool_failure_guard.ts:35-46`）。
- **无强制停留**：`instruction` 不被运行时消费；模型完全可以「展示面板后继续调工具」，或者在 `clarify` 未获答复时自问自答。
- **上下文压力下规划失效**：硬水位（ratio ≥ 0.8）会移除整个 `tools` 字段，此时模型既不能 `publish_plan` 也不能 `update_todo`（`agent-loop.md` §三）。
- **历史召回**：`planning_panel` 被登记为「系统事件」类，可被 `history_lookup` 按关键词召回（`context_store.ts:160-172`）；该工具已于 2026-11-01 临时下线，重接前不可用。

## 八、已知缺口

| # | 类型 | 描述 | 位置 |
| --- | --- | --- | --- |
| 1 | 契约 | **「停下等用户」只有提示词，没有运行时门禁**：`instruction` 是普通字符串，run 不进入 `waiting_user_input`，也没有「clarify 未回答前禁止继续」的判定。模型不遵守时无任何反馈信号 | `planning_executor.ts:28`、`:68`；`agent_service.ts:478-480` |
| 2 | 契约 | **批准/否认/澄清答复无后端协议**：`planning_plan_approved` 等只是用户消息文本，`filePath` 无人校验，且模型并不知道该 filePath 是否与真实产物一致；与 `security_approval_*` 走独立 API 的成熟做法形成对照 | `PlanningPanel.jsx:16`、`:62`、`:67` |
| 3 | 死代码 | `plan_update` 事件链路完整但**无生产者**；`AgentRun.plan`、`AgentRunStep.planStepIndex` 恒空；`web/src/domain/trace.js` 为它们维护了两套渲染分支（`buildMessageParts` 与 `buildTraceItems` 各一份 `planTraceItem`） | `types.ts:38`、`agent_service.ts:321-324`、`run_store.ts:7`、`agent_runtime.ts:228`/`:417`/`:490`、`trace.js:140-155`、`:201-216` |
| 4 | 安全 | **风险粒度过粗**：`clarify` / `update_todo` / `complete` 是零副作用操作，却与 `publish_plan` 共享 `project_write`，在 `approval` 模式下每次更新待办都要用户点一次审批 | `core_tools_runtime.ts:414`、`security_policy.ts:49-57` |
| 5 | 上下文 | **计划正文三份重复**（文件 + panel 事件 + 工具结果），`publish_plan` 的长计划会同时吃掉事件存储与上下文预算；`normalizePlanFileName` 只截断文件名、**不限制 `markdown` 体积** | `planning_executor.ts:38-47`、`prompt` 无长度上限 |
| 6 | 语义 | 面板 `status: 'waiting'` 与 run 终态不一致（run 已 `completed`，面板仍 `waiting`）；用户长时间不响应也不会超时或回收 | `agent_service.ts:473-475` |
| 7 | 健全性 | 待办仍是**模型自报的字符串列表**，状态无执行证据校验；不调 `complete` 则 dock 永久驻留（投影只在 `complete` 时清空，没有 turn 边界清空规则） | `conversation_panels.ts`、`planning_executor.ts` |
| 8 | 文档 | 工具 description 自称 "delayed tool"，但 CoreTool schema 在 Agent 配置后**每轮注入**（未配置则不加载），延迟加载只存在于 MCP / Skill 体系 | `core_tools_runtime.ts:240`；`core-tools.md` §1 |
| 9 | 测试 | `clarify` / `publish_plan` / 文件名净化仍无测试；**待办与目标面板已有回归**：`backend/test/conversation_panels.test.ts`（三态归一、legacy `done`、fold、清空、目标状态机）与 `web/test/panels.test.mjs` | `backend/test/`、`web/test/panels.test.mjs` |

## 九、测试覆盖

| 测试 | 覆盖内容 |
| --- | --- |
| `test/tool_result_events.test.ts` | 一条成功结果同时派生出 `workspace_artifact` 与 `planning_panel` 两个事件；`ok:false` 与坏 JSON 不派生事件 |
| `test/persisted_narration.test.ts` | 「形似计划」的叙事（`Plan: first create a table…`）必须被保留——与 `stripLeadingPlanNarration` 的启发式相关 |
| `test/workspace_prompt_contract.test.ts` | 断言 `config/prompts/pi.md` 与 `ensureConversationWorkspace` 创建的目录一致；当前只校验 `runs/{Data,Analysis,Result}`，**尚未覆盖 `planning/`** |
| `test/core_tools_runtime.test.ts` | 断言注册表元数据（`toollibrary`、`knowledgebase` 等），`planning` 条目仍无同类断言 |

叙事剥离的启发式值得单独注意：`stripLeadingPlanNarration`（`agent_service.ts:593-605`）用「小写化首段是否同时含 plan/todo/steps/计划 与 create/show/execute/先/创建…」且首段**不以 `#` 或 `**` 开头**来判断，命中就把它从 run summary 里删掉。它是纯文本启发式，**不区分这段文字是否真由 `planning` 工具产出**——模型用 `#` 开头写计划纲要就会被保留（这正是 `persisted_narration.test.ts` 锁定的行为）。

## 十、一手来源索引

| 主题 | 位置 |
| --- | --- |
| 四个 action 的实现与净化规则 | `agent-client/backend/src/agent/core_tools/planning_executor.ts:9-155` |
| `planning` 注册条目 | `agent-client/backend/src/agent/core_tools_runtime.ts:401-415` |
| function schema（含 `required: ['action']`） | `agent-client/backend/src/agent/core_tools_runtime.ts:235-309` |
| 工具名常量 | `agent-client/backend/src/agent/core_tools/ids.ts:13` |
| 面板事件类型 | `agent-client/backend/src/agent/types.ts:38-49` |
| 面板事件抽取与校验 | `agent-client/backend/src/agent/tool_result_events.ts:13-63` |
| 事件 yield 位置（串行 / 并行） | `agent-client/backend/src/agent/agent_runtime.ts:203`、`:430-431`、`:490` |
| 事件持久化白名单与 run step 折叠 | `agent-client/backend/src/agent/service/agent_service.ts:473-475`、`:557-568` |
| run summary 叙事剥离 | `agent-client/backend/src/agent/service/agent_service.ts:369-384`、`:593-605` |
| run 级 plan 字段 / `planStepIndex` | `agent-client/backend/src/agent/config/run_store.ts:6-7`、`:11` |
| `planning/` 目录与 `type=plan` 产物 | `agent-client/backend/src/agent/config/workspace_store.ts:13`、`:93-105` |
| checkpoint 里的 plan 痕迹（workspaceMap / recentUserPrompts） | `agent-client/backend/src/agent/context_manager.ts:455-497` |
| `history_lookup` 的系统事件分类（工具已临时下线） | `agent-client/backend/src/agent/config/context_store.ts:160-172` |
| 规划提示词注入（两层） | `agent-client/backend/src/agent/service/agent_context_resolver.ts:214-217`、`:250-266` |
| catalog prompt 装配 | `agent-client/backend/src/agent/core_tools_runtime.ts:515-524` |
| workspace / planning 目录用户级约定 | `agent-client/backend/config/prompts/pi.md` |
| 风险映射与审批矩阵 | `agent-client/backend/src/agent/security_policy.ts:20-57` |
| 失败判定 | `agent-client/backend/src/agent/tool_failure_guard.ts:35-46` |
| Web 面板组件 | `agent-client/web/src/components/chat/PlanningPanel.jsx`、`TodoDock.jsx`、`GoalDock.jsx`、`SecurityApprovalPanel.jsx` |
| Web 事件回放 | `agent-client/web/src/domain/trace.js:39-70`、`:130-155` |
| 服务端面板 fold | `agent-client/backend/src/agent/conversation_panels.ts`（`foldConversationPanels`、`normalizeTodoItems`） |
| 面板读取端点 | `agent-client/backend/src/http/routes/conversations.ts`（`GET /:id/panels`） |
| 面板客户端模型 | `agent-client/web/src/domain/panels.js`、`web/src/hooks/useConversationPanels.js` |
| Web 装配点 | `agent-client/web/src/components/chat/ChatView.jsx:90-140`、`FlowMessage.jsx:7`、`:60-90` |
| 设置页工具目录 | `agent-client/backend/src/http/routes/settings.ts:30`、`:38-60` |
| 测试 | `agent-client/backend/test/tool_result_events.test.ts`、`persisted_narration.test.ts` |
| 既有文档 | `docs/core-tools.md` §5.6、`docs/agent-loop.md` §四/§六、`docs/context-mechanism.md` §3.3 |
