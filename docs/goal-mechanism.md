# Goal 机制（会话级目标 + 自动续轮）

> 基线：`3de49b6`，2026-11-01 引入。
> 范围：`agent-client/backend/src/agent/conversation_panels.ts`、`core_tools/goal_executor.ts`、`core_tools_runtime.ts` 的 `goal` 注册条目、`http/routes/conversations.ts` 的 `/panels` 与 `/goal`、`service/agent_service.ts` 的 `goalRound`、`web/src/components/chat/GoalDock.jsx` + `web/src/hooks/useConversationPanels.js`。
> 设计参照：`research/dsh-todo-goal/`（DSH v0.2.1-rc.5 的 goal 实现调研）。本文描述**当前实现事实**。

## 一、结论速览

- goal 是一个**会话级的持久状态文档**，不是运行时对象：每次变更往 transcript 追加一条 `goal_change`（完整快照或 `null` 墓碑），当前值由 `foldConversationPanels` 折出。
- **一次 HTTP run 可以包含多轮**：`POST /:id/runs` 在 `runCompletion` 返回后检查目标，仍可续轮就再跑一轮，共用同一个 NDJSON 流（`conversations.ts` 的 `for (;;)`）。
- **`roundsStarted` 由日志派生**，不是计数器字段：每轮开始时落一条 `goal_round`，fold 取同 goal id 的最大 `round`。
- **`autoContinue`（armed）是持久字段**。本运行时没有进程内 goal 注册表，目标必须自带"能否再开一轮"的许可，否则重启后会自动继续烧 token。
- **模型不能 resume**：`update_goal` 的 action 只有 `edit` / `pause` / `complete` / `blocked`；恢复由用户在 GoalDock 或 HTTP 上做。
- 变更走 **CAS**：`goal_id` + `revision` 必须与当前值一致，否则 `GOAL_STALE_REVISION`。
- 生成期的安全边界：`maxRounds` 默认 5、上限 50；单请求最多自动续 20 轮；客户端断开、取消、目标非 active 或未 armed 都立即停止。

## 二、领域模型

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `GoalSnapshot` | `id` / `revision` / `objective` / `phase` / `blockedReason?` / `maxRounds` / `autoContinue` / `createdAt` / `updatedAt` | 持久文档 |
| `GoalState` | `GoalSnapshot` + `roundsStarted` | 投影值（`roundsStarted` 由 fold 算） |
| `GoalPhase` | `active` / `paused` / `blocked` / `complete` | 持久生命周期 |
| `GoalOperation` | `create` / `edit` / `pause` / `resume` / `complete` / `block` / `clear` | 状态迁移动词 |

`applyGoalMutation(current, request, now?)` 是**唯一**迁移实现（纯函数），HTTP 端点、工具、续轮终止共用它：

| 操作 | 允许的来源 phase | 结果 | `autoContinue` |
| --- | --- | --- | --- |
| `create` | 无目标，或当前为 `complete` | `active`，`revision = 1`，`roundsStarted = 0` | `true` |
| `edit` | 任意（保留 phase） | 目标/额度替换 | 不变 |
| `pause` | `active` | `paused` | `false` |
| `resume` | `paused` / `blocked` / `active` 且未 armed；且 `roundsStarted < maxRounds` | `active`（丢弃 `blockedReason`） | `true` |
| `complete` | 非 `complete` | `complete` | `false` |
| `block` | `active`（必须带 `{code, message}`） | `blocked` | `false` |
| `clear` | 任意 | `null` 墓碑 | — |

错误码（`GoalTransitionError.code`）：`GOAL_ALREADY_EXISTS`、`GOAL_NOT_FOUND`、`GOAL_INVALID_TRANSITION`、`GOAL_INVALID_OBJECTIVE`、`GOAL_INVALID_MAX_ROUNDS`、`GOAL_INVALID_BLOCK_REASON`、`GOAL_ROUNDS_EXHAUSTED`。

`updatedAt` 单调：`nextTimestamp` 取 `max(now, previous)`，回拨的墙钟不会让 fold 看到倒流的时间。

## 三、事件与投影

只有两种事件，都落在 transcript 的 `engine_event` 里：

| 事件 | payload | 产生者 |
| --- | --- | --- |
| `goal_change` | `{ operation, goal: GoalSnapshot \| null }` | 工具（经 `uiEvent` → `extractToolResultEvents`）、HTTP `/goal`（经 `appendConversationStateEvent`）、续轮终止 |
| `goal_round` | `{ goalId, revision, round }` | `agent_service.runCompletion`（`request.goalRound`），在循环开始前落库 |

- 两者都加入 `TRANSCRIPT_MIRRORED_EVENT_TYPES`，因此普通 run 内的事件由 run recorder 持久化。
- **无 run 的变更**（用户在 GoalDock 点暂停）用 `appendConversationStateEvent` 写入，`runId = STATE_RUN_ID ('state')`；`foldRuns` 显式跳过该 id，避免伪造出一个 open run。
- 并发约束：`POST /:id/runs` 进行中时 `POST /:id/goal` 返回 **409**——运行中的 recorder 持有自己的 sequence，第二个写入者会撞号。

fold（`foldConversationPanels`）的规则：`goal_change` 整值替换并按 id 继承 `roundsStarted`；`goal_round` 只统计当前 goal id 的轮次；`null` 视为清空。

## 四、模型工具

| 工具 | 参数 | 权限 | 返回 |
| --- | --- | --- | --- |
| `get_goal` | 无 | 任意深度 | `{ ok, goal, message }` |
| `create_goal` | `objective`（必填）、`max_rounds` | **仅顶层 agent**（`delegationDepth === 0`） | `{ ok, operation, goal, message, uiEvent }` |
| `update_goal` | `goal_id`、`revision`、`action`、`objective?`、`max_rounds?`、`blocked_reason?` | `edit`/`pause` 仅顶层；`complete`/`blocked` 任意深度 | 同上 |

- 工具读取当前目标靠 `readCurrentGoal(conversationId)` → `readTranscriptRecords` + fold；读不到时返回 `null` 而不是抛错（"没有目标"是正常答案）。
- `update_goal` 的 `action` 与参数是互相约束的：`objective`/`max_rounds` 只与 `edit` 同用，`blocked_reason` 只与 `blocked` 同用，违反即 `GOAL_TOOL_INVALID_UPDATE`。
- 委派子 agent 不能 `create`/`edit`/`pause`——否则一个 helper 可以改写它被要求做的工作。

## 五、自动续轮

`conversations.ts` 的 run 循环：

```text
runCompletion(message, goalRound?)         ← 用户这一轮
  ↓ 结束且流仍打开、未取消
读当前 goal
  ├─ 不是 active / 未 armed → 停止
  ├─ roundsStarted >= maxRounds → block(round-limit) 后停止
  └─ 否则 round = roundsStarted + 1
        turnMessage = renderGoalRoundPrompt(goal, round)
        goalRound   = { goalId, revision, round }
        回到 runCompletion(...)
```

- **只有消息真正进入 transcript 才消耗额度**：`goal_round` 在 `runCompletion` 开头落库，Config 校验之外没有第二处自增。
- 续轮提示词把 objective 用 `JSON.stringify` 编码（防止多行目标伪造外层标签），并写明 `Round: n/max`。
- 终止矩阵：客户端断开 / `abortSignal` 取消 / `phase ≠ active` / `autoContinue === false` / 额度耗尽（写 `block(code: "round-limit")`）/ 单请求 20 轮上限。
- 模型可在轮内 `complete` 或 `blocked`；`blocked` 没有 DSH 的"连续 N 轮"机械阈值——本实现的 `blocked_reason` 由模型判断并在提示词里要求"同一具体条件跨轮持续"。

## 六、HTTP 与 Web

| 端点 | 语义 |
| --- | --- |
| `GET /api/conversations/:id/panels` | `{ asOfSequence, goal, todos, tornTail }`，服务端 fold |
| `POST /api/conversations/:id/goal` | `{ action: create/edit/pause/resume/clear, objective?, max_rounds? }`；返回 `{ goal }`；运行中 409；非法迁移 409 + `code` |

Web 端：`useConversationPanels` 在会话切换与 run 结束时拉 `/panels`，运行期间用流事件整值叠加；`GoalDock` 渲染阶段、objective、`第 n/m 轮`、blockedReason，提供暂停/恢复/编辑/清除（清除为两步确认），运行中禁用全部动作。`GoalDock` 与 `TodoDock` 一样挂在 composer 上方（`ChatView.jsx`），complete 的目标不渲染。

## 七、测试覆盖

| 测试 | 覆盖 |
| --- | --- |
| `backend/test/conversation_panels.test.ts` | 三态归一与 legacy `done`、fold 的整表替换/清空/轮次计数/墓碑、7 种迁移、停用态、额度耗尽、时间单调、续轮提示词 |
| `backend/test/goal_routes.test.ts` | `/panels` 与 `/goal` 全链路、409 冲突、404、工具 CAS 拒绝、委派深度限制、clear 墓碑 |
| `web/test/panels.test.mjs` | 客户端归一与进度、整值事件叠加、可见性、标签、运行中禁用 |

## 八、已知边界

1. 运行中不能从 Web 改目标（409）。停止运行的唯一入口是 composer 的停止按钮，它会同时中断续轮循环。
2. 只有轮数预算，不计 token/时长。
3. 一个会话只有一个当前目标；`complete` 后可 `create` 替换。
4. 续轮提示词会作为普通用户消息进入对话历史，这是刻意的：让"系统为什么又跑了一轮"对人和模型都可见。
5. 没有独立的评估器：`complete` / `blocked` 的判定权在模型，运行时只做机械边界（额度、深度、CAS）。

## 九、一手来源索引

| 主题 | 位置 |
| --- | --- |
| 领域模型、迁移、fold、提示词 | `agent-client/backend/src/agent/conversation_panels.ts` |
| 工具执行与权限 | `agent-client/backend/src/agent/core_tools/goal_executor.ts` |
| 工具 schema 与注册条目 | `agent-client/backend/src/agent/core_tools_runtime.ts`（`GOAL_CORE_TOOL_ID` 条目） |
| 工具名常量 | `agent-client/backend/src/agent/core_tools/ids.ts` |
| 事件类型 | `agent-client/backend/src/agent/types.ts`（`goal_change` / `goal_round`） |
| 工具结果抽取 | `agent-client/backend/src/agent/tool_result_events.ts` |
| 续轮记账 | `agent-client/backend/src/agent/service/agent_service.ts`（`GoalRoundRequest`） |
| run 循环与端点 | `agent-client/backend/src/http/routes/conversations.ts` |
| 无 run 的状态写入 | `agent-client/backend/src/agent/transcript_store.ts`（`appendConversationStateEvent`、`STATE_RUN_ID`） |
| Web 面板 | `agent-client/web/src/components/chat/GoalDock.jsx`、`web/src/domain/panels.js`、`web/src/hooks/useConversationPanels.js` |
