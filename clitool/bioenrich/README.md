# bio-enrich

`bio-enrich` is a machine-first CLI for gene-list over-representation analysis. It
uses g:Profiler by default and can submit a list to a selected Enrichr library.
It requires Node.js 20 or newer and has no runtime package dependencies.

The CLI is standalone: it does not modify Agent configuration, register an MCP
server, or add a core tool. It must be installed as a global command before an
Agent can invoke it through the included skill template.

## Run locally

```bash
# 从仓库根目录执行
cd clitool/bioenrich
npm link
command -v bio-enrich
bio-enrich --describe --format json

# Or invoke directly during development before linking.
node bin/bio-enrich.js --describe --format json
node bin/bio-enrich.js enrich --genes TP53,BAX,MDM2 --sources GO:BP,REAC --format json
node bin/bio-enrich.js libraries --format json
node bin/bio-enrich.js enrich --provider enrichr --library GO_Biological_Process_2023 --genes TP53,BAX --format json
```

For a non-development installation, run `npm install -g /absolute/path/to/bioenrich`.
Restart the Agent backend after installation if it was started before the Node
global bin directory was added to PATH.

Use `--input path/to/genes.txt` instead of `--genes`; identifiers can be
comma-, whitespace-, or newline-separated. Duplicate identifiers are removed
while preserving order.

## Commands

| Command | Purpose | External state |
| --- | --- | --- |
| `enrich` | Run g:Profiler or selected Enrichr-library enrichment. | Enrichr temporarily stores a submitted gene list. |
| `libraries` | List current Enrichr library names and metadata. | None beyond the read request. |

`enrich --provider gprofiler` accepts `--organism` (default `hsapiens`),
`--sources`, `--background` (a direct gene list), and `--user-threshold`. `enrich --provider enrichr`
requires an exact `--library` name; discover it first with `libraries`.

All successful commands write one JSON document to stdout. Errors write a JSON
error envelope to stderr. `enrich --dry-run` validates and prints the planned
request without contacting either provider.

See the shared [CLI development and integration boundary](../docs/clitool-development-boundary.md).
