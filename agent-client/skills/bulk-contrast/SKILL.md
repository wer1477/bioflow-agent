---
name: "bulk-contrast"
description: "Fixed two-group bulk contrast for GEO matrices: log2(CPM+1) (raw counts) or log2(value+1) (1e6-normalized), Welch t, BH q-values, declared gene filter. Consumes a geo-contract so sample/scale problems are refused instead of silently analysed."
---

# bulk-contrast

`bulk_contrast.py` is the execution step after `geo-contract`. It refuses to run on
an incomplete join or an unknown scale, and it never chooses groups by itself.

## Commands

```bash
python3 bulk_contrast.py run \
  --matrix data/GSE275962_Bd21A_N_readcount.csv.gz \
  --contract results/contract.json \
  --groups groups.json \
  --out-prefix results/contrast
```

`groups.json` supports both sample-level and column-level groups:

```json
{"id": "contrast",
 "control": ["GSM8488583", "GSM8488584", "GSM8488585"],
 "treated": ["GSM8488586", "GSM8488587", "GSM8488588"]}
```

or, when matrix columns carry the condition:

```json
{"id": "contrast",
 "control_columns": ["Bd21_N1", "Bd21_N2", "Bd21_N3"],
 "treated_columns": ["Bd21_A1", "Bd21_A2", "Bd21_A3"]}
```

Use `--out-prefix results/contrast` to produce the task-required
`results/contrast.csv` and `results/contrast.summary.json`. Do not rename outputs after
the run. Each group needs >=2 samples.

## Frozen method

- counts: per-sample CPM = count / library sum * 1e6; x = log2(CPM+1).
- 1e6-normalized matrices: x = log2(value+1).
- filter: mean value over all matrix samples >= `--min-mean` (default 10).
- log2FC = mean(x_treated) - mean(x_control); Welch t; BH over tested genes.
- `summary.method` records the exact method id; do not mix methods across arms.

## Limits

- Two groups only; no covariates, batch terms or interaction models.
- Normalized matrices are not raw counts: DESeq2-style dispersion is not applied.
- p-values from 2-3 replicates are exploratory, not confirmatory.
