# Skill 机制

> 基线：`e66665e`（`refactor: migrate doc-only skills into the skillbook`）
> 范围：`agent-client/skills/`（51 个 `SKILL.md`）、`agent-client/backend/src/agent/config/skill_config_store.ts`、`agent-client/backend/src/agent/service/agent_context_resolver.ts` 的绑定解析、`agent-client/backend/src/agent/runtime_tool_dispatcher.ts` 的 `toolload` 分支，以及 `http/routes/{settings,config_manage,config_files}.ts` 与 `web/src/components/settings/` 的管理面。
> 本文描述**当前实现事实**，用于新增 / 绑定 / 调试 Skill 前的第一事实来源核对；文中标注了已知设计缺口。
> 知识库（Knowledge Base）是独立机制，不是 Skill：它由 CoreTool `knowledgebase` + `agent-client/knowledgebase/` 构成，见 [`knowledgebase-mechanism.md`](knowledgebase-mechanism.md)。
> `toollibrary` / `toolload` 的注册表条目、风险分级与执行入口属于 CoreTool 职责，见 [`core-tools.md`](core-tools.md) §5.7 与 [`toollibrary-mechanism.md`](toollibrary-mechanism.md)；结果如何降级进上下文见 [`context-mechanism.md`](context-mechanism.md) §8.1；主循环何时调用它见 [`agent-loop.md`](agent-loop.md) §七。本文按**磁盘契约 → 发现 → 绑定 → 展示层 → 加载 → 写回 → 管理面**补齐其未展开的机制。

> 2026-10-21：`skills/生信分析/` 更名为 `skills/bioinformatics/`，skill id 形如 `bioinformatics/scanpy`；`agents.json` 与 `toollibrary/` 条目已同步，当前仓库的 skill id 与 toollibrary/knowledgebase 条目 id 均为英文。

> 2026-11-05：skill 目录树退役。24 个 `bioinformatics/*` skill 全部上移到 `skills/` 根目录，id 变为裸 slug（`scanpy`、`bio-seq`）；`skill.directory` / `skillpack.md` / 目录管理 API 与 `skillDirectories` 投影一并删除。分类职责只保留在 `toollibrary/`。

## 一、结论速览

- Skill 的本体是**磁盘上的一个目录**，唯一必需文件是 `SKILL.md`。**没有必需的中心配置文件**：`skills.json` 索引可选，只有在它已经存在时才会被写回；它只持久化 `enabled` / `promptId` / `isBuiltin` / `createdAt`。
- **Skill 的可见性由 CoreTool `toollibrary` 的两层索引接管**：`agent-client/toollibrary/index.md` 是领域索引（L1 以 `<tool_library_domains>` 预注入 system prompt），`<领域>/index.md` 列出该领域工具（skill + MCP）的 name/description；Skill 正文**永不预注入**，模型需要时调用 `toolload` 读取。system prompt 保留 L1 领域索引与注册表里的一行用法说明。
- `toollibrary` / `toolload` 的 **schema 在 CoreTool 注册表**（`risk: read_only` → 免审批），**执行在 `RuntimeToolDispatcher`**——因为 `executeCoreTool` 的上下文里没有 `skills`、`mcpToolsByName`、`mcpServers` 与 `addTools`。
- 绑定的唯一匹配方式是 **`skill.id` 精确相等**（`agent_context_resolver.ts:147-152`）；文件系统上已不存在的 id 被**静默丢弃**，不报错、不告警。`toollibrary` 只展示「已启用 ∩ 已绑定」的交集，因此未绑定的 skill 不会出现在目录里。
- **目录树已退役（2026-11-05）**：所有 Skill 平铺在 `agent-client/skills/` 根目录；`skill.directory`、`skillpack.md`、目录管理 API 与 `skillDirectories` 投影均已删除，分类职责由 `toollibrary/` 的领域索引承担。
- 扫描时会把根目录下的 skill 目录**就地重命名为 `slug(name)`**，因此 **`id` 恒等于 `slug(name)`**，也恒等于磁盘目录名。
- 目录名与 frontmatter `name` 不一致不会报错，而是被静默改名；`findSkillDirectory` 只接受根目录下的单段 id，嵌套路径 / 绝对路径一律拒绝。
- 正文经 `toolload` 返回，观测层内联上限是 **70 000 字符**（`toollibrary` 浏览页是 30 000）；超出才落盘为 run 的 Observations 文件。
- 当前 51 个 Skill **全部**被 PI 绑定（21 个默认 + 30 个工具型 skill；其余角色按职责绑定子集），并全部收录在 `agent-client/toollibrary/` 的 8 个领域里。24 个工具型 skill 原先位于 `skills/bioinformatics/` 容器，2026-11-05 已全部上移到 `skills/` 根目录；其中 **20 个无脚本、非 CLI 的文档条目已迁入 `agent-client/knowledgebase/`**（见 [`knowledgebase-mechanism.md`](knowledgebase-mechanism.md)）。

## 二、四个「Skill」定义域

讨论 Skill 时必须先区分四个互不相同的载体，它们的失效模式完全不同：

| # | 载体 | 位置 | 谁写 | 谁读 | 失效表现 |
| --- | --- | --- | --- | --- | --- |
| ① | 磁盘目录 + `SKILL.md` | `agent-client/skills/**` （仓库跟踪，354 个文件） | 人 / 导入 API | `rebuildSkillSnapshot` 扫描 | 目录消失 → skill 消失，绑定变悬空并被静默丢弃 |
| ② | `skills.json` 索引 | `backend/config/skills.json`（**当前不存在**） | `createSkill`/`updateSkill`/`deleteSkill`/`saveIndex` | `loadIndex` | 不存在 → `enabled`/`promptId`/`isBuiltin`/`createdAt` 全都不可持久化 |
| ③ | `agents.json` 绑定 | `backend/config/agents.json` | Web/API `PUT /api/config/manage/agents/:id`、`removeSkillReferences`、`remapSkillReferences` | `resolveAgentSkills` | 出现未知 id → 该 id 无效果但保留在文件里 |
| ④ | 每 run 快照 | 进程内 `AgentChatRequest.skills` | `agent_service.ts:222-232` 从 ①∩③ 投影 | `toollibrary_executor`（浏览/过滤）与 `toolload`（加载） | 只影响本 run，不落盘 |

关键推论：**②不影响 ①**。磁盘扫描是唯一的真相来源；`skills.json` 只是给 ① 附加 `enabled`、`promptId`、`isBuiltin`、`createdAt` 四个运行时属性的附属索引。默认部署下 `backend/config/` 里没有 `skills.json`，所以这四个属性全部取默认值。

## 三、磁盘契约

### 3.1 目录布局与 id 推导

skills 根目录**不可配置**，由模块位置硬编码为 `agent-client/skills`（`paths.ts` 的 `SKILLS_ROOT`）；唯一相关的环境变量是 `BIOFLOW_CONFIG_DIR`，只影响 `skills.json` 的位置。

发现算法是**单层**的：只扫描 `skills/` 的直接子目录，目录内有 `SKILL.md` 即视为 skill；更深的目录一律不识别（`listSkillDirectories`）。

id 就是 `slug(name)`（`skillDirectoryName`），因此 **`id` 恒等于磁盘目录名**：

```ts
function skillDirectoryName(skill: Pick<Skill, 'name'>): string { return slugifyPathSegment(skill.name || 'skill'); }
```

`slugifyPathSegment` 做小写化、把非 `[a-z0-9-]` 字符替换为 `-`、合并连续连字符并截断 64 字符，因此**不保留 CJK**；frontmatter `name` 的校验也强制 1–64 位小写字母/数字/单连字符。

磁盘现状（`find skills -name SKILL.md` 计数）：

| 位置 | 数量 | id | 例子 |
| --- | --- | --- | --- |
| `skills/<id>/` | **45** | `slug(name)` | `scanpy`、`bio-seq`、`science-search` |

旧的 `skills/bioinformatics/<id>/` 两层布局已于 2026-11-05 扁平化：24 个工具型 skill 全部上移到根目录，`bioinformatics/` 容器删除，所有 id 同步去掉前缀。若根目录下出现「不含 `SKILL.md`、但更深层含 `SKILL.md`」的目录，扫描会记一条 `nested_skill` 诊断并跳过（`listNestedSkillDirectories`）。

### 3.2 frontmatter 解析与校验

`parseSkillMarkdown`（`:488-504`）是唯一的解析入口，被扫描、导入、`updateSkill` 共用：

- 先剥 BOM（`:489`），按 `/\r?\n/` 切行；
- 首行必须匹配 `/^---[\t ]*$/`（`:491`），否则抛 `SKILL.md must begin with a YAML frontmatter delimiter (---).`；
- 结束分隔符是第 1 行之后首个匹配 `/^(---|\.\.\.)[\t ]*$/` 的行（`:492`），缺失则抛 `frontmatter is missing its closing delimiter`；
- 用 `parseDocument(..., { prettyErrors: false, strict: true, uniqueKeys: true })` 解析（`:494`），有错抛 `Invalid YAML frontmatter: ...`；顶层必须是 mapping（`:497`）；
- `name` 缺省时回退到**目录名**（`:499`，目录名会先剥掉 `^[0-9a-f]{8}-` 这类历史 uuid 前缀，`:462`）；
- 正文 = 结束分隔符之后所有行 `join('\n').trim()`（`:502`）。

`validateSkillMetadata`（`:506-514`）只校验两个字段：

```ts
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedName) || normalizedName.length > 64) {
  throw new Error('SKILL.md name must be 1-64 lowercase letters, digits, or single hyphens.');
}
if (typeof description !== 'string' || !description.trim()) throw new Error('SKILL.md frontmatter requires a non-empty description.');
```

要点：

- **只读 `name` 和 `description` 两个键**，其余 frontmatter 键被静默忽略（无白名单、无 reject）。`allowed-tools`、`license`、`version` 一类字段在 `Skill` 接口（`:17-30`）里也不存在。
- `name` 必须是小写字母/数字/单连字符，**上限 64**（磁盘目录名另有 64 截断，`:464`）。
- **不校验 `name` 与目录名一致**：反过来，扫描时会按 `slug(name)` 把目录改名（`:237-243`）。
- 51 个现有文件的 frontmatter 只有 `name`/`description` 两键，`name` 与目录名 100% 相等；引号写法混用——21 个文件不加引号（14 个顶层 `bio-*`/`science-search`、`pharmgx-reporter` 与 6 个研究法 skill），其余 24 个（`skill-creator` 与 23 个工具型 skill）用双引号（`scanpy/SKILL.md:2`）。

### 3.3 `resources/` 与静态资源

每个 skill 可带 `<skillDir>/resources/**`，递归读取（`:398-404`）：

```ts
return { id: uuidv4(), fileName: path.relative(resourcesDir, filePath).replace(/\\/g, '/'), mimeType: guessMimeType(filePath, text), size: buffer.byteLength, content: text ? buffer.toString('utf8') : buffer.toString('base64'), encoding: text ? 'utf8' : 'base64' };
```

- 文本判定 = 扩展名白名单（`md|txt|json|js|mjs|ts|tsx|jsx|py|sh|ps1|yaml|yml|toml|xml|html|css|csv|tsv`）**或**「不含 NUL 字节」（`:467`）；非文本按 base64 存。
- 资源**随 skill 一起被扫描进内存**（不是按需读盘），并在 `toolload` 加载正文时随结果一起返回。
- 仓库内实例：`skills/skill-creator/resources/scripts/*.py`、`skills/scanpy/resources/references/standard_workflow.md`、`skills/bioimage-analysis/resources/scripts/segment_cells.py`。21 个默认/研究法 skill 中只有 `skill-creator` 带 `resources/`；14 个 `bio-*` 与 `science-search` 只有单个 `SKILL.md`（`find agent-client/skills -name resources` 命中 `skill-creator` 与 23 个工具型 skill）。
- **没有**「按需读取某个资源文件」的工具（grep `core_tools_runtime.ts`、`core_tools/`、`runtime_tool_dispatcher.ts` 无命中），资源只能整包随正文拉取。

### 3.4 扫描、诊断与缓存

`rebuildSkillSnapshot` 是发现主流程，逐条：

1. `listSkillDirectories(ensureSkillsRoot())` 只取根目录下含 `SKILL.md` 的直接子目录。
2. 识别历史 uuid 前缀目录名（`/^([0-9a-f]{8})-/i`），用于兼容旧 id。
3. 查 `.deleted-skills.json` 标记，命中则跳过。
4. `parseSkillMarkdown` 失败 → `recordSkillDiagnostic` 后 `continue`，**该 skill 被跳过而不是整个扫描失败**。
5. **根目录内改名对齐**：

```ts
const target = path.join(root, skillDirectoryName(parsed));
if (path.resolve(skillDir) !== path.resolve(target)) {
  if (fs.existsSync(target)) throw new Error(`Skill target directory already exists: ${target}`);
  fs.renameSync(skillDir, target);
}
```

6. 算出 `id = slug(name)`，与旧 id 不同则记入 `migratedIds`，最后统一回写 `agents.json`（`migrateAgentSkillReferences` → `remapSkillReferences`）。
7. 若索引文件已存在且内容变化，写回 `skills.json`。
8. 旧两层布局残留（根目录某个不含 `SKILL.md` 的目录内部仍有 `SKILL.md`）会记 `nested_skill` 诊断，不再被识别为 skill。
9. **排序**：`skills.sort((left, right) => right.createdAt.localeCompare(left.createdAt))`，即 createdAt 倒序。

缓存与失效：

- 单快照 + 惰性构建，任何写操作后 `invalidateSkillCache()` 置空。
- 外部改动靠 `fs.watch` 监听 skills 根及**全部子目录**（`resources/` 也需要），经 **150 ms 防抖** 后全量重建。
- **无 TTL、无 mtime/stat 校验、无缓存 key**；重建抛错时保留旧快照与旧诊断，只打一条 `console.warn`。
- 诊断经 `getSkillDiagnostics()` 暴露，路径相对 skills 根，并出现在 `GET /api/settings` 的 `skillDiagnostics` 与 Web 的只读 Tool Library 页。

## 四、绑定：`agents.json` → 每 run 快照

`AgentProfile.skillIds: string[]`（`agent_config_store.ts:37`）是唯一的绑定字段。装配时取**交集**：

```ts
private resolveAgentSkills(agent: AgentProfile | undefined): Skill[] {
  if (!agent?.skillIds.length) return [];
  const skills = skillConfigStore.getEnabledSkills();          // :143
  const allowed = new Set(agent.skillIds);                     // :144
  return skills.filter((skill) => allowed.has(skill.id));      // :145
}
```

推论：

- 匹配**只有** `id` 精确相等一种方式。`config/README.md:44` 声称可用「a skill id, an 8-character id prefix, or the skill `name`」，其中**前缀与 name 两条在当前代码里不成立**（前缀只出现在 `knownIdForPrefix` 的历史迁移路径里，`:336-345`，且是从 `agents.json` 反查 id，不是名字解析）——这是文档与实现的已知不一致（缺口 2）。
- 悬空 id（文件系统上已删）**静默丢弃**，无异常、无日志（缺口见 §十）。
- 传入顺序不被尊重：结果顺序继承 `getEnabledSkills()` 的 createdAt 倒序（`:260`）；`skillIds` 自身只做去重，用 `[...new Set(...)]` 保序（`agent_config_store.ts:219`）。
- 只有 `enabled !== false` 的 skill 参与（`skill_config_store.ts:362`，缺省 true）。默认部署无 `skills.json` → 全部 enabled。

投影到运行时请求（`agent_service.ts:222-232`）只保留六个字段：

```ts
skills: context.skills.map((skill) => ({ id, name, description, instructions, resources })),
```

类型定义在 `types.ts` 的 `SkillContext`。请求对象不再携带 `directory`：目录概念已删除，id 即 slug(name)。**正文（`instructions`）在这里就已经进了请求对象**，只是还没进 prompt——这是「不预注入正文」与「正文随请求随身携带」的差别：是否出现在上下文由 §五的 `toollibrary` 展示层决定，`toolload` 只是把它从请求对象里取出来返回。

## 五、可见性：由 `toollibrary` 展示层决定

默认目录 / 命名目录的两级暴露模型已经退役。运行期不再把任何 Skill 目录渲染进 system prompt 或工具描述；模型看到的 Skill 名称与描述来自 `agent-client/toollibrary/` 的两层索引，正文由 `toolload` 按需加载（完整机制见 [`toollibrary-mechanism.md`](toollibrary-mechanism.md)）。

### 5.1 目录树已退役（2026-11-05）

- 所有 skill 平铺在 `agent-client/skills/` 根目录，`id = slug(name)`，`Skill` 类型不再有 `directory` 字段。
- 目录管理面（建 / 改 / 删命名目录、`skills/move`、`skillpack.md`、`GET /api/settings` 的 `skillDirectories`）已整体删除。
- 导入 zip / 文件列表的 API 保留，但固定导入到根目录，不再接受目标目录参数。
- 分类职责完全交给 `agent-client/toollibrary/` 的领域索引；未收录的绑定 skill 进入兜底领域 `Unclassified`。
- `resolveAgentSkills` 仍是唯一绑定入口（见 §四）；`toollibrary` 只展示这个交集，因此未绑定的 skill 不会出现在目录里。

### 5.2 `agent-client/toollibrary/` 展示层

```text
agent-client/toollibrary/
├── index.md                 # L1：`- <领域>：<描述>`
└── <领域>/index.md          # L2：`- <name>（skill：<skill-id>）：<description>`
```

- L1 领域索引由 system prompt 的 `<tool_library_domains>` 段预注入；`toollibrary(domain)` 返回该领域的工具目录（skill 与 MCP 混排，按 name 排序，可按 `offset`/`limit` 分页）。无参 `toollibrary()` 仅为 fallback（运行时索引，含 `Unclassified`）。
- 条目里的 `skill：<id>` 必须被当前 agent 绑定且已启用才会显示；列了但不可见的条目被隐藏并返回 `unknown_tool` warning。
- 反过来，已绑定但没写进任何领域文件的 skill 会在运行时进入兜底领域 `Unclassified` 并返回 `unlisted_tool` warning——**配置是存在性权威，索引文件是展示层**。
- 当前 51 个 Skill 分布在 8 个领域里；域归属与展示描述由人维护，改 `agents.json` 后即使来不及同步索引，能力也不会消失。

### 5.3 装配与数据通路

- `agent_service.ts` 把绑定交集投影进 `AgentChatRequest.skills`（正文 `instructions` 与 `resources` 随请求携带，但不进 prompt）。
- `RuntimeToolDispatcher` 把 `request.skills`、`mcpToolsByName`、`mcpServers`、`addTools` 交给 `toollibrary_executor.ts`：浏览只做展示层解析与过滤，`toolload` 才真正返回正文或登记 MCP schema。
- system prompt 里除注册表 `prompt` 的一行用法说明外，还有 L1 领域索引段（`<tool_library_domains>`）；Skill 的 L2 目录与正文不在 prompt 里，没有第二份副本。

## 六、加载：`toolload` 契约

Skill 正文不再由 `load_skill` 返回，而是由 `toolload`（与 `toollibrary` 同属一个 CoreTool 定义）按 id 装载。完整协议见 [`toollibrary-mechanism.md`](toollibrary-mechanism.md) §四，这里只记录与 Skill 相关的行为。

### 6.1 id 从哪里来

- 模型从 system prompt 的 `<tool_library_domains>` 选域，调用 `toollibrary(domain)` 拿该领域目录；条目的 `id` 就是 skill id（如 `scanpy`）。
- `toolload` 的 `id` 匹配顺序：精确 id → 归一化 name 精确匹配 → 唯一子串匹配；歧义直接失败并提示使用目录里的精确 id。
- 执行期不触碰文件系统：id 只与请求里的内存快照比较；越界防护仍在扫描期（`findSkillDirectory` 只接受根目录下的单段 id，见 §三）。

### 6.2 返回

```jsonc
{ "ok": true, "action": "skill", "skillId": "scanpy", "skillName": "scanpy", "content": "..." }
```

`content` 由 `formatLoadedSkill` 重新拼装（`## Skill: <name>` + `buildSkillMarkdown(skill)` + 资源清单），资源在此层截断：文本资源单条 ≤4 000 字符，base64 只报体积。失败统一 `{ ok: false, error }`。

### 6.3 预算与 loadedCapability

- 观测层内联预算：`toollibrary` **30 000**、`toolload` **70 000** 字符（`observation_manager.ts` 的 `INLINE_RESULT_CHARS_BY_TOOL`）；`toolload` 的 skill 正文通常整篇内联，资源正文另有 8 000 字符共享预算。旧的 `load_skill` 6 000 字符上限不再适用于正文。
- `agent_runtime.ts` 的 `getLoadedCapability` 识别 `toolload` 结果：`action="skill"` → `{kind:'skill', id:skillId}`，用于 run 记录的 `loadedSkills`、compaction 的 `loadedCapabilitiesRemovedFromContext` 与 transcript 回放。
- 审批行为不变：注册条目的 `risk` 是 `read_only`，加载 skill / 登记 MCP schema / 读 MCP 资源都不触发审批；需要审批的是 MCP 工具的**执行**。

## 七、写回、改名与删除标记

`skill_config_store.ts` 不只是读取器，它同时是 Skill 的**写入口**（Web 的导入/移动/删除都落在这里）。

### 7.1 索引写回是「可选」的

```ts
function hasSkillIndex(): boolean {
  const configDir = path.resolve(process.env.BIOFLOW_CONFIG_DIR || path.join(PROJECT_ROOT, 'backend', 'config'));
  return fs.existsSync(path.join(configDir, SKILL_INDEX_FILE));   // :306-309
}
```

所有自动写回都被 `hasSkillIndex()` 门控（`:252`、`:282`）。当前 `backend/config/` 下没有 `skills.json`，因此：

- 扫描不会创建它，也不会把 `enabled`/`createdAt` 等固化下来；
- `sort` 用的 `createdAt` 退化为「每次扫描的 `new Date()`」（`:359`、`:364`），排序结果在无索引时不稳定（缺口 10）。

### 7.2 改名与 id 迁移

`updateSkill`（`:87-111`）在 id 变化时先写目录、再重建索引项，最后把旧 id 迁移到新 id：

```ts
writeSkillDirectory(next, findSkillDirectory(existing.id));   // :102
...
migrateAgentSkillReferences(new Map([[existing.id, next.id]]));  // :108
```

`migrateAgentSkillReferences` → `remapSkillReferences`（`agent_config_store.ts:154-162`）会扫所有 agent，把 `skillIds` 里的旧 id 替换成新 id 并回写 `agents.json`。扫描期的自动改名（§3.4 第 5 步）走同一条路。这是「id 恒等于磁盘目录名」得以维持的原因，也是 `config/README.md` 里「8 字符前缀」这句话的历史来源。

写盘一律走 `writeConfig`（`file_config.ts:2`）的临时文件 + `renameSync` 原子替换。

### 7.3 `.deleted-skills.json`

删除时不只删目录，还会落一个标记，防止被再次扫描复活：

```ts
function rememberDeletedSkill(id: string): void { ... }
function isDeletedSkill(folder: string, id: string | undefined, markers: DeletedSkillMarkers): boolean { ... }
```

标记文件是 `skills/.deleted-skills.json`，被 git 跟踪；当前文件是旧版格式（`ids` + `directories`），新代码只读取 `ids`，`directories` 字段是历史残留。它同时是 uuid 前缀兼容路径的兜底，用于阻止旧 id 复活。

### 7.4 导入

| 入口 | 行为 |
| --- | --- |
| `importSkillsFromZip(fileName, base64)` | 落临时目录 → `unzip` / PowerShell `Expand-Archive` → 递归导入到 skills 根 |
| `importSkillsFromDirectoryFiles(files)` | 按 `path` 写临时目录 → 递归导入到 skills 根 |

两者都收敛到 `importSkillsFromDirectoryTree`：找出所有名为 `skill.md` 的文件（大小写不敏感），逐个 `parseSkillMarkdown` + `createSkill`，**单个失败只记诊断**，全部失败才抛 `No valid skills were imported.`。导入的 skill 不带 `resources/` 时，目录内其余文件也会被当作资源收进去。导入没有目标目录参数；`safeRelativeResourcePath` 会拒绝含 `..` 的条目。

## 八、管理面：HTTP 与 Web

路由挂载在 `/api`（`http/server.ts:31-35`）。**Skill 没有独立的 list GET**——列表随 `GET /api/settings` 一起返回。

| 方法 | 路径 | 作用 | 位置 |
| --- | --- | --- | --- |
| GET | `/api/settings` | 返回 `skills`（摘要：id/name/description/enabled/promptId/isBuiltin/时间戳）与 `skillDiagnostics` | `settings.ts` |
| PUT | `/api/config/manage/agents/:id` | 改绑定；body 白名单含 `skillIds` | `config_manage.ts:29`、`:201` |
| POST | `/api/config/manage/skills/import-zip` | 导入 zip | `:104-108` |
| DELETE | `/api/config/manage/skills/:id` | 删 skill **并清理绑定** | `:162-170` |
| POST | `/api/config/manage/skills/import-files` | 按文件列表导入 | `:176-181` |
| GET | `/api/config/files/skills/*` | 读任意 `SKILL.md`/资源原文 | `config_files.ts:28-44` |

要点：

- **`/api/settings` 只返回摘要，不含 `instructions`**（`settings.ts:120-130`）。但正文并非拿不到：`config_files.ts:11-14` 把 `skills` 根映射到 `PROJECT_ROOT/skills`，`GET /api/config/files/skills/<dir>/SKILL.md` 直接 `readFileSync` 返回原文（`:40-44`）。
- 全部写操作都以 `respondWithSettings` 收尾，即返回 `{ ok, reload, settings, ...payload }`（`config_manage.ts:187-197`）。
- 写回 `agents.json` 的唯一校验是 `unique()`：`[...new Set(value.map(String).filter(Boolean))]`（`agent_config_store.ts:219`）——**不校验 id 是否真实存在**。
- 删除 skill 走两段：`deleteSkill` 删目录，`removeManagedSkillReferences` → `removeReference('skillIds', id)` 清绑定（`:164-169`、`agent_config_store.ts:150-152`、`:228-238`）。
- 并发：`agents.json` 与 `skills/` 的跨文件一致性**没有事务**，只有进程级的 workspace 单实例锁（`server.ts:27`），注释范围是会话存储（缺口见 §十）。

Web 侧（React 壳，纯 `.jsx`/`.js`，无 TS、无 skill 相关测试）：

| 位置 | 作用 |
| --- | --- |
| `web/src/constants.js` | 设置页签：`['library','Tool Library']`、`['knowledgebase','Knowledgebase']`（原 Skill 配置页已移除） |
| `web/src/components/settings/ToolLibrarySettings.jsx` | 只读展示完整策展目录：领域 / 条目 / kind / 可用与启用状态 / 所属 MCP server；无写操作 |
| `web/src/components/settings/AgentSettings.jsx` | 03「指令与能力」区按顺序渲染 CoreTool / ToolLibrary / KnowledgeBase |
| `web/src/components/settings/CapabilityChecklists.jsx` | `ToolLibraryChecklist` 按工具库领域分组勾选 `draft.skillIds`（技能条目）与 `draft.mcpServerIds`（MCP 服务器条目） |
| `web/src/components/settings/fields.jsx` | `agentDraft` 初始化 `skillIds` / `coreToolIds` / `knowledgeEntryIds` / `mcpServerIds` |

必须注意：UI **只展示** `enabled`（`已启用`/`已停用`），**没有任何接口或控件能切换它**（`config_manage.ts` 里没有 `PUT /skills/:id`），所以 `enabled` 目前是一个只读的展示字段（缺口 8）。

## 九、测试覆盖

| 测试 | 覆盖 |
| --- | --- |
| `backend/test/default_clitool_skills.test.ts` | 7 个 CLI skill 的「磁盘存在 + 绑定到 main」两条断言（`:22-23`） |
| `backend/test/toollibrary_executor.test.ts` | 展示层解析、可见性过滤、兜底领域、分页/字符预算、skill 与 MCP id 解析、坏条目/warning 上限 |
| `backend/test/toollibrary_content.test.ts` | 仓库内容契约：领域覆盖、绑定 skill 恰列一次、MCP 条目与前缀、name/description 预算 |
| `backend/test/runtime_tool_dispatcher.test.ts` | `toolload` 的 skill 正文、MCP schema 装载、资源列清单/读取/失败/URI 无人暴露、参数互斥 |
| `backend/test/core_tools_runtime.test.ts` | `toollibrary` / `toolload` 的注册表元数据、schema 参数与 prompt |

```ts
assert.equal(fs.existsSync(path.join(CLIENT_ROOT, 'skills', skillId, 'SKILL.md')), true, `${skillId} must be installed in the default skills directory`);
assert.equal(bindings.has(skillId), true, `${skillId} must be bound to the lead role`);
```

未覆盖：`parseSkillMarkdown`、导入 / 删除、`skills.json` 索引（grep 这些符号在 `backend/test/` 下无命中）；展示层与配置一致性的强制校验仍只有内容契约测试，没有 CI 门禁（见 §十 第 9 条）。并且 `clitool/` 下有 12 个 CLI 目录，`default_clitool_skills` 只断言其中 7 个，`bio-epiedit`/`bio-grn`/`bio-multiome`/`bio-peak`/`bio-regulatory` 不在断言内。扁平化后 `default_clitool_skills` 的 `skills/<id>/SKILL.md` 断言天然成立。

## 十、已知缺口

1. **展示层会漂移（当前影响最大）**。`toollibrary/` 由人维护，Web/API 新增或绑定的 skill 不会自动写入领域文件；未收录的会进入兜底领域 `Unclassified` 并返回 `unlisted_tool` warning，能力不会丢失，但展示描述会滞后。
2. **`config/README.md` 与实现不符**。文档称绑定可用「skill id / 8 字符前缀 / skill name」，实际 `resolveAgentSkills` 只做 id 精确相等；前缀只存在于历史迁移路径，name 匹配不存在。文档或实现需二选一。
3. **目录归属只存在于展示层**。`agents.json` 只绑定 skill id，没有「领域」字段；领域归属完全由 `toollibrary/<领域>/index.md` 决定，因此同一 skill 无法按 agent 呈现不同领域。
4. **超长正文仍会降级**。`formatLoadedSkill` 不截断 SKILL.md 正文，但 `toolload` 结果的观测层内联上限是 70 000 字符（正文 + 8 000 字符资源）；继续增大的 SKILL.md 会退化为「摘要 + 前 6 000 字符 + 落盘路径」。
5. **单个坏 skill 会阻断整轮发现**。目录改名目标已存在时 `throw`，被 `refreshSkillSnapshot` 捕获后**保留旧快照**，于是本轮所有新增/改名 skill 全部不可见，只有一条 `console.warn`。同理，若 `skills.json` 存在且写入失败，索引与磁盘会静默分叉。
6. **缓存无 TTL / 无 mtime 校验**。只依赖 `fs.watch`，watch 失败仅 warn；容器/网络盘等 watch 不可靠的环境下，外部改动可能长期不生效。
7. **管理面缩小（2026-11-05）**。目录树移除后，Web 不再提供 skill 导入/删除入口（Tool Library 只读）；新增/导入 skill 需直接改 `skills/` 或调用 `import-zip` / `import-files` API，删除走 `DELETE /skills/:id`。导入固定落根目录，嵌套 skill 只产生 `nested_skill` 诊断。
8. **`enabled` 是只读展示字段**。无 `PUT /skills/:id`，只读 Tool Library 页只显示「可加载 / 已停用」；默认部署没有 `skills.json`，`enabled`/`promptId`/`isBuiltin`/`createdAt` 四个属性全部不可持久化，`sort` 退化为不稳定顺序。
9. **展示层契约测试不能替代配置校验**。`toollibrary_executor` 与内容契约测试覆盖了当前仓库内容，但新增 skill / MCP 工具仍需人工补领域条目；`clitool/` CLI 数量（12）与 `default_clitool_skills` 断言数量（7）仍不一致。
10. **仓库根的 `skills-lock.json` 是第三方安装器遗留**。它记录 `ui-ux-pro-max`（GitHub 源 + `computedHash`），但全仓无任何代码读写它，且 `agent-client/skills/` 下没有该 skill。它与本文描述的运行时机制**无耦合**，容易与后端自有的 `skills.json` 索引混淆（后者才是本机制的一部分）。
11. **`agents.json` 写入无校验、无锁**。`unique()` 只做字符串化与去重，未知 id 会被照常持久化；删除 skill 与清理绑定是两次独立写盘，中间失败会留下悬空引用。

## 十一、一手来源索引

| 主题 | 位置 |
| --- | --- |
| Skill 类型与公开读写 API | `agent-client/backend/src/agent/config/skill_config_store.ts`（`createSkill` / `updateSkill` / `deleteSkill` / `getEnabledSkills`） |
| 快照构建、诊断、缓存与 watcher | 同上（`rebuildSkillSnapshot` / `recordSkillDiagnostic` / `updateSkillWatchers`） |
| id / slug 与根目录保护 | 同上（`skillDirectoryName` / `slugifyPathSegment` / `findSkillDirectory`） |
| `SKILL.md` 解析与校验 | 同上（`parseSkillMarkdown` / `validateSkillMetadata`） |
| 资源读写与导入 | 同上（`readSkillResourceDirectory` / `importSkillsFromZip` / `importSkillsFromDirectoryFiles`） |
| 删除标记 | 同上（`rememberDeletedSkill`）、`agent-client/skills/.deleted-skills.json` |
| 绑定解析与 prompt 装配 | `agent-client/backend/src/agent/service/agent_context_resolver.ts` |
| 每 run 请求投影 | `agent-client/backend/src/agent/service/agent_service.ts`、`agent/types.ts` |
| 工具路由与 `toolload` | `agent-client/backend/src/agent/runtime_tool_dispatcher.ts` |
| `toollibrary` / `toolload` 注册条目与 schema | `agent-client/backend/src/agent/core_tools_runtime.ts`（注册表）、`agent/core_tools/ids.ts` |
| 展示层扫描、过滤与加载 | `agent-client/backend/src/agent/core_tools/toollibrary_executor.ts`、`runtime_tool_dispatcher.ts` |
| 领域索引内容 | `agent-client/toollibrary/`（8 个领域、51 skill + 63 MCP 工具） |
| 绑定存储与迁移 | `agent-client/backend/src/agent/config/agent_config_store.ts`（`skillIds`、`remapSkillReferences`、`removeReference`） |
| 风险与审批 | `agent-client/backend/src/agent/security_policy.ts`、`core_tools_runtime.ts` |
| 观测降级 | `agent-client/backend/src/agent/observation_manager.ts` |
| 配置原子写 | `agent-client/backend/src/agent/config/file_config.ts` |
| HTTP 契约 | `agent-client/backend/src/http/routes/settings.ts`、`config_manage.ts`、`config_files.ts`、`server.ts` |
| Web 管理面 | `agent-client/web/src/constants.js`、`components/settings/ToolLibrarySettings.jsx`、`AgentSettings.jsx`、`CapabilityChecklists.jsx`、`fields.jsx` |
| 磁盘现状 | `agent-client/skills/`（51 个顶层 `SKILL.md`）、`backend/config/agents.json` |
| 测试 | `agent-client/backend/test/default_clitool_skills.test.ts`、`toollibrary_content.test.ts` |
| 既有文档 | `docs/toollibrary-mechanism.md`、`docs/core-tools.md` §5.7、`docs/context-mechanism.md` §3.3、`docs/agent-loop.md` §七、`agent-client/backend/config/README.md` |
