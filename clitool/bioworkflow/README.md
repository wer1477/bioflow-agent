# bio-workflow

`bio-workflow` is a machine-first planner for reviewed bioinformatics workflow templates. Its first release distils only the compute-side RNA-seq, CUT&Tag and DNA-seq pipelines from the adjacent Bioagent source tree. It has no dependency on, and does not modify, Bioagent's web application, backend, database or SSH executor.

It implements the [CLI development and integration boundary](../docs/clitool-development-boundary.md): it is an independent CLI and does not automatically install itself into an Agent.

```bash
bio-workflow templates --format json
bio-workflow describe --template rnaseq-standard --format json
bio-workflow plan --template rnaseq-standard --params '{"raw_reads":"/data/reads","sample_sheet":"/data/samples.txt","reference_index":"/ref/index.1.ht2","gene_bed":"/ref/genes.bed","annotation_file":"/ref/annotation.txt","go_annotation_file":"/ref/go.txt","kegg_annotation_file":"/ref/kegg.txt","groups":"control,treatment","contrasts":"treatment-control"}' --format json
```

`plan` has no side effects. It validates the template allowlist and parameter object, then returns a DAG with the source-script provenance, artifact contracts, tool requirements and resource hints. It deliberately does not execute the source scripts in this release: their hard-coded infrastructure paths, conda environments and external scheduler assumptions must first be normalized behind a separately reviewed execution adapter.

The included [`SKILL.md`](SKILL.md) is a distribution template only; an operator must install it explicitly in an Agent environment.
