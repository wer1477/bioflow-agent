# clitool 开发与集成边界

本文适用于 clitool/<name>/ 下的每一个 CLI 项目。它规定 CLI 的源码归属、与 Agent 的默认隔离方式，以及何时才允许做集成工作。

## 默认边界

- 每个 CLI 的源码、测试、包配置、README 和可选的 SKILL 模板都放在 clitool/<name>/ 下。
- CLI 是独立的命令行程序。开发或修改 CLI 时，不得因此修改任何 Agent 应用的运行时、coretool 注册、MCP 配置、prompt、package bin 包装器或 Agent 配置。
- 每个 CLI 必须通过其 `package.json` 的 `bin` 声明提供全局命令。开发环境在
  `clitool/<name>/` 执行 `npm link`；部署环境执行
  `npm install -g /absolute/path/to/clitool/<name>`。安装后必须以
  `command -v <command>` 和 `<command> --describe --format json` 验证。
- 目标 Agent 的 Shell coretool 会把正在运行后端 Node 的 bin 目录加入 PATH；部署
  时仍应确保它与 `$(npm config get prefix)/bin` 对应，并在安装或切换 Node 版本后
  重启后端。全局命令可由已安装的 skill 调用，但不需要为此新增 coretool 或 MCP
  包装层。
- CLI 可在自己的目录保留 SKILL.md 作为分发模板；该文件只有被操作者复制或安装到目标 Agent 的 skills 目录，并且目标环境已提供对应命令后，才会成为该 Agent 可使用的 skill。

换言之，CLI 的“实现”和 Agent 的“采用”仍是两个生命周期：全局安装命令后，还
需要在目标 Agent 中安装相应 SKILL.md 模板，才能让 Agent 知道何时使用它。

## 唯一例外：显式集成任务

只有用户明确提出一个独立的 Agent 集成任务时，才可以修改 Agent 侧。该任务必须说明目标 Agent、采用方式（例如手动安装 skill、镜像构建或受控发布）和允许修改的目录。

即使存在集成任务，也应优先通过已安装的 skill 和可执行命令连接 Agent 与 CLI；不要为了让 Agent 发现 CLI 而重新创建同等能力的 coretool 或 MCP 包装层。

## 每个 CLI 项目的要求

每个 clitool/<name>/README.md 应链接到本文，并说明：

1. 本项目的本地运行入口和依赖；
2. 命令发现方式、机器输出和副作用；
3. 此 CLI 不自动接入 Agent；
4. SKILL 模板（若存在）的部署由操作者负责。

## 交付检查

在提交一个独立 CLI 前，确认：

- 所有本次实现文件位于 clitool/<name>/，或位于同级 clitool/docs/ 的通用规范中；
- 除非任务明确授权集成，Agent 应用目录没有新增该 CLI 的命令名、包装器、coretool/MCP 注册或 prompt 引用；
- CLI 自己的测试、--help 和机器可发现接口已通过；
- SKILL 仅作为 CLI 项目中的模板保留，不假设已安装到任何 Agent。
- CLI 已按发布方式全局安装，并从目标 Agent 的 Shell 环境验证了 `command -v` 和
  `--describe`。
