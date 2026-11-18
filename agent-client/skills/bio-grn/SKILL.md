---
name: bio-grn
description: Infer candidate transcription-factor-to-target-gene regulatory associations from a validated bulk or single-cell expression matrix using Arboreto GRNBoost2 or GENIE3. Use when an expression-based GRN is needed; do not present the result as causal or direct binding evidence.
---

# Bio GRN CLI

Use this Skill only after the expression matrix and a candidate TF list are
available. `bio-grn` expects a tab-separated matrix with **observations as
rows** and unique gene names as columns. It produces candidate associations,
not proof of direct regulation or binding.

Confirm that the CLI is installed, then read its current machine contract:

```bash
command -v bio-grn
bio-grn --describe --format json
```

Always validate the input without computation first:

```bash
bio-grn infer \
  --expression expression.tsv \
  --tfs transcription_factors.txt \
  --method grnboost2 \
  --seed 777 \
  --output results/network.tsv \
  --dry-run \
  --format json
```

After the caller has confirmed the output location and resource cost, run the
same command without `--dry-run`:

```bash
bio-grn infer \
  --expression expression.tsv \
  --tfs transcription_factors.txt \
  --method grnboost2 \
  --seed 777 \
  --output results/network.tsv \
  --max-edges 50000 \
  --format json
```

Read the JSON result and the neighbouring manifest before reporting results.
The edge table has `TF`, `target`, and `importance`; higher importance is a
model ranking, not effect direction, causality, or evidence of direct binding.
State the filtering, seed, matrix preprocessing, and retained-TF count. Seek
orthogonal ChIP/ATAC/motif/chromatin-interaction or perturbation evidence
before calling an association a regulatory interaction.
