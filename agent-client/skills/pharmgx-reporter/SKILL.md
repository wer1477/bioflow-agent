---
name: pharmgx-reporter
description: "Pharmacogenomic (PGx) report from direct-to-consumer genetic data (23andMe/AncestryDNA): star-allele diplotype calling, metabolizer phenotype inference, CPIC-level drug guidance, and JSON/HTML/Markdown report output. Use for PGx interpretation of raw genotype files; research/education use only, not a clinical diagnosis."
---

# PharmGx Reporter（药物基因组学报告）

从 23andMe / AncestryDNA 等 direct-to-consumer（DTC）原始基因数据生成药物基因组学（PGx）报告：解析基因型 → 调用 star allele（diplotype）→ 推断代谢表型 → 匹配 CPIC 级药物建议 → 输出 Markdown / HTML / JSON 报告。

本 skill 从 [ClawBio](https://github.com/ClawBio/ClawBio)（MIT）导入，运行时只依赖 Python 标准库，可完全离线运行；来源与改动见 `NOTICE`。

## 何时使用

适合：

- 拿到 23andMe / AncestryDNA 原始数据文件，想了解 12+ 个 PGx 基因的代谢表型和药物提示；
- 需要 CYP2D6 / CYP2C19 / CYP2C9 / VKORC1 / SLCO1B1 / DPYD / TPMT / UGT1A1 / CYP3A5 / CYP2B6 / NUDT15 / CYP1A2（当前上游 main 另含 MTHFR）等基因的 diplotype / phenotype 汇总；
- 想对单个药物（如 Plavix、warfarin）做快速 PGx 查询，或生成药物卡片；
- 需要结构化 JSON 结果对接下游分析。

不适合：

- 临床诊断、用药决策、剂量调整（见「限制与风险」）；
- 全基因组/全外显子变异解读、非 PGx 位点分析；
- 从 VCF 做大规模群体分析（请使用专门的 VCF 工具链）。

## 输入格式

| 格式 | 扩展名 | 必需字段 |
|---|---|---|
| 23andMe raw data | `.txt` / `.txt.gz` | rsid、chromosome、position、genotype |
| AncestryDNA raw data | `.txt` | rsid、chromosome、position、allele1、allele2 |

- 格式按文件头自动识别；gzip 透明读取；共享 parser 亦可识别 MyHeritage / VCF。
- 位点按 rsID 匹配而非坐标匹配，因此同一份样本在 GRCh37 与 GRCh38 下调用结果一致。
- 参考基因组由 5 个 SNP 的染色体 + 坐标 panel 判定，并写入报告：

| 判定结果 | 行为 |
|---|---|
| `GRCh38` | 正常调用 |
| `GRCh37` | 正常调用，报告注明坐标为 GRCh37 |
| `unknown_build` | 所有基因置为 Indeterminate（坐标与两种 build 都不匹配，提示文件损坏或注释到不支持的组装） |
| 无法判定 | 不声明 build，正常调用 |

`demo/demo_patient.txt` 是真实 GRCh37 23andMe 示例数据，用于演示 GRCh37 路径。

## 运行命令

必须在 skill 目录下运行，并设置 `PYTHONPATH=scripts`（vendored 的 `clawbio` 包位于 `scripts/` 下）：

```bash
cd agent-client/skills/pharmgx-reporter

# 全量报告（离线推荐加 --no-enrich）
PYTHONPATH=scripts python3 scripts/pharmgx_reporter.py \
  --input <patient_file.txt> --output /tmp/pgx-report --no-enrich

# 演示数据
PYTHONPATH=scripts python3 scripts/pharmgx_reporter.py \
  --input demo/demo_patient.txt --output /tmp/pgx-demo --no-enrich

# 单药查询（结果打印到 stdout，不写报告文件）
PYTHONPATH=scripts python3 scripts/pharmgx_reporter.py \
  --input demo/demo_patient.txt --drug Plavix --no-enrich
```

参数（已用 `--help` 实跑确认）：

| 参数 | 说明 |
|---|---|
| `--input PATH` | 原始基因数据文件 |
| `--output DIR` | 输出目录（默认 `pharmgx_report`） |
| `--drug NAME` | 单药查询（通用名或商品名，如 `Plavix` / `warfarin`） |
| `--dose DOSE` | 药盒可见剂量（如 `50mg`），用于单药灰度卡片 |
| `--no-enrich` | 跳过可选的 ClinPGx 证据富集，保证完全离线 |
| `--demo` | 使用脚本同目录的 `demo_patient.txt`；本目录 demo 数据在 `demo/`，请直接传 `--input demo/demo_patient.txt` |

不加 `--no-enrich` 时程序会尝试可选的 ClinPGx 富集；本离线包未包含 `clinpgx` skill，会自动跳过并继续生成报告，不产生网络请求。

## 能力范围

- **覆盖基因**：CYP2C19、CYP2D6、CYP2C9、VKORC1、SLCO1B1、DPYD、TPMT、UGT1A1、CYP3A5、CYP2B6、NUDT15、CYP1A2；当前上游 main 另含 MTHFR。上游宣传口径为 **12 基因 / 31 SNP / 51 药**，当前 main 实际为 **13 基因 / 33 SNP / 59 药**（frontmatter description 沿用上游原始文案）。
- **调用链**：基因型解析 → star allele diplotype → 代谢表型（Poor / Intermediate / Normal / Rapid / Ultra-rapid 等）→ CPIC 药物建议（AVOID / CAUTION / STANDARD / INSUFFICIENT）。
- **药物类别**：抗血小板、阿片类、他汀、抗凝、PPI、抗抑郁药（TCA / SSRI / SNRI）、抗精神病药、NSAIDs、肿瘤、免疫抑制剂、抗病毒等。
- **特殊警报**：华法林（CYP2C9 + VKORC1 多基因）等。
- **单药模式**：输出 Dosage Card（药物 → 基因 → 表型 → 建议），供药物卡片类流程复用。

## 输出

指定 `--output DIR` 后产出：

```text
DIR/
├── report.md                  # Markdown 报告（含 DATA QUALITY WARNING 与 Disclaimer）
├── report.html                # 同内容 HTML 报告（含 Disclaimer）
├── result.json                # 结构化结果：gene_profiles / drug_recommendations / summary
└── reproducibility/commands.sh
```

- 所有产物只写入 `--output` 目录。
- `report.md` / `report.html` 末尾含固定免责声明：ClawBio 为研究与教育工具，不是医疗器械，不提供临床诊断。
- `result.json` 含每个基因的 diplotype / phenotype、各类药物清单和汇总计数。

## 演示数据运行与验收

```bash
cd agent-client/skills/pharmgx-reporter
PYTHONPATH=scripts python3 scripts/pharmgx_reporter.py \
  --input demo/demo_patient.txt --output /tmp/pgx-demo --no-enrich
```

实测摘要（2026-10-20）：

- 识别 23andMe 格式、GRCh37，输入 23 个 SNP，命中 PGx SNP 23/33；
- 13 个基因均输出 diplotype / phenotype（部分为 Indeterminate）；59 个药物：31 Standard / 10 Caution / 1 Avoid / 17 Insufficient data；
- AVOID 警报：Warfarin（Coumadin）；
- `report.md` 与上游 `demo/expected_report.md` 仅 `**Date**` 行不同，输入 SHA-256 一致。

验收判据：`report.md`、`report.html`、`result.json` 均非空；`report.md` 与 `report.html` 含 `ClawBio is a research and educational tool` 免责声明。

## 依赖与环境

- Python 3.11+，只用标准库，无需 pip 安装。
- vendored 模块 `scripts/clawbio/*` 仅依赖标准库；`opentelemetry` 相关 import 均为 `TYPE_CHECKING` 或函数内可选导入，运行时不需要安装。
- 必须设置 `PYTHONPATH=scripts`。
- 可选：仅当存在 `clinpgx` skill 时才启用证据富集（本包未提供）。

## 限制与风险

- **用途限制**：仅供研究与教育，不是临床诊断或用药依据；任何用药调整必须由有资质的临床医生或药师结合临床级 PGx 检测决定。
- **DTC 芯片固有局限**：CYP2D6 拷贝数变异（*5 缺失、*1xN/*2xN 重复、*13/*36 杂合等）无法从 SNP 芯片检测；UGT1A1*28（rs8175347）为 TA 重复，芯片只能给出 proxy 结果；CYP3A5*7（rs41303343）为 indel，平台常用 proxy SNP。缺少关键 SNP 时对应基因标记为 Indeterminate。
- **覆盖不完整**：star allele 规则基于有限位点，未覆盖的罕见等位基因可能导致表型判断偏差；缺失 SNP、phase ambiguity 会输出 Indeterminate。
- **坐标 build**：坐标无法匹配 GRCh37/GRCh38（`unknown_build`）时，所有基因结果 withheld。
- **证据等级**：离线包不做 CPIC 在线查询，`result.json` 中 `clinpgx_enriched=0`；药物建议来自内置规则表。
- **版本差异**：上游 main 已从 12/31/51 扩展到 13/33/59（新增 MTHFR 等），与 description 字面口径存在差异，使用前以实际运行输出为准。
- **许可**：MIT，版权归 ClawBio / Manuel Corpas；来源、commit SHA 与本地改动见 `LICENSE` 与 `NOTICE`。

## 目录结构

```text
pharmgx-reporter/
├── SKILL.md
├── LICENSE                     # MIT（ClawBio / Manuel Corpas）
├── NOTICE                      # 来源仓库、commit SHA、导出日期、改动说明
├── scripts/
│   ├── pharmgx_reporter.py     # 上游原样
│   └── clawbio/                # vendored 共享库（最小 clawbio/__init__.py）
│       └── common/{__init__,parsers,checksums,report,audit,html_report,rec_shortener}.py
└── demo/
    ├── demo_patient.txt        # GRCh37 23andMe 示例数据
    └── expected_report.md      # 上游 demo 期望报告
```
