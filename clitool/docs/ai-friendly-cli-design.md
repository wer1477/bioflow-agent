# 优秀且 AI 友好的 CLI 设计与交付规范

> 读者：实现、修改或评审 `clitool` 中 CLI 的 coding agent 与工程师。
>
> 核心理念：**先做优秀的 CLI，再让它自然地对 AI 友好。** 优秀 CLI 本就应可靠、可发现、可组合、可脚本化；AI 友好是在这些基础上，让 Agent 同样无需猜测参数、解析表格或在非交互环境中等待输入。
>
> 本文是**交付规范**，不是通用 CLI 教程。先读第 1、2、5 节；需要设计理由或反例时再查第 6 节与附录。研究时使用[本地参考实现索引](cli-research-index.md)，并以其中记录的源码和测试为准。

---

## 1. 事实来源与 Agent 的工作顺序

不要把文档当作运行时事实。按以下优先级判断：

1. **运行时命令注册表或 `--describe --format json`**：当前安装版本实际支持的命令、参数、输出字段。
2. **集成测试与 JSON schema / fixtures**：机器输出的兼容性契约。
3. **`<command> --help`**：当前命令的精确签名、默认值与示例。
4. **`SKILL.md`**：任务选择、工作流、风险提示和输出解读。
5. **本文及其他长文档**：设计原则、案例与背景。

**执行路径**：先用注册表或顶层 `--help` 发现命令 → 用子命令 `--help` 核对签名 → 以机器格式执行 → 检查退出码 → 只在失败时阅读 `stderr` 或开启诊断。

这解决了两个常见问题：命令清单随版本变化而文档滞后；以及把 `SKILL.md` 误当成参数真相。OpenCLI 的实践也是运行 `opencli list -f json` 发现实时能力，而不是硬编码文档清单。

---

## 2. 通用 CLI 的接口契约（AI 可靠调用的基础）

本节首先服务于人类用户、shell 脚本和 Unix 管道；对 Agent 的好处来自同一份接口契约。不要为 AI 另造一套削弱可组合性或破坏常规 CLI 习惯的表面。

### 2.1 通道与退出码

- **`stdout` 只输出主结果数据。** 数据可以是 JSON、JSON Lines、TSV、纯文本或二进制；不得混入日志、进度条、提示或 ANSI 控制符。
- **`stderr` 只输出诊断。** 包含错误、警告、进度和调试信息；默认简短，`--verbose` 才附加栈或底层细节。
- **退出码是成功与否的唯一权威信号。** `0` 成功；`2` 表示用法/参数错误；其他非零码按项目定义并在 `help exit-codes` 或文档中列出。不要要求调用方同时检查 `success: false` 才能判断失败。
- 命令失败时不得在 `stdout` 产生半截 JSON 或人类错误页；`stderr` 应包含可操作的下一步。

建议的错误形式：

```text
error[invalid-input]: --format must be one of json, tsv
hint: run 'clitool report --help'
```

错误码应稳定，错误文本可以改善。若上游错误有敏感信息，先脱敏再输出。

### 2.2 机器输出：显式、稳定、节制

- 面向人和机器的通用 CLI，提供 `--format json` 或 `--json`；不要假设终端表格可解析。CLI-Anything 的 agents 均显式传 `--json`，GitHub CLI 也以 `--json <fields>` 提供脚本接口。
- 纯供程序调用的 CLI 可以默认 JSON，但必须在顶层 help 中声明；不要因“AI 友好”而强制所有人类命令默认 JSON。
- 单个对象或有限列表使用 JSON；持续流或大列表使用 **JSON Lines**，每行一个完整对象。不要把无界结果拼成单个巨大数组。
- 为列表提供 `--limit`、游标 / `--page`、字段选择（如 `--fields id,name`）；优先返回摘要和 artifact 路径，而非把大文件、图片或全文内联到响应中。
- JSON 字段名、类型、可空性和枚举值是 API。删除或改变语义属于破坏性变更；新增字段通常可兼容。必要时通过 `schema_version` 管理版本。
- 对需要管道传递的简单记录，TSV 或 NUL 分隔路径可比 JSON 更短、更适合下游工具；格式选择由消费者决定，不把 JSON 当作唯一答案。

成功响应示例：

```json
{
  "schema_version": 1,
  "items": [{"id": "a17", "name": "example"}],
  "next_cursor": null
}
```

### 2.3 非交互、确定性与副作用

- 不得在 stdin 非 TTY 时等待确认、选择菜单、密码或编辑器。缺少必要输入时立即非零退出，并明确说明需要哪个参数、环境变量或配置项。
- 每个交互路径必须有参数化替代：`--yes` / `--force`、`--token`、`--file`、环境变量或配置文件。`--yes` 只跳过确认，不能悄悄改变其他行为。
- 有写入、删除、发布或外部请求的命令应提供 `--dry-run`；其输出应说明计划动作、目标和不会发生副作用的事实。CLI-Anything 的 MacroCLI 采用“先 `info`、再 `--dry-run`、后执行”的流程，值得复用。
- 相同输入应产生稳定的字段语义和排序。无法保证的顺序必须在输出中带序号、时间戳或在 help 中声明。
- 非 TTY、`NO_COLOR` 非空、`TERM=dumb` 时自动禁用颜色、动画和进度条；同时提供 `--no-color` / `--no-progress`。
- 文件参数应支持绝对路径；对标准输入/输出有意义的命令支持 `-`，并避免把二进制或大结果默认刷到终端。
- 对代码或配置的批量改写，先以 search / plan / diff 形式返回命中与拟议改动；真正写入必须是显式的 apply / update 动作。应提供被改文件和未匹配/冲突项的机器可读摘要。ast-grep 的“结构化搜索、lint、rewrite 分层”是合适的参照。

---

## 3. 可发现性：各类文档的职责

| 载体 | 面向的问题 | 必须保持的内容 | 不应承载的内容 |
| --- | --- | --- | --- |
| 运行时注册表 / `--describe --format json` | 此版本现在能做什么？ | 命令、参数、类型、默认值、输出 schema、能力状态 | 工作流长文 |
| `--help` | 这个命令怎样调用？ | 用法、参数、默认值、示例、输出与副作用说明 | 易漂移的跨命令说明 |
| `SKILL.md` | 为完成任务该选哪个命令、按什么顺序？ | 触发条件、选择矩阵、工作流、风险与阅读顺序 | 完整参数表、字段全集 |
| `AGENTS.md` | 在本仓库怎样开发、验证与提交？ | 构建/测试命令、目录、全局约束、生成物规则 | 产品使用手册 |
| 本文 | 为什么要遵守这些规则？ | 契约、设计取舍、案例和来源 | 版本特有命令清单 |

### `--help` 的最低要求

- 顶层、每个命令和子命令均支持 `-h` / `--help`；支持 `clitool help <command>` 更佳。
- 每项参数写明名称、类型、是否必需、默认值、互斥/依赖关系和敏感性；示例必须可复制。
- 帮助开头说明命令用途、输入、输出格式和是否有副作用；危险操作在示例前警示。
- 帮助由参数解析库或声明式命令定义生成，避免手写后与代码脱节。Python `argparse` 可自动生成 usage/help 并呈现默认值；Rust `clap`、Go `cobra` 亦适合此用途。
- 如果命令数量或参数复杂，额外提供 `--describe --format json`。这比要求 agent 从排版文本中反向解析更可靠。

### `SKILL.md` 的最低要求

`description` 必须说明“做什么 + 何时使用”，正文从最短的可执行流程开始。每项工作流只保留：选择什么命令、先后顺序、何时读哪个 `--help`、如何解释输出及副作用。命令和字段的全量细节由运行时注册表与 `--help` 提供。

---

## 4. 新增或修改命令的实现流程

1. **定义边界。** 写一句输入、主结果、失败条件和副作用说明；决定它是查询、转换还是写操作。
2. **设计契约。** 确定退出码、JSON/JSONL schema、列表分页与排序规则。先写 fixture 或 schema，再实现序列化。
3. **定义参数。** 选择稳定的命令名和 flag；为必须的非交互输入提供参数；写操作设计 `--dry-run` 与显式确认策略。
4. **实现输出隔离。** 让主结果只写 stdout，诊断只写 stderr；在非 TTY 下关闭装饰。
5. **生成发现信息。** 从同一命令定义生成 `--help`；如果提供注册表 / describe 输出，一并更新。只在工作流变化时更新 SKILL。
6. **添加契约测试。** 覆盖成功、参数错误、领域错误、非 TTY、分页/空结果和副作用预演。
7. **人工冒烟。** 按第 5 节命令验证；确认示例与真实 help 一致。

不要把“先做一个表格输出，之后再补 JSON”当作可接受的中间态；对 Agent 来说，机器输出就是公开 API。

---

## 5. 合并前验收清单

### 接口

- [ ] `stdout` 只有主数据；日志、进度、错误均在 `stderr`。
- [ ] 成功为退出码 `0`；用法错误、领域错误和系统错误可区分并有文档。
- [ ] 机器格式具有固定 schema；无界数据使用分页或 JSON Lines。
- [ ] 列表结果排序明确；提供合适的 `--limit` / 游标或字段选择。
- [ ] 失败不会向 `stdout` 输出非完整或非契约的 payload。
- [ ] 批量改写先输出命中与预览；写入需显式 apply / update，且返回被改文件、未匹配项与冲突。

### Agent 可执行性

- [ ] 所有必要输入都能通过参数、文件、环境变量或配置提供；非 TTY 不会挂起。
- [ ] 写操作支持 `--dry-run`，并要求明确的确认机制。
- [ ] 支持 `--help`、`--version`；help 反映当前命令签名并有可运行示例。
- [ ] 提供机器可发现的命令描述（注册表或 `--describe --format json`）；SKILL 只保留任务级指导。
- [ ] 非 TTY、`NO_COLOR=1` 与 `TERM=dumb` 不输出颜色、动画或进度条。

### 验证示例

按实际命令替换占位符，并将关键断言写入自动化集成测试：

```bash
# 成功：stdout 可被严格解析，stderr 为空或只含允许的诊断
clitool resource list --format json | jq -e '.items | type == "array"'

# 用法错误：非零退出；stdout 为空；stderr 给出修复办法
clitool resource get >/tmp/stdout 2>/tmp/stderr
test $? -eq 2 && test ! -s /tmp/stdout && rg -q -- '--id' /tmp/stderr

# 管道 / 非 TTY：不能挂起，不能污染机器结果
NO_COLOR=1 clitool resource list --format json | jq -e .

# 有副作用的命令：预演不改状态，并打印计划
clitool resource delete --id a17 --dry-run --format json | jq -e '.planned == true'

# 批量改写：预览不写入；应用后输出变更文件清单
clitool rewrite --rule rule.yml --dry-run --format json | jq -e '.planned == true'
clitool rewrite --rule rule.yml --apply --format json | jq -e '.changed_files | type == "array"'
```

---

## 6. 设计取舍与反模式

AI 友好不是“所有命令都输出 JSON”或“只为模型写文档”。它要求的是：一名人类能预测命令行为、脚本能稳定组合输出、Agent 也能通过同一契约发现并调用它。默认格式、交互体验和文档深度都应按真实用户与任务取舍。

### 什么时候默认 JSON？

| 场景 | 推荐 |
| --- | --- |
| 专供 API / Agent 调用的窄 CLI | 默认 JSON，并在 help 中明确 schema |
| 人机共用的通用 CLI | 人类可读默认；Agent 显式传 `--json` / `--format json` |
| 大结果或实时事件 | JSON Lines + `--limit` / cursor；必要时输出 artifact 路径 |
| 仅输出路径或单值的 Unix 过滤器 | 纯文本或 NUL 分隔，并确保可稳定管道化 |

显式格式比“根据是否 TTY 改变字段或含义”更安全。可以在非 TTY 下关闭颜色和表格装饰，但不要隐式改变数据 schema。

### 不要这样做

1. 在 JSON 前后打印“正在处理”“完成”等文本。
2. 让正常失败退出 `0`，或要求调用者以 `success` 字段补救退出码失效。
3. 缺少 flag 时展示选择菜单，导致 agent 在 CI 或管道中永久等待。
4. 让哈希表、并发任务或本地化文案决定输出顺序或 schema。
5. 在 SKILL 复制完整参数表，然后让它随命令演进而漂移。
6. 默认内联大对象、Base64 或全文；应返回摘要、分页信息和文件路径。
7. 声称“JSON 稳定”，却没有 schema/fixture 契约测试与变更策略。
8. 为了 Agent 支持而另起一个协议 server；如果 shell CLI 已满足组合、发现和契约需求，CLI 本身就是足够的机器接口。

---

## 7. 参考实现与依据

本规范优先依据当前目录已整理项目的一手实现：

- **OpenCLI**：`opencli list -f json` 是动态注册表；SKILL 明确要求先运行发现命令，再查子命令 help；格式由 `-f/--format` 显式指定。
- **CLI-Anything / MacroCLI**：Agent 工作流采用 `list --json` → `info --json` → `--dry-run` → 执行；其 schema、artifact 路径和副作用声明值得借鉴，但本项目以退出码而非 `success` 字段作为成功权威。
- **qsv**：机器消费场景偏好紧凑、可筛选的 TSV/CSV，并从命令 usage 生成技能元数据，说明“单一命令定义生成多种发现界面”可降低漂移。
- **ripgrep**：`--json` 采用类型化 JSON Lines 消息流，适合流式、事件式结果。
- **GitHub CLI**：`--json <fields>` 把字段选择变为正式接口，并在非交互脚本中要求通过参数提供必要信息。
- **yt-dlp**：明确区分可变化的人类 stdout 与可承诺的机器输出入口，避免消费者解析展示文本。
- **just**：以声明和紧邻 recipe 的注释生成任务发现与 shell completion；适合借鉴“单一命令定义派生多种发现界面”。
- **gum**：优秀的交互式 shell 组件；反向证明选择、确认和编辑等 TTY 体验必须有参数化的非交互替代。
- **ast-grep**：以 AST 模式进行代码搜索、lint 与改写；适合借鉴“匹配、预览和显式应用分层”，避免把文本替换当作安全重构。
- **xh**：HTTP 调用的请求体、输出范围、离线构造与 HTTP 状态退出码均可显式控制；适合借鉴外部请求的输入/输出与副作用边界。

外部规范与官方资料：

- [Command Line Interface Guidelines](https://clig.dev/)：stdout/stderr、退出码、非交互、颜色与组合性基线。
- [Agent Skills specification](https://agentskills.io/specification)：SKILL frontmatter 与渐进式加载约定。
- [GitHub CLI extension documentation](https://docs.github.com/en/enterprise-cloud@latest/github-cli/github-cli/creating-github-cli-extensions)：非交互调用与 `--json` 字段选择示例。
- [Python argparse documentation](https://docs.python.org/3/library/argparse.html)：从参数定义生成 help、usage 及默认值展示。

这些案例用于说明取舍，不替代本项目的第 2 节契约；当案例与本规范冲突时，以本规范和测试为准。所有本地克隆的提交号、重点源码与下一步研究方向见[研究索引](cli-research-index.md)。
