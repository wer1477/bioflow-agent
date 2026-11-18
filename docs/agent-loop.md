# Agent Loop 机制

> 基线：`0b50110`（`chore: stop tracking workspace conversation history`）
> 范围：`agent-client/backend/src/agent/agent_runtime.ts` 的主循环，及其上下文、工具、观测、审计四类支撑模块。
> 本文描述**当前实现事实**，用于修改运行时行为前的第一事实来源核对；文中标注了已知设计缺口。

## 一、结论速览

- 主循环是**没有硬性轮次上限**的 `while (true)` 异步生成器（`agent_runtime.ts:264`）；每轮 yield 事件即流式输出。
- 收敛不靠轮次计数，而靠**上下文压力**：软水位（≥60%）只把 run 标记为「结束后写 checkpoint」，硬水位（≥80%）先就地压缩一次（每 run 最多 3 次），压不下去才**移除整个 `tools` 字段**迫使模型输出文本，进而走正常出口。
- 硬兜底只有两条：同一工具**连续失败 10 次**、以及取消信号（用户取消 / HTTP 断连）。
- 模型输出被 `length` 截断时**不终止**循环，而是**丢弃整批 tool_calls** 后继续。
- 工具能力**延迟加载**：MCP 工具 schema 与 skill 正文都不预注入；tool library 的 L1 领域索引常驻 system prompt，模型选域后用 `toollibrary(domain)` 浏览 L2、再 `toolload({id})` 装载，MCP schema 下一轮才可见。知识库正文同理：`knowledgebase` 的 `index` / `catalog` / `read` 是只读查询，不装载 schema。
- 全程写入 `<WORKSPACE_ROOT>/.sessions/<projectKey>/<sessionId>/transcript/events.jsonl` 审计流水（append-only，每条 `fsync`；读回方式见 §九）。

## 二、分层与数据流

| 层 | 位置 | 职责 |
| --- | --- | --- |
| HTTP / NDJSON | `http/routes/conversations.ts:304-375` | 流式响应、会话级互斥、断连即取消、run 取消端点 |
| 服务编排 | `agent/service/agent_service.ts:43-163` | 会话历史装配、`ContextCheckpoint` 运行后压缩、run 状态持久化 |
| **主循环** | `agent/agent_runtime.ts:129-546` | 上下文预算、模型调用、工具批次分岔、终止判定 |
| 工具分发 | `agent/runtime_tool_dispatcher.ts:33-39` | 五族工具路由 |
| 支撑模块 | `context_manager` / `observation_manager` / `tool_failure_guard` / `transcript_store` / `security_*` | 预算、观测降级、失败熔断、审计、审批 |

```text
POST /api/conversations/:id/runs
  └─ AgentService.runCompletion              agent_service.ts:43
       ├─ buildManagedHistory()              全量历史 + 预算（不裁剪、不注入）
       └─ AgentRuntime.chat()  ← 主循环      agent_runtime.ts:129
            ├─ 每轮：预算 → 压缩/熔断 → 模型流 → 工具批次 → 终止判定
            └─ RuntimeToolDispatcher.execute() 单次工具调用
```

进入循环前，`messages` 数组**每 run 重建**：`system prompt` + **全部历史** + 当前用户消息（`agent_runtime.ts:136-147`）。装配不再裁剪历史：水位线以下一条不丢，丢弃只作为压缩动作在水位线之上发生。循环内不复用上一 run 的消息数组。

## 三、单轮时序

`while (true)` 每次迭代（`agent_runtime.ts:264-536`）依次执行：

**1. 取消检查** — `throwIfAborted`；最外层 `catch` 将其归类为 `cancelled`（`:537-545`）。

**2. 上下文预算** — 每轮重算，而非一次算定（`:255-266`）。`estimateContextBudget` 用字符启发式估算（CJK ×1.15，拉丁/数字 ÷3.8，空白 ÷8，其他 ÷2.2），再乘校准系数。

**3. 软水位标记** — ratio ≥ 0.6 时只发 `context_watermark_exceeded`，把本次 run 标记为「结束后写 checkpoint」；**不改写 messages**（`:310-318`），因此不打断前缀缓存。

**4. 硬水位续命** — ratio ≥ 0.8 时先调 `compactRuntimeMessages`（`context_manager.ts:349`，经 `shouldCompactInRun` 限制为每 run 最多 3 次尝试）；压缩后仍 ≥0.8、压缩失败或次数用尽，才注入收尾提示并执行：

```ts
const toolsForTurn = runtimeBudget.hardExceeded ? undefined : tools.length ? tools : undefined;
```

`undefined` 意味着请求体中**不存在 `tools` 字段**，模型无法再产生 tool_call。这是循环唯一可靠的自动收敛机制。

**5. 模型流式请求** — `llm_client.ts:35-80`。`tool_calls` 增量按 `index` 累加拼装，支持同轮多个并行调用；`finish_reason === 'length'` 时**只 yield `truncated`，不 yield `tool_calls`**。

**6. 工具批次处理** — 见第四节。

**7. 终止判定** — `responseTruncated` 优先；否则 `!sawToolCalls` 即 `completed`（`:518-529`）。

### 输出上限的动态钳制

`resolveMaxOutputTokens`（`context_manager.ts:240-251`）不只是回传配置值：

```ts
const remaining = status.contextWindowTokens - status.tokenEstimate - safetyMargin;
return Math.max(1, Math.min(requested, remaining));
```

因为 provider 对**输入 + 输出**共用同一窗口，仅在本地比值里预留输出是不够的。

### 校准系数的自学习

provider 返回的 `usage.prompt_tokens` 经 `recordObservedPromptTokens` 记录，取 **P90 的 observed/heuristic 比值**作为后续倍数，并用 `Math.max(1, p90)` 保证**只保守不放宽**（`context_manager.ts:379-399`）。保留最近 24 次观测，按 endpoint + model 分桶。

## 四、工具批次分岔

模型给出 tool_calls 后按条件分三路（`agent_runtime.ts:383-496`）：

```text
tool_calls.length > 1 && 全部 isParallelizableCoreTool
  ├─ 是 → Promise.all 并行执行，不经过安全审批
  └─ 否 → 串行 for
           ├─ assessRuntimeToolSecurity 返回 'ask' → 挂起等待审批
           └─ RuntimeToolDispatcher.execute
```

### 并行分支

判定依赖注册表声明。`isParallelizableCoreTool` 为真的工具包括：

| 工具 | 风险标记 | 可并行 |
| --- | --- | --- |
| `read_file` | `read_only` | 是 |
| `glob`、`grep` | `read_only` | 是 |
| `web_fetch` | `network_or_external` | **是** |
| `write_file`、`edit_file`、`apply_patch` | `project_write` | 否 |
| `exec_command` | `shell`（按命令内容细分） | 否 |
| `execute_python` | `code_execution` | 否 |
| `knowledgebase` | `read_only` | 是 |
| `planning`、`toollibrary` / `toolload` | `read_only` | 否（`toolload` 会改下一轮 tools） |

并行分支在同一 `Promise.all` 中完成全部调用，随后逐个 `finalizeToolResult`。

> **已知缺口 1（安全）**：并行分支**完全跳过 `assessRuntimeToolSecurity`**（`:396-434`）。而 `web_fetch` 同时标记为 `parallelizable: true` 与 `risk: 'network_or_external'`，因此在 `approval` 模式下，`[read_file, web_fetch]` 这种批次里的 `web_fetch` 会**绕过审批**，而单独调用时同样的 `web_fetch` 会被要求确认。这是策略不一致，不是有意的白名单：`parallelizable` 与 `risk` 由同一份 `CoreToolDefinition` 声明，但两者之间**没有任何运行时一致性断言**。建议在注册表构建处或 dispatcher 入口加断言：`parallelizable === true` 的工具其风险必须为 `read_only`，否则抛错。

### 串行分支与审批挂起

审批是**阻塞式**的：`securityApprovalStore.create` 返回的 `wait` 被 `await`（`:473`），循环在此停住，前端据 `security_approval_request` 渲染弹窗，用户 POST `/api/conversations/:id/runs/:runId/security-approvals/:approvalId` 唤醒。三个要点：

1. 超时 10 分钟（`security_approval_store.ts:24`）或 abort 会 reject，被捕获后按 **`deny`** 处理（`:474-487`）。
2. `deny` 时**仍写入一条 tool result 回喂给模型**，让它知晓被拒并换策略，而不是直接失败。
3. 审批条目按 `(conversationId, runId, approvalId)` 三元组校验归属（`security_approval_store.ts:50-57`）。

**委派子 Agent 例外**：当 `AgentChatRequest.approvalPolicy === 'never'`（`subagent` 创建的子 run）时，`ask` 判定**不创建审批条目、不阻塞**，直接以 `{ ok: false, error: { code: 'approval_unavailable' } }` 回喂模型并继续。子会话没有审批 UI，若沿用阻塞审批只会空转到 10 分钟超时。

### 安全决策链

`assessToolSecurity`（`security_policy.ts:20-43`）先做确定性判定，再按模式分派：

| 模式 | `read_only` | 非 `read_only` | `destructive` |
| --- | --- | --- | --- |
| `unrestricted` | allow | allow | allow |
| `auto` | allow | **classify**（交给独立模型复审） | ask |
| `approval` | allow | ask | ask |

`classify` 由 `runtime_security_gate.ts` 转交 `classifyAutoToolCall`，用另一个模型判断。MCP 工具因缺少风险元数据，一律按 `unknown` 处理（`security_policy.ts:54-56`）。

## 五、上下文管理：两层压缩 + 冷区分流

```text
run 内   ratio ≥ 0.8 → 冷区流水线（保留 / 证据 / 归档 / 摘要）→ 继续跑，最多 3 次
run 后   ratio ≥ 0.6（未被 run 内覆盖时）→ 写 ContextCheckpoint，作为下次压缩的起点
装配     < 0.8 → 全量历史原样发送；≥ 0.8 → 首轮顶部自然触发上面的 run 内压缩
```

### 5.1 run 内压缩（`compactRuntimeMessages`）

1. **固定 system 前缀**永不压缩；
2. 从尾部倒着保留到 `min(40k, 0.25W, max(3%W, 20k))`，遇到 `tool` 消息继续回退到调用方；
3. 冷区按四通道分流：`keep` 整组原文 / `evidence` 只留路径命令错误串 / `index` 归档并留一行索引 / `summarise` 交摘要器；
4. 摘要分块递进，覆盖整段冷区；抛错、空文本、非 JSON 都算失败，此时**不替换任何消息**（`compacted: false` + `degraded.reason`），发 `context_compaction_failed`，run 继续、硬水位守卫仍在；
5. 写回顺序：`[摘要] + 保留组（按时间序） + pinned 块 + 尾区`。

配额与阈值集中在 `CONTEXT_POLICY`（`context_manager.ts`），逐条见 `context-mechanism.md` §6.2。

### 5.2 run 后 checkpoint

`planRunEndCompaction` 按「run 内是否已有摘要」与「结束时是否 ≥0.6」决定复用或重新摘要。产物**不注入请求**，而是通过 `AgentChatRequest.priorCheckpoint` 交给运行时，在下次压缩时作为 `previousCheckpoint` 复用。

`fingerprintPinnedContext` 对 agent / systemPrompt / 工具 / MCP / skill 配置算 sha1；`buildManagedHistory` 在复用前用 `checkpointMatchesContext` 比对，不匹配即**不传给运行时**并把 `discardedCheckpoint` 透给 `/context-budget`。

### 5.3 冷区分流与按需召回

装配不再裁剪历史，因此不再需要「older history available」这类提示。离开上下文的内容只有一条路径流出：压缩时的 `index` 通道——它被归档到 transcript blob，并在摘要的 `Archived` 段留一行指针。`history_lookup` 曾是精确回读通道（2026-11-01 起临时下线，重接前不可用）；查询按空格分词后要求每个词都命中，而不是整串字面匹配。

## 六、工具结果处理流水线

所有结果统一经过 `finalizeToolResult`（`agent_runtime.ts` 的循环内实现），串行与并行两条路径共用：

**1. Observation 三级降级**（`observation_manager.ts`）：

| 结果长度 | 模式 | 模型看到的内容 |
| --- | --- | --- |
| ≤ 6000 字符（`knowledgebase` ≤30000） | `inline` | 原文 |
| > 阈值，无会话 | `preview` | 摘要 + 前 6000 字符 |
| > 阈值，有会话 | `file` | 引用 JSON + 摘要 + 前 6000 字符，**全文落盘**至会话目录 `observations/<tool>_<obsId>.txt`；**不给模型路径**；`history_lookup` 下线后模型只能看到这段预览 |

模型拿到的是**截断预览而不是路径**：观测文件在 `.sessions/<projectKey>/<sessionId>/`，位于项目目录之外，按路径读会撞项目边界、变成一次无法完成的审批。`history_lookup` 下线期间，精确值只能靠工作区文件或重跑工具获得。

工具结果（模型可见形态）与 assistant 的 `tool_calls` 同时写入 append-only 的 `contextMessages`（`agent/config/context_message_store.ts`），下一次 run 按 `seq` 重放；`messages` 只保留 UI 聊天记录。

**2. 失败熔断**（`tool_failure_guard.ts`）：按工具名计数，**成功即清零**。第 3 次失败注入"换策略"系统提示与 `loop_health` 警告；第 10 次抛 `RepeatedToolFailureError`，**直接终止 run**，停止原因为 `tool_error`。

**3. Transcript 审计**（`transcript_store.ts`）：`run_start` / `model_request`（含完整 messages 与 tools）/ `model_chunk`（原始 provider chunk）/ `model_response` / `tool_call` / `tool_result` / `run_end` 全量追加；大 payload 单独按 sha256 存 blob。这是复现循环行为的唯一可靠依据。

**4. 能力归集**：只有 `toolload` 会返回 `loadedCapability`（`skill` → `loadedSkills`；`mcp_tool` / `mcp_resource` → `loadedTools`），资源列表不上报。

**5. 图片与多模态**：工具结果 JSON 里的 `images`/`image` 先由 `core_tools/image_payload.ts` 抽离并从文本中删除；文本照常走 Observation 降级，图片则作为 `{type:'image_url'}` content part 拼进 **tool message**（`buildToolMessageContent`）。图片 base64 不进入 observation、transcript 的 `rawResult`、`tool_call_result` 事件或失败计数文本；模型不支持图片时 `llm_client.ts` 会禁用该客户端的图片并重试一次（`sanitizeMessagesForTextOnly`）。

## 七、能力延迟加载

起初只注册两类工具（`agent_runtime.ts` 装配段）：**Agent 已配置的 CoreTools**（`coreToolIds`，可含 `toollibrary` / `toolload`）+ `history_lookup`；后者已于 2026-11-01 临时下线。

MCP 工具**不预加载 schema**，MCP 工具以 name/description 形式列在 `agent-client/toollibrary/<领域>/index.md` 里；L1 领域索引常驻 system prompt，模型选域后按需 `toollibrary(domain)` 浏览 L2。模型调用 `toolload({id})` 后，`RuntimeToolDispatcher.executeToolLibrary` 把真实 schema 通过 `addTools` 追加进 `tools` 数组，**下一轮**才可见。skill 同理返回 `SKILL.md` 全文与资源；MCP 资源走 `toolload` 的 `resource` / `server` 分支。

收益是每轮请求的 `tools` token 显著下降；副产物是"本 run 加载过什么"成为可持久化、可展示的事实。

## 八、终止条件全集

代码中**不存在硬性轮次上限**。`toolUseTurns % 10` 只是插入一遍自我复盘提示（`LOOP_HEALTH_CHECK_TOOL_TURNS = 10`，`:530-535`），**不中断循环**。

| 条件 | 位置 | 终态 / stopReason |
| --- | --- | --- |
| 模型不再发 tool_call | `:518` | `completed` / `final_answer`（正常出口） |
| abort 信号（用户取消 / HTTP 断连） | `:265`、`:358`、`:537` | `cancelled` / `cancelled` |
| 同一工具连续失败 10 次 | `:192` | `failed` / `tool_error` |
| 硬水位撤掉 tools 字段 | `:339` | 迫使模型走第 1 行 |
| LLM 请求异常（SDK 重试 2 次后） | 外层 catch | `failed` / `connection_error` |
| 模型输出被 length 截断 | `:499-517` | **不终止**，丢弃整批 tool_calls 后 continue |

第 6 条单独说明：截断时用 `discardedContentChars` 把已流给前端的文本从持久化状态中回退（`agent_service.ts:313-319`），且**绝不把带残缺参数的 tool_calls 写入 messages**——`llm_client.ts:72-75` 的注释明确"截断的 tool call 只是前缀，绝不能当作执行指令"。截断轮次不会产生 assistant 消息，也不执行任何工具。

因此实际收敛链路是：上下文增长 → 估算比值上升 → 触发硬水位 → 先压缩续命（最多 3 次）→ 压不下去才撤掉工具 → 模型只能输出文本 → 正常出口。软水位不再参与这条链路，它只决定 run 结束后要不要写 checkpoint。

## 九、事件与状态机

`PersistedRunState`（`agent_service.ts:255-555`）把扁平的 `AgentEvent` 流折叠为可观测的 run：

- `loop_health` 是循环健康度的对外出口。当前 reason 取值全集：`context_compaction_started`、`context_compaction_completed`、`context_compaction_failed`（运行内压缩失败，消息未改动）、`context_compaction_degraded`（运行后 checkpoint 已存但摘要为回退）、`context_watermark_exceeded`、`context_hard_watermark_guard`、`token_usage_observed`、`model_response_truncated`、`repeated_tool_failure`、`checkpoint`（由 `agent_runtime.ts` 产出）、`repeated_tool_failure_limit`（由 `agent_service.ts` 产出）。
- 叙事文本落库有 250ms 防抖（`:390-397`）；`plan_update` 会先清空叙事缓冲再落 plan step。
- run 级字段：`status`、`stopReason`、`loadedTools`、`loadedSkills`、`summary`、`plan`。

> **已知缺口 2（类型）**：`loop_health.reason` 是裸 `string`（`types.ts:34`）。生产端与消费端各写一遍字面量，且 `agent_service.ts:93-96` 依赖字符串精确匹配来决定是否触发运行后压缩。建议提为 union 常量或枚举，让拼写错误在编译期暴露。

### 轨迹的读回

`transcript/events.jsonl` 是**唯一 append-only 的真相层**：它记录每次模型请求的完整 `messages`（system prompt 作为 `messages[0]`）与完整工具 schema，因此"模型当时看到了什么"可以从它精确重建。`history.jsonl` 里的 `messages` 数组**不能**用于此目的——它既无 system prompt 也无 pinned workspace 块。

| 入口 | 作用 |
| --- | --- |
| `GET /api/conversations/:id/transcript` | 返回该会话的 run 摘要与事件。支持 `?runId=`、`?afterSequence=`、`?limit=`（默认 500，上限 5000） |
| `GET /api/conversations/:id/transcript/agent-events?runId=` | 把该 run 的 runtime 事件流（`AgentEvent[]`）从日志重建后返回 |
| `GET /api/conversations/:id/transcript/blob?ref=blobs/sha256-<hex>.txt` | 取回被内容寻址的**完整**工具结果（模型当时只看到截断预览） |
| `GET /api/conversations/:id/transcript/tree` | 会话树的轨迹地图：每个会话的 run 摘要、事件数、`roleId` / `parentConversationId` / `depth`。单个日志损坏时该节点标 `damaged`，不拖垮整棵树（`?maxDepth=` 默认 8） |
| `transcript_reader.ts` | 读侧实现：`readTranscript()` / `toAgentEvents()` / `agentEventsByRun()` / `resolveTranscriptBlobPath()` |
| `transcript_log.ts` | 读写共用的解析与恢复规则（纯函数） |
| `scripts/measure-transcript-size.mjs` | 只读体积测量，用于判断是否需要压缩 |

事件类型共 **8 种**：`run_start`、`model_request`、`model_chunk`、`model_response`、`tool_call`、`tool_result`、`run_end`、`engine_event`。其中：

- **`engine_event`** 承载没有一等记录的 runtime 事件：`info`（run 上下文）、`loop_health`、`mcp_status`、`planning_panel`、`security_approval_request` / `security_approval_result`、`workspace_artifact`、`error`。**工具调用、模型响应与叙事刻意不镜像**——它们已有自己的记录，重复存一份正是本日志要消除的；读侧 `toAgentEvents()` 从 `tool_call` / `tool_result` 重建工具行，并从 `model_response.content` 重建叙事，位置取该记录自己的 `sequence`，因此文字仍停在它原本那次工具调用之前。被长度上限截断的回合（`finishReason: 'length'`）不重建：它的文字已从消息内容里扣掉。
  **注意**：把叙事改成写侧镜像（让 `flushRunNarration` 走 `pushRunEvent`）修不好顺序——runtime 先写 `tool_call` 记录再 yield `tool_call_start`，镜像出的事件会落在工具调用**之后**。
- **run 事件不再存进 assistant 消息**：`StoredRunState.events` 已改为**读取时派生**（`getMessages()` 从 transcript 现算并附加），`persist()` 只写 `runId`。`history.jsonl` 因此不再保存这批事件，而 Web 与上下文装配消费的消息形状保持不变。一个 run 的 runtime 事件流可用 `GET .../transcript/agent-events` 取回。
- `model_request.budget` 是**当次请求的上下文预算**；`model_request.degradations` 记录该请求被降级的原因——硬水位超限时 `tools` 字段被整个移除（见 §一），此时 `tools: null` 与"本轮刻意无工具"在日志中**只能靠 `degradations` 区分**。
- `tool_result.durationMs` 只含**工具体执行时间**（不含安全评估与审批等待）；被拒绝的调用**没有**该字段，缺失本身即"未执行"。
- `tool_result.producedFiles` 来自工具结果里的 `file:{...}` 或 `artifacts:[{...}]`（后者是 `execute_python` 把内核产出的图提升为 workspace artifact 的形态）。工具若产出了文件却未上报，这里为空——**记录的是观测到的事实，不是推测**。
- **思维链（reasoning）没有一等记录，它只存在于 `model_chunk` 里**：`llm_client.ts` 在解析前把原始 chunk 深拷贝给 recorder，而 `reasoning_content` / `reasoning` 就藏在 `data.chunk.choices[0].delta` 中。读侧 `toAgentEvents()` 按 `requestId` 把这些 delta 拼接成**每个请求一段**的 `thinking` 事件，位置在该回合的 `model_response` 与工具行之前。这条选择的代价是显式的：**思维链的持久性等于原始 chunk 的持久性**，将来若裁剪 `model_chunk`（`scripts/measure-transcript-size.mjs` 正是为该决策准备的），思维链会随之消失，届时需要把它提升为一等记录。
- **思维链永不回灌给模型**：`llm_client` 把它归一化成独立的 `thinking` 流事件，`agent_runtime.ts` 的流循环**只把它 `yield` 给 UI，不累加进 `turnContent`**——后者会成为 assistant 消息、`model_response.content` 与下一次请求的 `messages`。`agent_service.ts` 也不把它并进 `fullContent`。这条不变式由 `test/agent_runtime_reasoning.test.ts` 用假 provider 钉住（断言第二个请求体里不含第一轮的推理文本）。
- 前端把 `thinking` 渲染成**默认折叠**的独立块（`ThinkingBlock.jsx`），位置与文字/工具行共享同一套顺序语义；直播侧逐 delta 合并（`appendLiveThinking`）成一段，与读侧"每请求一段"的形状一致。它**不参与** `findUnrenderedNarration` 的相减（那里只处理 `type === 'text'` 的 part），因为它不属于 `message.content`。
- 缺少 `run_end` 的 run 在读回时状态为 `open`：读取器**无法区分**"正在运行"与"崩溃中断"，因此不猜测结果。
- **团队与子代理的轨迹是一棵树，不是一份日志**：根会话、每个角色会话、每个委派子会话各有自己的 `events.jsonl`。`run_start` 记录 `agentId` / `roleId` / `parentConversationId` / `parentRunId` / `delegationDepth`（全部可选，旧日志照常可读），所以单份日志也能自述身份与血缘，不必依赖旁边的 `session.json`；整棵树的 run 地图由 `GET /:id/transcript/tree` 提供，事件仍走单会话端点下钻。子代理的完成通知**不写进父会话的 `events.jsonl`**：它落在父会话的 context store，下一轮随 `model_request.messages` 回放；父日志记录的是 `subagent` 工具调用及其结果。
- **面板（goal / todo）按团队合并读取**：`/panels` 在团队里 fold 根会话加全部角色会话（按 `createdAt` 取最新），响应用 `scope: "team" | "conversation"` 说明用了哪条规则。Web 对根会话的写入落在根日志——根从不运行，append 不可能与 recorder 竞争，而任何角色都能通过同一合并视图读回；子代理不参与团队 goal（它按设计隔离运行）。
- 重建出的 `tool_call_result.result` 是**模型可见文本**，而非运行时的 UI 预览（两者截断口径不同）；完整原文仍可通过 blob 路由取回。

**崩溃语义**：写句柄在打开时会丢弃不可用的末尾记录并截断该尾部（`repairLogTail`），若已提交前缀的序号不连续（缺口或重复）则**显式报错而非重新编号**——历史实现曾在此静默从 0 重开，产生无法被下游发现的重复序号。读取路径**从不修复存储**，只报告 `tornTail`。

### Run manifest（代码 / 环境 / 参数 / 产物）

transcript 回答"模型看到了什么"，manifest 回答**"这次结果是谁、在哪、用什么版本跑出来的"**。每个 run 在终态（`completed` / `failed` / `cancelled`）后异步写一份 JSON：

```text
<WORKSPACE_ROOT>/.sessions/<projectKey>/<sessionId>/runs/<runId>/manifest.json
```

| 字段 | 来源 | 缺失时 |
| --- | --- | --- |
| `code` | `git rev-parse HEAD` / `--abbrev-ref` / `status --porcelain --untracked-files=no` | `available:false` + warning |
| `environment.python` / `.r` | `.bioenv/bin/python`、`Rscript` 探针（`BIOAGENT_PYTHON` / `BIOAGENT_ENV_BIN` 优先） | `null` + warning |
| `environment.host/platform/node` | 进程环境 | 恒有 |
| `tools[]` | transcript 的 `tool_call` + `tool_result` 配对；参数哈希覆盖完整 `parsedArguments` | 空数组 |
| `artifacts[]` | `tool_result.producedFiles` + `workspace_artifact` 事件 + 项目目录扫描（仅 run 期间修改的文件） | 空数组 + warning |
| `transcript` | `events.jsonl` 的 sha256 / 字节数 | `null` |

- **fail-open**：`agent_service.ts` 的 `persistAgentRun()` 只 `void finalizeRunManifest(...)`，写入失败不影响 run 状态、不延迟终态；所有异常收敛为 null。
- **幂等**：`manifestPath` 记在该 run 的 `metadata` 里，重复 finalize 直接返回已有路径。同一 runId 的并发调用复用同一个 promise。
- **产物指纹**：流式 sha256，单文件上限 2 GiB（超限记 `skipped: "too_large"`）；项目扫描跳过 `.git` / `node_modules` / `tools` / `envs` / `db` 等重目录，最多 2 万条目、200 个产物、深度 6；`BIOFLOW_MANIFEST_SCAN=0` 可关闭扫描。
- **读取**：`GET /api/conversations/:id/runs/:runId/manifest` 返回 JSON；`?format=markdown` 返回可直接贴进方法节的"可复现性卡片"；`GET /:id/runs/:runId` 附带 `manifestPath`。终态 run 在写入完成前短暂返回 `404 { code: "manifest_not_ready" }`，这是可重试状态。
- **测试**：`test/environment_snapshot.test.ts`、`test/run_manifest.test.ts`、`test/run_manifest_route.test.ts`。

## 十、并发与取消

- **会话级串行（两层，别混用）**：`activeConversationControllers` 是**请求级占位**，负责对第二个 HTTP 请求返回 409 并传播 abort；真正的"一个会话一个写者"由 `runRegistry`（`agent/run_registry.ts`）保证——`AgentService.runCompletion` 按会话 FIFO 排队，覆盖 HTTP、团队派发、子代理与 goal 轮。**不要**把前者当互斥锁：团队派发会对同一角色并发发起两次 `runCompletion`，而子代理 run 根本不经过 HTTP。两个 recorder 同时写同一份 append-only 日志会产生重复序号，而写侧永不重编号，损坏是永久的。
- **run 级取消**：`POST /api/conversations/:id/runs/:runId/cancel` 触发 `activeRunControllers` 中对应 controller 的 abort（`:283-302`）。
- **断连即取消**：`req.aborted` 与 `res.close` 都会 abort（`:333-338`），避免孤儿 run 继续消耗 token。
- run 结束（含异常）时**不再**回收 Python 内核：内核按 `conversationId` 跨 run 复用（30 min 空闲 TTL、最多 4 个会话 LRU）；后端停止时 `cleanupAll` 回收。
- `exec_command(run_in_background=true)` 的后台 shell 任务**不随 run 结束清理**，由 `shell_kill`、自然退出或后端停止回收（`core_tools/shell_tasks.ts`）；启动时 `recoverOrphans` 只清理上次后端残留的进程。
- run 级取消只终止当前 run 的工具调用与 Python cell，不会杀掉已启动的后台 shell 任务；用户需要显式 `shell_kill`。

## 十一、扩展指引

新增一个 CoreTool 需同步四处：

1. 在 `agent/core_tools/ids.ts` 添加工具名常量；
2. 在 `core_tools_runtime.ts` 的 `CORE_TOOL_REGISTRY` 注册定义，**同时声明 `risk` 与 `parallelizable`**（若声明可并行，必须确认为只读操作，见缺口 1）；
3. 在 `executeCoreToolInternal`（`core_tools_runtime.ts:546-610`）接上执行分支，并把错误收敛为 `{ ok: false, error }` 形态——`tool_failure_guard` 依赖该形态识别失败；
4. 在对应 Skill / prompt 中说明用法，并补 `agent-client/backend/test/` 下的契约测试。

若新增工具会产生 UI 副作用（如产物落盘、规划面板），应复用 `extractToolResultEvents`（`tool_result_events.ts`）的 JSON 约定，让串行与并行两条路径共享同一解析器。

## 十二、测试覆盖现状

现有测试集中在支撑模块：`context_manager`、`runtime_tool_dispatcher`、`core_tools_runtime`、`tool_result_events`、`transcript_store`、`persisted_narration` 等。

> **已知缺口 3（测试）**：主循环历史上没有集成测试。2026-10 起 `test/context_watermark_policy.test.ts` 用本地桩端点驱动真实 `chat()`，覆盖了水位判定这一段（0.6 只标记、0.8 才压缩、每 run 次数上限），可作为补测模板。**仍未覆盖**：撤工具后的收敛、截断丢弃整批 tool_calls、并行与串行分岔、失败熔断阈值。

## 十三、一手来源索引

| 主题 | 位置 |
| --- | --- |
| 主循环与终止判定 | `agent-client/backend/src/agent/agent_runtime.ts` |
| 循环水位常量（含 `MAX_RUNTIME_COMPACTIONS`） | `agent-client/backend/src/agent/context_manager.ts:12-28` |
| 循环预算与估算常量 | `agent-client/backend/src/agent/context_manager.ts:29-38` |
| 循环健康检查间隔 | `agent-client/backend/src/agent/agent_runtime.ts:35` |
| 失败阈值 | `agent-client/backend/src/agent/tool_failure_guard.ts:1-2` |
| 审批超时 | `agent-client/backend/src/agent/security_approval_store.ts:24` |
| 工具注册表与风险标记 | `agent-client/backend/src/agent/core_tools_runtime.ts:339-427` |
| 安全策略 | `agent-client/backend/src/agent/security_policy.ts:20-57` |
| run 状态折叠 | `agent-client/backend/src/agent/service/agent_service.ts:255-555` |
| 事件契约 | `agent-client/backend/src/agent/types.ts:31-71` |
| 流式响应与取消 | `agent-client/backend/src/http/routes/conversations.ts:283-375` |
