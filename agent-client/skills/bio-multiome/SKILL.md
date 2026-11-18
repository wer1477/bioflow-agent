---
name: bio-multiome
description: Validate aligned scRNA/scATAC TSV exports and derive group-wise RNA/ATAC candidate evidence edges from peak-gene links. Use after preprocessing or scVI/MultiVI integration; it does not train models or establish regulatory causality.
---

# Bio Multiome CLI

Use `bio-multiome` after `scvi-tools` or another preprocessing workflow has
exported aligned cell-by-gene RNA, cell-by-peak ATAC, and cell metadata TSVs.
The first column in every input is `cell_id`; the other matrix columns are genes
or peak IDs. Confirm assembly, feature namespaces, group, and optional batch
metadata before creating a result.

```bash
bio-multiome validate --rna rna.tsv --atac atac.tsv --metadata cells.tsv \
  --assembly GRCh38 --group-by cell_type --output results/multiome-check.json \
  --dry-run --format json
```

Then use `bio-peak link` output as the coordinate candidate set. `--gene-key`
must match the RNA header namespace (`gene_name` by default, or `gene_id`).

```bash
bio-multiome link --rna rna.tsv --atac atac.tsv --metadata cells.tsv \
  --peak-links peak-gene-links.tsv --grn network.tsv \
  --assembly GRCh38 --group-by cell_type --min-cells 30 \
  --output results/multiome-edges.tsv --dry-run --format json
```

The output keeps peak–gene linking, RNA/ATAC association, and GRN target
support in separate fields. State the group size, assembly, batch-handling
limitation, and that these are candidate associations rather than direct
regulation or spatial/CCI evidence.
