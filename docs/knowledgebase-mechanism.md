# Knowledge Base 知识库机制

> 基线：`3e8e8da`（`feat: bundle exa and context7 as hosted streamableHttp MCP servers`）
> 范围：`agent-client/knowledgebase/`（知识库内容）、`agent-client/backend/src/agent/core_tools/knowledgebase_executor.ts`、`core_tools_runtime.ts` 的 `knowledgebase` 注册条目、`paths.ts` 的 `KNOWLEDGEBASE_ROOT`，以及 `backend/test/knowledgebase_*.test.ts`。
> 本文描述**当前实现事实**，用于新增 / 维护知识条目前的核对；文末标注了已知缺口。
> Knowledge Base 与 Skill 是两套机制：Skill 是能力说明书（可指向 CLI / 工具），由 [`skill-mechanism.md`](skill-mechanism.md) 描述；Knowledge Base 是**纯知识**（正文 + 可查看资源，不含可执行脚本）。

> 2026-10-20：该 CoreTool 与内容目录由 `skillbook` 更名为 `knowledgebase`；历史 DevLog 与各文档「基线」行中的旧名是历史记录，不再回改。

> 2026-11-01：Knowledge Base 增加 **Agent 级绑定**。第一版绑定到知识域（`knowledgeDomainIds`）；随后改为**条目级绑定**（`knowledgeEntryIds`，元素为 `"<domain>/<entry>"`），设置页可逐条勾选。旧字段在读取配置时展开为当时该领域下的全部条目；缺字段的更旧配置迁移为全部条目，显式 `[]` 表示不可检索任何条目。
>
> 2026-11-01：`knowledgebase` 改为**始终注入角色上下文**；`coreToolIds` 里的绑定只决定 `select` 是否交给 biod，未绑定时 `select` 退化为 `index`/`catalog` 浏览结果（`biod={status:"off",reason:"not_configured"}`），由模型自行 `read`。`action` 可省略，缺省即 `select`。

> 2026-10-21：领域目录与领域/条目 name、description 已整体英文化（`科学通用`→`General Science`、`生物信息学`→`Bioinformatics`、`科研平台与数据集成`→`Research Platforms and Data Integration`）；12 个中文条目目录改为英文 slug（如 `Bioinformatics/sequencing-technologies-overview`），条目 id 现为全英文。同时 `skills/生信分析/` 更名为 `skills/bioinformatics/`，toollibrary 的 skill id 同步为 `bioinformatics/*`。

## 一、结论速览

- Knowledge Base 是**两层渐进披露**的只读知识库：第一层领域索引 → 第二层领域内条目目录 → 条目正文。三层内容**不会预注入** system prompt，全部由模型显式调用 CoreTool `knowledgebase` 加载。
- 本体是**磁盘目录树**，没有索引数据库：`agent-client/knowledgebase/<领域>/<条目>/skill.md`。目录是唯一真相来源，`knowledgebase/skill.md` 只补充领域描述。
- 工具是注册表里的 **`knowledgebase` CoreTool 定义**（工具名 `knowledgebase`，显示名 `Knowledge Base`），三个 action：`index` / `catalog` / `read`；`select` 由 dispatcher 处理。
- `risk: 'read_only'`、`parallelizable: true`：任何安全模式都不需要审批，可与其它只读工具并行。
- 工具 schema **不内嵌知识库目录**；第一次 `index` 调用才把领域索引放进上下文。这一点与 tool library 不同：tool library 的 L1 领域索引常驻 system prompt，只有 L2 与正文按需加载。
- **Agent 条目绑定**：`agents.json` 的 `knowledgeEntryIds` 是唯一范围来源，元素为条目 id `"<domain>/<entry>"`。显式 `[]` 表示该 Agent 读不到任何知识；没有该字段的旧记录迁移为：有 `knowledgeDomainIds` 时展开为这些领域当前的全部条目，两者都没有时为磁盘全部条目。过滤器在 `knowledgebase_executor.ts` 内由 `options.entries` 实施，`RuntimeToolDispatcher` 从 `request.mainAgent.knowledgeEntryIds` 传入。
- 知识条目**没有执行面**：执行器从不执行任何文件；`resources/` 只用于展示/引用，检测到可执行扩展名只返回 warning。
- 当前内容：3 个领域、38 条（9 条种子内容 + 20 条从 Skill 迁入的工具文档 + 2026-10-20 新增 3 条决策知识条目 + 2026-11-01 新增 6 条研究法知识条目），其中 `General Science` 10 条、`Bioinformatics` 22 条、`Research Platforms and Data Integration` 6 条；迁入条目正文 6 808–19 723 字符，新增条目正文 7 666–12 597 字符，全部在 30 000 字符内联预算内。
- 内容规模目标：多领域、成百上千条。单领域条目目录支持 `offset` / `limit` 分页（默认 100、上限 200），单页同时受 **30,000 字符**预算约束，避免一次返回过大。
- 观测层对 `knowledgebase` 结果的**内联上限是 30,000 字符**（其它工具 6,000）：领域目录和知识条目要一次完整交给模型；超过 30,000 字符才回落到常规 observation 文件流程。

## 二、磁盘契约

```text
agent-client/knowledgebase/            ← KNOWLEDGEBASE_ROOT（模块相对，不可配置）
├── skill.md                       ← 第一层索引表：`- <领域>：<描述>`
└── <领域>/                        ← 领域目录（目录名 = 英文领域名）
    └── <条目>/                    ← 条目目录（CJK 允许）
        ├── skill.md               ← 条目：YAML frontmatter + 知识正文
        └── resources/             ← 可选：可查看资源（png/svg/md/csv/pdf…）
```

规则：

- **领域**：`KNOWLEDGEBASE_ROOT` 的直接子目录；忽略 `.` 开头目录、普通文件与根级 `resources/`。
- **条目**：领域目录下含 `skill.md` 的直接子目录；更深层级或缺少 `skill.md` 的目录不识别。
- **条目 id**：`"<领域目录名>/<条目目录名>"`，与相对路径一一对应（如 `Bioinformatics/pysam`）。
- **条目文件**：固定为小写 `skill.md`；移进其它名字的文件不会被识别。
- **frontmatter**：只读 `name` 与 `description`，其余键静默忽略。与 Skill 不同，`name` **允许中文**（不做 kebab-case 限制），上限 120 字符；`description` 必须非空。
- **正文**：frontmatter 结束分隔线之后的全部内容，trim 后返回。
- **资源**：`resources/**` 递归列出；文本类（md/txt/json/csv/tsv/yaml/html/svg/xml/toml/log）≤2 000 字符内联返回，单次 `read` 内联总量 ≤4 000 字符；二进制只返回 `path/mimeType/size/encoding:"binary"`。可执行扩展名（`.py/.sh/.js/.mjs/.ts/.ps1/.exe/.bat/.cmd/.ipynb/.r` 等）返回 `executable_resource` warning——它们**不会被执行**，也不应该存在于知识库。
- `KNOWLEDGEBASE_ROOT` 定义在 `backend/src/paths.ts`：`path.join(AGENT_CLIENT_ROOT, 'knowledgebase')`，与 `skills/` 平级、模块相对、无环境变量覆盖。

## 三、第一层索引表（`knowledgebase/skill.md`）

```markdown
# 知识库领域索引

- General Science：Research methods, statistical inference, experimental design, and research data practices independent of any specific discipline.
- Bioinformatics：Knowledge of sequencing technologies and omics data formats, workflows, databases, and analysis decisions.
```

解析规则（`readDomainIndex`）：

- 只匹配 `- <领域>：<描述>` / `- <领域>: <描述>` 形式的行；标题、空行与其他行忽略。
- 领域是否存在**以磁盘目录为准**：磁盘有而索引缺 → 领域仍可用，`description` 为空并返回 `unlisted_domain` warning；索引有而磁盘无 → 丢弃并返回 `unknown_domain` warning。
- 索引文件缺失 → 所有领域描述为空 + `missing_index` warning；重复行 → 首行为准 + `duplicate_index_domain` warning。
- 领域顺序 = 索引表顺序；索引未列出的领域按目录名排序追加。
- 索引表只承载领域描述，不承载领域内条目清单；条目清单一律实时扫描。

## 四、加载协议（`knowledgebase` CoreTool）

工具 schema 是静态的（不依赖运行时目录），description 内写明 `select` 与手动浏览两条路径；系统提示片段按角色的选择权渲染：委托 biod 时是「Knowledge Base is enabled」的 select 用法，未委托时是自行 `index` → `catalog` → `read` 的用法。

| action | 参数 | 返回（JSON 字符串） |
| --- | --- | --- |
| `select`（缺省） | 可选 `domain` | biod 按 τ 多选后**只返回被选中的条目正文**：`{ ok, action:"select", entries:[{id,name,description,content,resources}], decision:{…}, warnings:[] }` |
| `index` | — | `{ ok, action:"index", domains:[{name, description, entries}], warnings:[] }`（只含至少一条已选条目的领域，`entries` 为已选条目数） |
| `catalog` | `domain`；可选 `offset`（默认 0）、`limit`（默认 100，上限 200） | `{ ok, action:"catalog", domain, entries:[{id, name, description}], total, offset, limit, has_more, warnings:[] }`（`entries` 只含已选条目，`total` 为已选条目数） |
| `read` | `entry`（完整 id），或 `domain` + `entry`（条目目录名） | `{ ok, action:"read", id, name, description, content, resources:[...], warnings:[] }` |

- `select` 是首选路径：候选 = Agent 已勾选的条目（或其中一个 domain 的子集），biod `sigmoid ≥ tau` 的 topK；正文合计受 30,000 字符预算约束，超出截断并带 `truncated` warning。
- **选择权按角色绑定**：`knowledgebase` 始终注入角色上下文；角色在 `coreToolIds` 里绑定它才调用 biod，未绑定时 `select` 直接回落 `index`/`catalog` 并追加 `biod={status:"off",reason:"not_configured"}`，由模型自行读条目。`action` 可省略，缺省即 `select`。
- 空集/失败 → 回落 `index`/`catalog` 并追加 `biod` 元数据；`index/catalog/read` 行为不变。详见 `docs/biod-integration.md`。

- 失败一律 `{ ok: false, error }`；错误文案引导模型回上一步（未知 domain → 用 `index`；未知 entry → 用 `catalog`；未勾选领域/条目 → `is not enabled for this agent`）。
- `catalog` 按 `name` 的 Unicode 码点升序排序（稳定、与 locale 无关），`id` 作为并列时的次级排序键。
- `read` 的 `resources` 元素字段：`path`（相对知识库根）、`mimeType`、`size`、`encoding`（`utf8` / `binary`），文本内联时带 `content`，超大时带 `truncated` 与 `note`。
- id 安全：只接受两段式相对路径；包含 `..`、绝对路径、多段路径一律拒绝；命中扫描结果后才拼路径，并有 `assertInside` 兜底。

### 4.1 设置页只读接口（2026-11-05）

设置页的 Knowledgebase 视图由两条只读数据源驱动，不写磁盘，也不经过 Agent 条目绑定过滤：

- `GET /api/settings` 的 `knowledgeBase`：完整领域/条目树 `{ domains: [{name, description, entries: [{id, name, description}]}], warnings }`，与 Agent 配置页勾选共用同一投影（`buildKnowledgeBaseConfigCatalog`）。
- `GET /api/knowledgebase/entry?id=<domain>/<entry>`：单条正文与资源清单，响应 `{ ok: true, entry: { id, name, description, content, resources: [{path, mimeType, size, encoding}], warnings } }`；`invalid_id` → 400、`malformed` → 422、`not_found` → 404。
- 与 runtime `read` 的差异：**不做 Agent 条目过滤**（展示全量）、**不做 30 000 字符截断**（内容契约已限正文 ≤28 000）、资源只返回元数据，不回传 `content`。
- 实现：`knowledgebase_executor.ts` 的 `readKnowledgeBaseEntryForView()`、`backend/src/http/routes/knowledgebase.ts`、`web/src/components/settings/KnowledgebaseSettings.jsx`；测试 `backend/test/knowledgebase_view.test.ts`。

## 五、上下文与预算

- `index` 结果只含**至少一条已选条目的领域**的领域名、描述与已选条目数，不含条目清单；一条条目都没勾选时返回 `domains: []` 与 `note`。
- 观测层内联上限：`knowledgebase` 为 **30,000 字符**（`observation_manager.ts` 的 `KNOWLEDGEBASE_INLINE_RESULT_CHARS`，按工具名解析），因此正常大小的领域目录与单条知识会原样进入上下文；超过 30,000 字符才降级为「摘要 + 前 6,000 字符 + 落盘路径」。
- `catalog` 页大小：在 `limit`（默认 100、上限 200）之外再按 **30,000 字符预算**自动填充，保证目录不会被观测层截断；`has_more` 提示可继续翻页。
- 单条 description 建议 ≤700 字符（>700 warning）；当前迁移进来的工具文档描述在 154–650 字符之间。
- 单条正文软上限 **28,000 字符**（>上限返回 `body_exceeds_budget` warning，不截断）。超过 30,000 字符的工具结果会被观测层截断；长文档应拆成多条，或把大段资料放进 `resources/`。
- 条目数量多时，`index` 的 `entries` 计数需要逐领域 `readdir`；当前实现每次调用都重新扫描（见缺口）。

## 六、校验与诊断

- 条目校验在读取时进行：frontmatter 必须是 YAML mapping、`name`/`description` 非空、正文非空；坏条目在 `catalog` 中被跳过并返回 `malformed_entry` warning，在 `read` 中直接返回 `{ok:false}`。
- warning 上限 20 条，超出时追加 `N more warnings omitted.`。
- 回归测试 `backend/test/knowledgebase_content.test.ts` 锁定仓库内容：索引覆盖所有领域、无 `unlisted_domain`/`unknown_domain`、条目名/描述非空且唯一、正文 ≤28 000 字符、无索引分页溢出、无执行脚本资源、至少一条带 `resources/`。
- 执行器单测 `backend/test/knowledgebase_executor.test.ts` 用临时目录覆盖索引/目录/资源/分页/错误分支。

## 七、与现有机制的关系

2026-10-20 的迁移把 20 个无脚本、非 CLI 的 `生信分析/*` 条目搬进知识库（`生物信息学` 14 条、`科研平台与数据集成` 6 条），并从 `skills/` 与 `agents.json` 移除；其它 36 个 Skill（13 默认 + 23 `生信分析/*`）保持原状。

| 维度 | Skill（`toollibrary` / `toolload`） | Knowledge Base（`knowledgebase`） |
| --- | --- | --- |
| 内容 | 能力说明书，可指向 CLI / 工具 | 纯知识：事实、流程、决策依据 |
| 执行面 | 资源可含脚本，Skill 本身是文本 | 无执行面，资源仅展示 |
| 存储 | `agent-client/skills/**`，绑定 `agents.json` 的 `skillIds` | `agent-client/knowledgebase/**`，按 `agents.json` 的 `knowledgeEntryIds` 逐条绑定 |
| 目录披露 | 在 `agent-client/toollibrary/` 的两层索引里浏览（L1 常驻 system prompt，L2 按需 `toollibrary`） | 领域索引**按需**由 `index` 加载，工具 description 不内嵌 |
| 加载器 | `toollibrary`（浏览）+ `toolload`（加载） | `knowledgebase`（3 action） |
| 修改方式 | Web 设置页 / REST / zip 导入 / git | git（无写入口；设置页仅只读浏览） |

## 八、已知缺口

1. **无写入口 / 无 Web 管理面**：v1 靠 git 与手写维护；没有创建、重命名、删除、导入接口。
2. **无缓存 / watcher**：每次调用重新扫描磁盘；知识条目成百上千后仍有毫秒级开销，但目录极大时应加缓存。
3. **无全文搜索**：只有两层浏览；若模型不知道关键词对应哪个领域/条目，可能漏检。后续可考虑在 `catalog` 上加描述搜索。
4. **>30,000 字符的条目仍会截断**：观测层对 `knowledgebase` 的内联上限是 30,000 字符；超长正文只会返回 warning 并退化为 observation 文件，没有正文分页/续读 action。
5. **资源仍只展示元数据**：设置页列出 `path` / `mimeType` / `size`，但二进制内容不渲染、不提供下载；图片预览等仍是缺口。
6. **索引与磁盘可能漂移**：已用 warning + 内容测试缓解，但没有强制校验命令或 CI 门禁。
7. **条目列表是显式快照**：保存时写入的是当时的条目 id；之后新增的条目不会被已保存的 Agent 自动收录，需要在设置页重新勾选。这是与 CoreTool 显式列表一致的取舍。
8. **剩余 24 个工具型 skill 未迁移**：它们都携带 `resources/` 执行脚本（按迁移规则排除在知识库之外）；另有 12 个 CLI skill 与 `skill-creator` 同样不迁。这 24 个 skill 已于 2026-11-05 从 `skills/bioinformatics/` 上移到 `skills/` 根目录，id 变为裸 slug。迁移规则与清单见 DevLog `refactor-migrate-doc-only-skills-into-knowledgebase/archive.md`。

## 九、一手来源索引

| 主题 | 位置 |
| --- | --- |
| 知识库根常量 | `agent-client/backend/src/paths.ts`（`KNOWLEDGEBASE_ROOT`） |
| 工具名常量 | `agent-client/backend/src/agent/core_tools/ids.ts`（`KNOWLEDGEBASE_TOOL_NAME`） |
| 扫描 / 索引 / 解析 / 资源 / 读取 | `agent-client/backend/src/agent/core_tools/knowledgebase_executor.ts` |
| schema、注册表条目、执行分支 | `agent-client/backend/src/agent/core_tools_runtime.ts` |
| Agent 绑定字段与迁移 | `agent-client/backend/src/agent/config/agent_config_store.ts`（`knowledgeEntryIds`） |
| 条目过滤入口 | `agent-client/backend/src/agent/runtime_tool_dispatcher.ts`（`executeKnowledgeBase`） |
| 设置页条目展示 / 绑定 | `agent-client/backend/src/agent/config/agent_capability_catalog.ts`、`web/src/components/settings/CapabilityChecklists.jsx`（绑定）、`KnowledgebaseSettings.jsx`（只读浏览） |
| 执行器测试 | `agent-client/backend/test/knowledgebase_executor.test.ts` |
| 设置页只读接口 | `agent-client/backend/src/http/routes/knowledgebase.ts` |
| 设置页只读读取 | `agent-client/backend/src/agent/core_tools/knowledgebase_executor.ts`（`readKnowledgeBaseEntryForView`） |
| 设置页只读视图 | `agent-client/web/src/components/settings/KnowledgebaseSettings.jsx` |
| 只读接口测试 | `agent-client/backend/test/knowledgebase_view.test.ts` |
| 种子内容契约测试 | `agent-client/backend/test/knowledgebase_content.test.ts` |
| 注册元数据测试 | `agent-client/backend/test/core_tools_runtime.test.ts` |
| 知识库内容 | `agent-client/knowledgebase/**` |
| 作者指引 | [`development.md`](development.md) 的「新增知识库条目」 |
