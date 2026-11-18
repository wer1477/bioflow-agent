# bio-multiome

`bio-multiome` consumes preprocessed TSV exports from paired or aligned scRNA
and scATAC analyses. It does not train scVI/MultiVI models. `validate` checks
cell alignment and metadata; `link` reports group-wise RNA/ATAC Pearson
associations for supplied `bio-peak link` candidate intervals.

```bash
bio-multiome link --rna rna.tsv --atac atac.tsv --metadata cells.tsv \
  --peak-links peak-gene-links.tsv --assembly GRCh38 --group-by cell_type \
  --min-cells 30 --output results/multiome-edges.tsv --dry-run --format json
```

The first column of all three input tables is `cell_id`. RNA and ATAC remaining
headers are genes and peak IDs, respectively. Associations and GRN target
support are separate columns; neither establishes a regulatory interaction.
