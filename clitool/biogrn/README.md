# bio-grn

`bio-grn` is a machine-first CLI for inferring candidate transcription-factor
(TF) to target-gene associations from a tab-separated bulk RNA-seq or scRNA-seq
expression matrix. It delegates GRNBoost2 or GENIE3 inference to
[Arboreto](https://github.com/aertslab/arboreto).

An inferred edge is an expression-based candidate association. It is neither
causal evidence nor proof of direct TF binding. Interpret it with orthogonal
ChIP, ATAC, motif, chromatin-interaction, or perturbation evidence.

## Run locally

The repository analysis environment must include the Python dependencies in
the root `requirements.txt` (including `arboreto`). From the repository root,
activate that environment, then run:

```bash
cd clitool/biogrn
npm link
command -v bio-grn
bio-grn --describe --format json
```

Infer a network from an observations × genes TSV. The first row contains unique
gene names; each later row must contain finite numeric expression values. The
TF file contains one candidate regulator per line. Only TFs found in the
matrix header are retained.

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

Start with `--dry-run` to validate input dimensions, genes, TF overlap, output
path and parameters without starting Python or writing files:

```bash
bio-grn infer --expression expression.tsv --tfs transcription_factors.txt \
  --output results/network.tsv --dry-run --format json
```

The real command writes a sorted TSV (`TF`, `target`, `importance`) and a
neighbouring JSON manifest (`network.tsv.manifest.json`). Existing outputs are
refused unless `--force` is provided. Set `BIOAGENT_PYTHON` to choose the
Python interpreter; it defaults to `python3`.

Arboreto 0.1.6 builds its dask graph with the legacy `dask.dataframe` API, so
the CLI starts the Python child with `DASK_DATAFRAME__QUERY_PLANNING=false`.
Without it, the dask expr query planner that is the default in dask 2024.10
fails while building the empty meta frame for `grnboost2`/`genie3`. The variable
is scoped to that child process and does not affect the rest of the environment.

This CLI is standalone: it does not register a core tool or an MCP server. The
Agent learns how to invoke it only through the separately installed `bio-grn`
Skill. See the shared [CLI development and integration boundary](../docs/clitool-development-boundary.md).
