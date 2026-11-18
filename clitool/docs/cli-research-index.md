# CLI 参考实现研究索引

> 用途：为维护 [AI 友好 CLI 设计与交付规范](ai-friendly-cli-design.md) 的
> coding agent 提供可复核的一手源码入口。这里记录的是当前本地克隆快照，而不是
> 对上游版本永远成立的承诺。

## 使用方式

1. 先阅读设计规范，确定需要验证的契约类别。
2. 再到下表指定文件看实现与测试；不要从 README 的营销描述推导行为细节。
3. 新增案例时记录远程地址、提交号、观察点和“可借鉴 / 不应照搬”的结论。

克隆目录均位于 `clitool/` 下、且各自是独立 Git 仓库，供研究使用；它们不是本项目
的子模块，也不应与本项目的文档变更一起提交。
## 已有参考实现

| 类别 | 本地目录 | 重点研究 | 推荐入口 |
| --- | --- | --- | --- |
| 通用 CLI 与生态 | `cli`（GitHub CLI） | `--json <fields>`、认证和非交互调用 | `README.md`、`docs/`、`api/` |
| 文本搜索 | `ripgrep` | 类型化 JSON Lines、流式结果 | `GUIDE.md`、`crates/core/` |
| 表格数据 | `qsv` | CSV/TSV 的紧凑管道输出、命令元数据 | `README.md`、`docs/` |
| JSON/YAML 转换 | `jq`、`yq` | 过滤器组合、错误语义和稳定文本输出 | 各目录 `README.md`、`docs/` |
| 文件与终端体验 | `fd`、`fzf`、`bat`、`ugrep` | 可发现性、补全、TTY 适配 | 各目录 `README.md`、`doc/` |
| 内容提取 | `markitdown`、`yt-dlp` | 机器可消费产物、格式契约 | 各目录 `README.md`、`docs/` |
| Agent 适配层 | `OpenCLI`、`AutoCLI`、`CLI-Anything` | 动态发现、技能工作流、适配器与 dry-run | `README.md`、`docs/`、`SKILL.md` |

## 本轮新增快照（2026-08-09）

| 项目 | 本地快照 | 选择理由 | 可复用结论 | 需要避免的误读 |
| --- | --- | --- | --- | --- |
| [just](../just) | `4f41f609278edb6f1024e3dd7a9912946e1e7bc3` | 优秀的项目命令入口 | 由声明生成 `--list` 和 shell completion；紧邻任务的注释即发现信息。 | `--list` 是人类目录，不替代含参数类型与输出 schema 的机器注册表。 |
| [gum](../gum) | `716d8b5d0221558f944b5a078dbbcca8572534fb` | 高质量交互式 shell UX | 把选择、确认、输入和展示拆成小命令，主结果仍可写入 stdout。 | 交互控件不能成为自动化或 agent 的唯一入口；必须提供非交互替代。 |
| [ast-grep](../ast-grep) | `e8c70a7c7a6f8b73827e507b65201da8cea0ab79` | agent 可精确调用的结构化代码搜索与改写工具 | 以代码模式而非文本正则表达意图；搜索、lint、rewrite 与 interactive apply 分离。 | AST 匹配的安全性不意味着改写安全；默认应先报告匹配和 diff，再显式应用。 |
| [xh](../xh) | `3255393e10e5d2ed4c49eb036c0c7679d4653796` | 有明确请求/响应边界的 HTTP 外部工具 | `--body`、`--output`、`--offline`、`--check-status` 和非 TTY 下的无格式输出，使调用方能控制副作用、载荷与退出码。 | HTTP 响应正文和工具本身的 machine schema 是两回事；不要把漂亮打印后的响应误当成稳定 API。 |

### 高信号源码与测试入口

- `ast-grep/README.md`：以普通代码片段表达 AST 模式，区分搜索、lint 和 rewrite。
- `ast-grep/crates/cli/`：命令、`--json` 输出、扫描规则与改写行为的实现和测试。
- `xh/README.md`、`xh/src/cli.rs`：请求体来源、`--offline`、`--check-status`、
  `--print` / `--body`、非 TTY 格式化和 shell completion 的命令契约。
- `just/README.md`：recipe 注释、`--list` 与运行时生成的 shell completion。
- `gum/README.md`：将输入、确认和呈现组合为 shell 命令的模式。

## 下一轮研究优先级

1. **契约回归测试**：继续横向比较 `gh`、`ripgrep`、`qsv` 的机器输出测试，提炼
   可复用 fixture、schema 与快照策略。
2. **安全改写**：研究能明确区分查找、预览、diff 与应用的转换工具，避免把“找到匹配”
   误当成“可以无审查地批量写入”。
3. **发现协议**：评估命令注册表是否能同时生成 `--help`、completion 和
   `--describe --format json`，以单一事实源减少漂移。
