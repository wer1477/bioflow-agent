---
name: bio-variant
description: Annotate small batches of human SNVs and short indels through Ensembl VEP. Use for genomic-coordinate variants or VCF records when gene/transcript consequences, HGVS terms, and co-located clinical-significance evidence are needed.
---

# Bio Variant CLI

This Skill invokes the independently packaged CLI. Verify `command -v
bio-variant` from the Agent Shell before use.

Discover the installed command contract first:

```bash
bio-variant --describe --format json
```

Use a direct coordinate for one human small variant. Specify the genome assembly
explicitly when it is not GRCh38:

```bash
bio-variant annotate --variant 17:7674220:C:T --assembly GRCh38 --format json
bio-variant annotate --input variants.vcf --limit 100 --format json
```

Before the external request, validate a coordinate or VCF with `--dry-run`:

```bash
bio-variant annotate --variant 17:7674220:C:T --dry-run --format json
```

On success, read `annotations`. Each annotation includes the most severe
consequence, transcript-level gene/HGVS information, and clinical-significance
terms supplied by VEP co-located variants. Treat that evidence as research
context, not a clinical interpretation. This first release does not support
structural variants, symbolic VCF alleles, breakends, or local VEP execution.
