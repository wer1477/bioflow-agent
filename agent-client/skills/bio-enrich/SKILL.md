---
name: bio-enrich
description: Run gene-list functional enrichment through g:Profiler or Enrichr. Use for GO, Reactome, KEGG, and other gene-set over-representation questions after obtaining a gene list.
---

# Bio Enrichment CLI

This Skill invokes the independently packaged CLI. Verify `command -v
bio-enrich` from the Agent Shell before use.

Discover the installed command contract first:

```bash
bio-enrich --describe --format json
```

Use g:Profiler for an organism-aware analysis, source selection, custom
background, and a significance threshold:

```bash
bio-enrich enrich --genes TP53,BAX,MDM2 --organism hsapiens --sources GO:BP,REAC --format json
bio-enrich enrich --input genes.txt --background TP53,BAX,MDM2 --format json
```

For Enrichr, discover the live library names and pass one exact name:

```bash
bio-enrich libraries --format json
bio-enrich enrich --provider enrichr --library GO_Biological_Process_2023 --genes TP53,BAX --format json
```

Before a provider request, use `--dry-run` to validate the normalized gene list
and options. On success read `results`; each entry has source, term identifiers,
p-values, adjusted p-values, and overlapping genes when supplied by the provider.
