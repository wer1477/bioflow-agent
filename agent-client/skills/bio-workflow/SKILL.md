---
name: bio-workflow
description: Plan reviewed RNA-seq, CUT&Tag, or DNA-seq analysis workflows derived from Bioagent compute scripts. Use to inspect required inputs, artifacts, tools, resource hints, and dependencies; this release does not execute workflows.
---

# bio-workflow

Use `bio-workflow` after the user has selected an analysis type and can provide explicit paths to input reads and reference artifacts. It only plans allowed templates; it does not use or configure a web UI.

```bash
bio-workflow templates --format json
bio-workflow describe --template rnaseq-standard --format json
bio-workflow plan --template cuttag-standard --params '{"raw_reads":"/data/reads","reference_fasta":"/ref/genome.fa","annotation_file":"/ref/genes.gtf"}' --format json
```

Read `steps`, `tools`, `resources`, and `final_artifacts` in the JSON result before proposing any execution. The returned `planned: true` means validation and planning only, never that computation ran.
