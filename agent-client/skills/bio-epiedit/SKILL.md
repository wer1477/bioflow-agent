---
name: bio-epiedit
description: Rank supplied CRISPRi, CRISPRa, or CRISPRoff guide candidates with explicit sequence, off-target, and regulatory-coordinate evidence. Use for transparent experimental prioritization; it does not generate guides or claim editing efficacy.
---

# Bio Epigenetic Editing Candidates

Use `bio-epiedit` after guide candidates and their sequence scores already
exist. Guide generation belongs to `molecular-cloning`; coordinate evidence
comes from `bio-regulatory` and `bio-peak link`.

Inspect the policy and validate all inputs before creating a result:

```bash
bio-epiedit --describe --format json
bio-epiedit describe-policy --format json
bio-epiedit rank --guides guides.tsv --target-gene TP53 --assembly GRCh38 \
  --editor crispri --output results/tp53-guides.tsv --dry-run --format json
```

When regulatory evidence, peak–gene links, or independently generated off-target
scores are available, supply their exact artifact paths. Confirm their assembly
and source manifests before running. The output score is a documented ranking
policy for experimental prioritization, not a prediction of efficacy, specificity,
cell-context response, or a recommendation to edit a biological system.
