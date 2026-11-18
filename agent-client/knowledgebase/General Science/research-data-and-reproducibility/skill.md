---
name: "Research Data and Reproducibility"
description: "Practical approaches to raw data management, metadata, version control, and computational reproducibility."
---

# Research Data and Reproducibility

## 适用场景

任何会产生数据与代码的研究项目，尤其是需要长期维护、多人协作或投稿后共享的生信分析。

## 数据分层

- **原始数据（raw）**：只读，永不修改；用校验和（如 sha256）记录完整性。
- **中间数据（interim/processed）**：可由脚本从 raw 重新生成，允许覆盖。
- **结果（results）**：图表与汇总表，注明由哪个脚本、哪份输入产生。
- **代码（scripts）**、**文档（docs）**、**元数据（metadata）** 与数据分离存放。

推荐在项目根下使用语义清晰的固定目录（data/raw、data/interim、results、scripts、docs），并在 README 中说明每个目录的用途。

## 元数据与样本表

- 样本表至少包含：样本 ID、分组、生物学重复编号、批次、采集/处理日期、仪器与试剂版本、关键参数。
- 分析参数（比对版本、阈值、软件版本）随结果一起记录；不要只留在终端历史里。
- 遵循 FAIR 原则：可发现、可访问、可互操作、可复用；公开数据注明许可证与访问条件。

## 版本控制

- 代码、配置、小型文本与脚本用 git；提交信息说明「改了什么、为什么」。
- 大文件不要塞进 git；使用数据管理工具（DVC、git-annex）或对象存储，并在版本库中记录指针/校验和。
- 分析流程使用环境锁定：conda environment.yml、requirements/lock 文件或容器镜像。

## 计算可重复性

- 全流程脚本化，避免手工点击与手工改表；固定随机种子。
- 记录软件与数据库版本（如 `sessionInfo()`、`pip freeze`、参考基因组与注释版本）。
- 一键复现入口优先（Makefile、snakemake、nextflow 或一个总控脚本）。
- 对关键结果做小规模自测（如用已知答案的模拟数据跑通评分脚本）。

## 常见错误

- 只保留最终结果，丢弃原始数据与中间步骤。
- 文件名 final_v2、分析_copy 满天飞，无法判断哪份是最新。
- 在 Excel 中直接修改原始数据而不留副本。
- 共享时未检查隐私、伦理与受控数据访问要求。
