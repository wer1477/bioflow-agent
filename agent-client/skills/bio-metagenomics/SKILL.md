---
name: "bio-metagenomics"
description: "Plan or run a minimal shotgun-metagenomics pipeline: fastp -> host removal -> MEGAHIT/SPAdes -> Kraken2/Kaiju -> Taxpasta, with an explicit dependency check and a manifest. Use before hand-writing assembly/classification commands; provisioning is usually required first."
---

# bio-metagenomics：宏基因组分类与组装

`bio-metagenomics` 只做编排：QC → 可选去宿主 → 组装 → 物种分类 → 标准表，并给出依赖检查、命令计划与 manifest。不实现组装器或分类器。

## 何时用

- 有 shotgun 宏基因组 FASTQ（单端或双端）和已构建的分类数据库；
- 需要先审查组装/分类命令与依赖，再决定是否安装工具；
- 需要 Taxpasta 风格的标准物种表。

不适用：16S 扩增子（用专用流程）、病毒富集/变异调用（用 `bio-variant` + 参考流程）、需要分箱/MAG 质量评估的完整流程（用 nf-core/mag）。

## 顺序

1. `bio-metagenomics check --format json`：看 `available` / `missing`。工具由 `scripts/setup-ngs-tools.sh` 安装到 `.tools/ngs`，正常应 `ok:true`；分类数据库仍需自备。
2. `bio-metagenomics plan ...`：核对待跑命令、数据库路径、是否去宿主。
3. 依赖齐全后再 `run`；缺依赖时 exit 1 并给安装 hint，不会半途执行。
4. 读 `manifest.json`，再用 `bio-report` 汇总。

## 风险

- 分类结果强依赖数据库版本；manifest 只记录路径，不记录数据库内容，报告里要写清版本。没有 Kraken2 `--db` 或 Kaiju `nodes.dmp + kaiju_db.fmi` 时，`run` 会在 classify 步骤失败。
- `--host-reference` 需要已有的 BWA 索引；没有索引时先 `bwa index`。
- `--engine docker` 目前只输出计划，不执行。
- 组装和分类都很吃内存/CPU；`--threads` 只控制线程，不控制内存。
- Kraken2 的 `--db` 是目录；Kaiju 需要 `nodes.dmp` 与 `kaiju_db.fmi`，不要混用。

## 怎么读输出

- `plan` / `check` 的 JSON 直接可读；`run` 写 `manifest.json` 与 `run.log`。
- 最终物种表在 `taxonomy/taxonomy.tsv`（Taxpasta 标准列）；分类原始输出在 `taxonomy/`。
- 把 `manifest.json` 交给 `bio-report`，可生成方法与数据库附录。
