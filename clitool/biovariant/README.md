# bio-variant

`bio-variant` is a machine-first CLI for small batches of human SNVs and short
sequence indels. It sends explicit genomic alleles to Ensembl VEP and returns
normalized consequence, transcript, HGVS, and co-located clinical-significance
evidence. It requires Node.js 20 or newer and has no runtime dependencies.

This CLI is standalone: it does not modify Agent configuration, register an MCP
server, or add a core tool. Install it globally before an Agent can invoke it
through the included skill template.

## Run locally

```bash
# 从仓库根目录执行
cd clitool/biovariant
npm link
command -v bio-variant
bio-variant --describe --format json

# Or invoke directly during development before linking.
node bin/bio-variant.js annotate --variant 17:7674220:C:T --format json
node bin/bio-variant.js annotate --input variants.vcf --assembly GRCh38 --limit 100 --format json
node bin/bio-variant.js annotate --variant 17:7674220:C:T --dry-run --format json
```

For a non-development installation, run `npm install -g /absolute/path/to/biovariant`.
Restart the Agent backend after installation if it was started before the Node
global bin directory was added to `PATH`.

## Commands and limits

| Command | Purpose | External state |
| --- | --- | --- |
| `annotate` | Annotate a coordinate variant or small VCF batch through Ensembl VEP. | Read-only Ensembl REST request. |

Provide exactly one `--variant CHROM:POS:REF:ALT` or `--input PATH`. VCF rows
must have at least the five standard tab-separated columns; multi-allelic rows
are expanded. The default VCF limit is 100 alleles and the hard limit is 200,
matching the Ensembl VEP POST limit. Symbolic alleles, breakends, and structural
variants are deliberately out of scope for this initial release.

Clinical evidence is only the clinical-significance data returned with VEP
co-located variants. It is not a clinical interpretation and does not replace
direct ClinVar review. Use `--dry-run` to validate input and inspect the planned
request without contacting Ensembl.

All successful commands emit one JSON document on stdout. Errors emit a JSON
error envelope on stderr.

See the shared [CLI development and integration boundary](../docs/clitool-development-boundary.md).
