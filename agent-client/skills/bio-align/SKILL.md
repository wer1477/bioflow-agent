---
name: "bio-align"
description: "Plan or run a minimal read-alignment pipeline: fastp -> STAR/HISAT2/BWA/Salmon -> featureCounts, with an explicit dependency check and a manifest. Use before hand-writing aligner commands; the environment may need provisioning first."
---

# bio-align：读段比对与定量

`bio-align` 只做编排：fastp → STAR/HISAT2/BWA/Salmon → featureCounts，并给出依赖检查、命令计划与 manifest。不实现比对算法。

## 何时用

- 有 FASTQ（单端或双端）和参考基因组/索引；
- 需要先把比对步骤写成可审查的命令，再决定要不要装工具；
- 需要 nf-core/rnaseq 风格的步骤顺序与产物。

不适用：需要剪接感知的复杂注释、UMI 处理、比对后变异调用（用 `bio-variant`）。

## 顺序

1. `bio-align check --format json`：看 `available` / `missing`。当前环境常缺 fastp/bwa/STAR/salmon，`check` exit 1 是预期的。
2. `bio-align plan ...`：先看 `steps[].command` 与 `requires`，确认参考索引、注释、输出目录。
3. 依赖齐全后再 `bio-align run ...`；缺依赖时 CLI 会 exit 1 并给安装 hint，不会半途执行。
4. 读 `manifest.json` 的 steps 与状态，再用 `bio-qc` / `bio-report` 汇总。

## 风险

- `--reference` 对 STAR 是 **genomeDir**（预构建索引），对 HISAT2/BWA 是索引前缀，对 Salmon 是索引目录；不要传原始 FASTA 给 STAR。
- 工具由 `scripts/setup-ngs-tools.sh` 安装到 `.tools/ngs`，并在 `.bioenv/bin` 生成 wrapper；先 `bio-align check`，缺工具时运行该脚本。参考索引/注释仍需按物种自备。
- `--engine docker` 目前只输出计划，不执行。
- 没有 `--annotation` 时只做比对、不做 gene counts；manifest 会警告。

## 怎么读输出

- `plan` / `check` 的 JSON 直接可读；`run` 只写 `manifest.json` 与 `run.log`，分析产物由各工具写入 `--output` 子目录。
- 把 `manifest.json` 交给 `bio-report`，可自动生成方法与命令附录。
