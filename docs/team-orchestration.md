# 团队编排（Team Orchestration）

一个会话就是一个**研究团队**：五个固定角色 + 一条合并时间线 + 一份共享工作区。
本文件描述它的边界，也记录"为什么是这种形态"——这个方向在 2026-08-19 的 `3f2f343` 被整体删除过一次
（当时是 `main + researcher + bioinformatics-reviewer + summarizer` 加上静态 `subagents` 绑定），
所以这里把"做什么 / 不做什么"写死，避免再次因为概念膨胀被移除。

## 一、角色

| id | 标签 | 负责 | 不负责 |
| --- | --- | --- | --- |
| `pi` | PI | 目标拆解、派发、仲裁、验收 | 替其他角色干活 |
| `searcher` | Searcher | 文献检索、证据综合、研究现状、假设生成与排序 | 执行实验、写论文 |
| `researcher` | Researcher | 方案与实验设计、执行、统计、结果解释 | 文献综述、写正文 |
| `writer` | Writer | 框架与叙事、结果组织、图表、引用、投稿材料 | 改数据、跑分析 |
| `reviewer` | Reviewer | 创新性、假设、方法学、数据与统计、结论一致性 | 直接改稿 |

角色集合是**固定的**：`TEAM_ROLE_IDS` 是类型，不是数据。设置页能改每个角色的模型、指令、CoreTool、
Skill、MCP 与知识条目，但不能增删角色。

## 二、数据模型

```text
团队 = 根会话（用户创建的那条）
       └─ 角色会话 ×N（按需创建，Conversation.roleId 标记）
```

- 角色会话是根会话的**子会话**，与根共享 `projectPath`（一个项目 = 一个工作目录），所以"工作区共享一个"
  不需要额外机制。
- `roleId` 是"角色会话"与"委派子 agent"的唯一区别：两者都是子会话，只有角色会话属于团队时间线。
- 团队状态存在根会话目录下的 `team.json`：

```json
{ "schemaVersion": 1, "mode": "auto", "activeRoleId": "pi", "lastRoute": null, "cards": [] }
```

## 三、一次用户消息的路径

```text
POST /api/conversations/:rootId/team/runs
  → RoleRouter.decide()            # v1: always-pi
  → emit route_decision
  → ensureRoleSession(root, role)  # 按需建角色会话
  → 在该会话里 runCompletion
  → 事件打 roleId / roleSessionId 转发回同一条 NDJSON 流
  → 本轮结束后排空团队消息（team_message）：
    · lead 发的 delegate/append/relay → 跑目标角色（并行上限 maxConcurrentDispatches），
      每个角色产出交接卡，控制权回到 lead 验收；
    · 角色发的 deliver → 变成 lead 的一轮输入，lead 直接处理；
    · 角色发给角色的 relay → 门禁放行后跑目标角色，回答作为 reply 直接回到发起方
  → done
```

- 合并时间线是**读模型**：`GET /api/conversations/:id/team/messages` 把根会话与各角色会话按时间拼接，
  消息带 `roleId`。没有任何镜像消息。
- **切换角色 = 进入该角色的会话**：`PUT /:id/team {activeRoleId}` 会按需创建角色会话并返回它的
  `sessionId`，前端随即导航过去。进入之后右侧 subagent 面板列的就是**该角色委派**的子 agent
  （`GET /conversations/<角色会话 id>/subagents`），composer 可写，面包屑回到团队会话。
  切回 `auto` 则回到根会话的合并时间线。
- 角色之间**不共享 transcript**：被派发的角色只拿到 `<team_handoffs>` 卡片块 + 自己的历史。
  跨角色的信息交换只能走 `team_message`（见 §五.4），不共享会话记录。
  卡片由运行时生成（goal 来自派发、summary 来自子会话最后一段回复、artifacts 来自登记的产物），
  不接受模型自由转述。
- **回答过程中可以随时切换角色**：切换只是改下一轮的路由目标并导航到目标角色会话，本轮继续由
  正在回答的角色跑完（它跑在自己的会话里，不依赖当前页面）。切换器在运行中保持可用。
- **切到正在回答的角色会话发消息 = 排队**：会话被占用时（本页在跑，或团队正跑在这个角色会话里）
  composer 不放行新 run，而是把消息排进队列，并提示"当前回答结束后自动发送"；占用结束时由
  queue pump 自动发出去。服务端 409 不会被甩到聊天里——它只会把消息按 `notBefore` 退避后重新排队，
  因此"活动快照晚一个轮询周期"这种竞态也不会变成一条错误。
  团队根同理：只要团队里还有角色/子 agent 在跑，在团队会话里发的消息也排队。

### 运行状态（侧栏的圈与点）

侧栏只有团队会话一行（角色会话不单独成条），它要回答"团队现在忙不忙、有没有我没看的结果"：

- `GET /api/conversations/activity` 返回**进程内**的运行快照（`run_activity.ts`），
  按 `parentConversationId` 把每个 run 的活跃状态**上卷到所有祖先**——角色会话在跑、或角色委派的
  子 agent 在跑，团队会话都会转圈；`runningRoles` 说明是哪个角色在忙。
- 完成点用单调序号 `seq` + 本地 `seen` 标记（localStorage）判定，比较的是序号不是挂钟
  （浏览器和后端不保证同一个时钟）；打开该会话即视为已看过。`epoch` 在每次后端重启时变化，
  重启前的序号不参与比较。
- 运行状态是**内存态**：进程死了就没有"正在运行"这回事。持久化的 run 记录仍然是历史真相，
  但它会把崩溃前的 run 读成 running，所以不拿它当指示灯。
- 本标签页自己发起的 run 仍走本地状态（请求发出的瞬间就有值），两端取并集，圈不会晚一个轮询周期。
- 同一个快照也喂给团队切换器：某个角色（或它委派的子 agent）在跑时，它的格子转圈并在副标题写
  "运行中"，据此判断"现在换过去会不会要排队"。`auto` 是模式不是角色，不转圈。
- 角色格子还有完成点：**全团队最近一次结束且尚未打开的那个角色**带点，副标题写"已完成"。
  只给最新的一个打点（不是每个未读都打），否则历史轮次会积一堆点、打开一个还会把更旧的点顶上来。

## 四、路由

`team.router.engine` 有三个取值：

| 值 | 状态 | 行为 |
| --- | --- | --- |
| `always-pi` | 已实现 | 每条消息交给 `leadRoleId` |
| `rules+llm` | 预留 | 未实现前回落到 `fallbackRoleId`，`source: "fallback"` |
| `biod` | **已实现** | 调 `biod.multitask.serve` 的 `/v1/decide/role_select`；`confidence < tau`（默认 0.6）、sidecar 失败、或 `BIOFLOW_BIOD_DISABLED=1` 时回落 `fallbackRoleId`（pi） |

`decideRole()` 永不抛错：路由失败也落到兜底角色，用户消息不会丢。

## 五、配置

- 每角色：`agents.json` 的 `agents[]`（`promptFile`、`llmProviderId`、`coreToolIds`、`skillIds`、
  `mcpServerIds`、`knowledgeEntryIds`、`label`、`orchestratorDescription`）。
- 团队级：`team.leadRoleId`、`team.router`、`team.limits.maxConcurrentDispatches`，
  通过 `PUT /api/config/manage/team` 修改。
- `team_message` 每个角色都有（没有它角色无法向上交付），但**action 面按角色裁剪**，且**委派的子
  agent 不继承它**：`delegationDepth > 0` 时 `AgentContextResolver` 会从生效 profile 里摘掉
  `team_message`，工具 schema 列表、core-tool 目录和 `<team>` 提示词块一起消失
  （`team_message_executor` 另有同条件兜底拒绝）。子 agent 继承角色的 prompt / CoreTool / skill /
  MCP / 知识条目，唯独不继承团队通信权。
- 角色能力按职责分配（完整矩阵见 `agent-client/backend/config/README.md` 的
  「Role capability matrix」）：PI 绑定全部 skill / MCP / 知识条目以便判断与兜底；Searcher 拿检索与
  数据库类（`science-search`、`curated-bio-datasets`、`bioservices`、`gget`、`lit-review`、
  `hypothesis-design`、`experiment-design`、`evidence-appraisal`，以及 biomcp / biocontext /
  tooluniverse 证据 MCP）；Researcher 拿几乎全部执行与分析 skill、设计/证据核验 skill 与全部知识条目；
  Writer 拿引用核验、三个临床文档 skill 与写作/证据/审稿 skill；Reviewer 拿审查、设计、写作、
  证据核验、综述与 `bio-workflow`。
- 同一份绑定也决定 `<tool_library_domains>`：领域内没有该角色可用的 skill / MCP 条目时，那一行不进
  它的 system prompt（PI 8 个域、Researcher 7 个、Reviewer 6 个、Searcher/Writer 各 5 个；
  biocontext 的条目分布在检索、临床、组学和实验自动化域，因此窄角色看到的域会随它绑定的证据服务变化）。
  细节见 `docs/toollibrary-mechanism.md`。
- 所有角色都必须保留 `tavily` / `exa`：`web_search` 用本 agent 连接的 MCP server 执行搜索，解绑这两个
  internal provider 会让该 CoreTool 直接返回 `NO_WEB_SEARCH_PROVIDER`。
  `backend/test/agent_capability_bindings.test.ts` 守着这条约束，并校验每个角色的
  skill / MCP / 知识条目绑定都能在磁盘上解析到。

### 五.4 团队通信（team_message）

一个工具，四种意图，按角色裁剪：

| 调用方 | 可用 action | 目标 |
| --- | --- | --- |
| lead | `delegate` / `append` / `relay` | 其余角色 |
| 其余角色 | `deliver` / `relay` | lead / 其余角色 |

- **投递语义是"追加"，不是"排队"**：消息先落 `team.json`，再进进程内待投递队列；路由在
  发送方本轮结束后排空，在目标角色的**既有会话**里执行。没有抢占、没有 409、没有中断。
- **回复直连**：角色发给角色的 relay 执行完后，运行时把回答打包成 `reply` 送回发起方会话，
  不再经过 lead，也不再过一次门禁。
- **门禁只拦角色发起的 relay**（biod 决策点 `relay_select`）：判定必要性 / 合理性 / 风险性，
  返回 `allow` / `reject` / `escalate`；置信度低于 `RELAY_CONFIDENCE_FLOOR`（0.75）归入
  `escalate`。sidecar 已实现 `/v1/decide/relay_select`（`biod-mt-v1`）；`BIOFLOW_BIOD_DISABLED=1`、
  不可达、超时或返回未知值，一律 fail-open 到 `escalate`（`agent/team/relay_gate.ts`）。
- **三种结论的后果**：`allow` 直接送达；`reject` 不发送且把理由放回发起方的工具结果，发起方
  可改用 `deliver`；`escalate` 变成一条给 lead 的交付，lead 下一轮读到时裁决。
- **lead 的可见性不花模型调用**：每次角色转述都往 lead 的 transcript 追一条
  `[团队通信 · from → to · 转述请求]`，但**不唤起** lead 的 run。
- **提示词**：每个角色的系统提示词顶部有 `<team>` 块，列成员职责和本角色可用的路径。
  名单与门禁共用 `agents.json` 的 `label` / `description`。块只描述真实存在的那一跳——
  门禁放行时 lead 根本不参与，写成"经 PI 转达"会让角色汇报出不存在的审批。

> **反转记录**：本文件此前把"角色间自由对话"列为 v1 非目标（只能经 PI 派发）。2026-11-01
> 起放开为**受门禁的定向转述**，原因是角色在完成委托时常缺一条补充信息的通道。放宽的边界：
> 只有 `relay` 一种意图、只判定一次、每次请求内最多 `MAX_TEAM_HOPS`（16）跳、全程落库。

### 五.5 会话级模型覆盖（输入框里的模型选择器）

- **作用域 = (团队根会话 × 角色)**，存根会话目录下的 `llm-overrides.json`（与 `team.json` 并列，
  不升它的 schema）。删会话即删覆盖；不写 `agents.json`，也不写用户的 `user_role_bindings`。
- **解析顺序**：会话覆盖 > 用户角色绑定 > `agents.json` 角色绑定 > `llm.json` 默认。覆盖是完整
  三元组（provider + model + 思考强度），命中时整体替换，**不做逐字段拼接**——拼接会拼出
  provider 与 model 不同源的组合，解析必然 400。
- **auto 下作用于最近接手的角色**：团队根的 picker 写的是 `activeRoleId` 那一份；路由换角色后，
  新角色用它自己的覆盖或绑定，所以模型与强度跟着角色变。角色会话里改的是同一槽位。
- **接口**：`PUT /api/conversations/:id/llm-override`（`:id` 可为根或角色会话；角色会话只能改
  自己）、`DELETE .../llm-override?roleId=`；`GET /api/conversations/:id/team` 的每个角色带
  `llm{ override, selection, source, routable }`，前端不重算优先级。
- **失效不静默替换**：覆盖指向已删除的 provider/model 时 `routable=false`、chip 标红，运行仍按
  `unknown-provider` / `unknown-model` 报错。
- **委派子 agent 继承**：沿 `parentConversationId` 向上找到团队根、按创建者角色读同一份覆盖；
  `team_message` 派发到别的角色会话时读那个角色自己的覆盖。
- **生效时点**：每次 run 解析一次，所以"下一轮生效"；运行中的轮次不改，排队消息与 goal 自动
  续跑都从服务端状态读取。

## 六、非目标（v1 明确不做）

- 自定义角色 / 增删角色；
- 角色间**自由**对话（无限跳、无门禁、无记录的闲聊）：允许的只是经 `relay_select` 门禁、
  有落库记录、每次请求内最多 16 跳的定向转述。§五.4 记录了这次反转。
- Reviewer 自动打回 Writer 的闭环；
- 跨会话的团队长期记忆（团队记忆 = 当前会话的 `team.json`）；
- 总派发次数上限（只限并发，不限制工作量）；
- biod `role_select` 已接入；尚未做 `rules+llm` 引擎。

## 七、验证入口

- `backend/test/team_container.test.ts`：团队容器（角色会话、名册、状态、合并时间线、级联删除）。
- `backend/test/team_message_bus.test.ts`：消息渲染、落库上限、队列取尽语义。
- `backend/test/team_message_flow.test.ts`：端到端（lead 派发 → 角色作答 → 卡片 → 验收）与守卫。
- `backend/test/team_message_roles.test.ts`：角色侧 ACL、deliver、转述升级到 lead、lead 可见性。
- `backend/test/relay_gate.test.ts`：门禁的 allow / reject / 低置信度 / 不可达 / 超时 / 未知值。
- `backend/test/team_prompt_roster.test.ts`：`<team>` 块存在、位置、逐角色裁剪、子会话不继承。
- `backend/test/team_routing.test.ts`：路由四条路径 + 端到端团队运行。

- `backend/test/conversation_activity.test.ts`：运行注册表、祖先上卷、完成序号、活动接口。
- `web/test/team_view.test.mjs`：切换器网格、角色徽标、分隔线。
- `web/test/activity_view.test.mjs`：运行圈合并、未读完成点、序号与 epoch 处理。
