---
name: "geo-contract"
description: "Audit a GEO supplementary expression matrix against its SOFT sample metadata: decide which matrix columns are which GSMs, label the value scale (raw counts vs normalized to 1e6 vs unknown), and emit a machine-checkable contract JSON. Use before any GEO-derived analysis when sample joins or units are uncertain; never assume column order."
---

# geo-contract

`geo_contract.py` turns an untrusted GEO matrix + SOFT family text into a contract
that a later step can cite. It is deliberately allowed to report `unresolved`:
a positional guess is never promoted to a join.

## Commands

```bash
python3 geo_contract.py inspect \
  --matrix data/GSE275962_Bd21A_N_readcount.csv.gz \
  --soft data/GSE275962_SOFT.txt \
  --out results/contract.json \
  --dataset-id GSE275962
```

Options: `--synonyms map.json` (declared label equivalences, each entry must be
justified in the protocol), `--strict` (exit 3 if the join is incomplete).

## What it handles

- UTF-16, UTF-8/Latin-1, gzip; tab/comma/semicolon delimiters; leading `#` comments
  (featureCounts).
- Annotation columns (GO/KEGG) are separated from sample columns.
- Sample columns are selected by metadata evidence first; a purely numeric
  fallback is labelled `leftmost_numeric` and never treated as a join.
- Join evidence layers: `exact` (title / library name / description line) >
  `normalized` (case/punctuation) > `declared_subset` (documented synonyms) >
  `unresolved`/`ambiguous`.
- Scale from observed sums and integer density: `integer_counts`,
  `normalized_sum_1e6`, `author_normalized_other`.
- Provenance: sha256 of matrix/SOFT/synonyms, tool version, generated_at.

## Contract fields to read first

`join.fully_matched`, `join.unique_gsms`, `join.status_counts`,
`scale.label`, `scale.can_use_raw_counts`, `warnings`.
A downstream contrast must refuse when `join.fully_matched` is false or the scale is
`author_normalized_other`.

## Limits

- Does not download data; provide the matrix and SOFT file.
- Does not read the paper. A label such as `zf14_6` vs genotype `slzf3` needs a
  declared synonym with evidence; otherwise it stays unresolved.
- `n_rows` counts data rows, including any non-gene annotation rows present in the file.
