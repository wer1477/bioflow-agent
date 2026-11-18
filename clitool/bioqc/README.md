# bio-qc

`bio-qc` is a machine-first quality-control CLI for sequencing inputs and
single-cell expression matrices. It produces one JSON result on stdout and a
small, self-describing artifact set (`qc.json`, `qc.tsv`, `manifest.json`) in
an output directory.

The FASTQ and dense-matrix statistics are implemented in Python's standard
library, so `fastq` and CSV/TSV `matrix` work with a bare `python3`. BAM uses
[pysam](https://pysam.readthedocs.io/), `.h5ad` uses
[anndata](https://anndata.readthedocs.io/), and 10x Matrix Market directories
use [scipy](https://scipy.org/). `fastp`, FastQC, and samtools are not used to
compute metrics; `check` only probes their presence and version for optional
cross-checks. This CLI does not reinvent QC metrics: names and denominators
follow the conventions used by FastQC, fastp/MultiQC general statistics, and
samtools flagstat/coverage summaries.

## Requirements

- Node.js 20 or newer (the CLI itself has no npm dependencies).
- A Python 3.9+ interpreter. The CLI resolves one in this order:
  1. `$BIOAGENT_ENV_BIN/python3` (when `BIOAGENT_ENV_BIN` is set),
  2. `<repository>/.bioenv/bin/python`,
  3. `python3` on `PATH`.
- Optional Python packages, per command:
  - `bam`: `pysam`
  - `matrix` with `.h5ad`: `anndata`, `h5py`
  - `matrix` with a 10x `matrix.mtx` directory: `scipy`, `numpy`

Run `bio-qc check --format json` first. It reports the selected interpreter,
every backend module, external tools, and per-command capabilities. It exits
`1` when Python or `pysam` (the only mandatory backend) is missing; missing
optional `.h5ad`/Matrix Market support appears in `capabilities` and `hints`
without failing the basic FASTQ/CSV paths.

## Run locally

```bash
# From the repository root.
cd clitool/bioqc
npm test
node bin/bio-qc.js --describe --format json
node bin/bio-qc.js check --format json
```

Install the command before an Agent can invoke it through the Skill, for
example `npm link` in development or `npm install -g /absolute/path/to/clitool/bioqc`.
Restart the Agent backend if it was started before the Node global `bin`
directory was added to `PATH`.

## Commands

| Command | Input | Purpose | Writes |
| --- | --- | --- | --- |
| `check` | none | Report Python, QC modules, and optional external tools. | Nothing |
| `fastq` | FASTQ or `.fastq.gz`, optional R2 | Reads/bases, Q20/Q30 ratios, GC%, N%, lengths, length distribution. | `qc.json`, `qc.tsv`, `manifest.json` |
| `bam` | BAM | Mapped/duplicate/properly-paired reads, insert size, references, rough coverage. | Same |
| `matrix` | `.h5ad`, 10x mtx dir, or dense `.csv`/`.tsv`/`.txt` | Cells, genes, counts per cell, genes detected, `pct_mito`. | Same |

All commands default to `--format json`; `json` is currently the only format.
Use `--dry-run` on `fastq`, `bam`, and `matrix` to validate inputs and print
the plan without reading data or writing files. A real run creates the output
directory if needed and overwrites existing `qc.json`, `qc.tsv`, and
`manifest.json`; other files in the directory are left untouched.

```bash
bio-qc fastq --input R1.fastq.gz --input2 R2.fastq.gz --output qc_out
bio-qc bam --input sample.bam --output qc_out
bio-qc matrix --input filtered_feature_bc_matrix/ --output qc_out
bio-qc matrix --input matrix.csv --output qc_out
```

FASTQ compression is detected from the gzip magic bytes, not the extension;
paired inputs may mix gzip and plain files.

## Metric definitions

- `reads`, `bases`: FASTQ records and summed read lengths.
- `q20_ratio` / `q30_ratio`: fraction of all bases with Phred+33 quality
  `>= 20` / `>= 30` (0–1), matching FastQC's per-base quality aggregation.
- `gc_pct`, `n_pct`: `(G+C)/bases` and `N/bases` as percentages (0–100).
- `mean_length`: `bases / reads`; `min_length`/`max_length` are observed read
  lengths. `length_distribution` lists the first 20 distinct lengths by
  ascending length, and `length_bins` gives up to 20 equal-width length bins
  (`start`, `end`, `count`) across the observed range. `length_distribution_truncated`
  is true when more lengths exist or the distinct-length tracker hit its
  10,000-entry safety cap.
- BAM `mapped_ratio` is over all records; `duplicate_ratio` and
  `properly_paired_ratio` are over mapped records. `average_insert_size`
  averages positive template lengths from proper pairs, so each pair
  contributes once. `mean_coverage` is `aligned_bases / reference_length` over
  references with reads; `genome_coverage` uses all reference lengths. Both
  are deliberately rough (aligned query bases, not depth histograms).
- Matrix `counts_per_cell` and `genes_detected_per_cell` are distributions
  (`min`, `p25`, `median`, `mean`, `p75`, `max`, `total`; the `pct_mito`
  distribution omits `total` because summing percentages is not meaningful). `pct_mito` is
  computed only when gene names start with `MT-` (case-insensitive), and
  `cells_over_threshold` counts cells above 20%.
- Dense CSV/TSV rows are cells and columns are genes; an optional first
  column with an empty/ID header is treated as cell IDs. Empty fields become
  zero. For normalized/log-transformed matrices the fields are still reported
  as provided; `matrix.count_values_look_raw` tells whether every value was an
  integer.

## Artifacts and manifest

`qc.json` contains the engine result plus tool, Python, input fingerprints,
parameters, and warnings. `qc.tsv` is a bounded tab-separated summary (one row
per FASTQ input plus `combined`, or `section/metric/value` rows for BAM and
matrix). `manifest.json` records the command and argv, tool version, Python
interpreter, input SHA-256 hashes and sizes, parameters, output SHA-256 hashes
and sizes, and timestamps. It is intended as provenance for downstream reports;
do not edit it after a run.

FASTQ input hashes are computed in the same pass as the statistics. BAM and
matrix inputs are hashed before writing artifacts. A matrix directory is
represented by hashes of its regular files.

## Exit codes and errors

- `0`: success.
- `1`: missing dependency, Python failure, or analysis/output failure.
- `2`: usage or input error.

Errors never print a JavaScript/Python stack to stdout. They write one JSON
envelope to stderr:

```json
{"schema_version":1,"error":{"code":"invalid-input","message":"...","hint":"..."}}
```

Set `BIO_QC_DEBUG=1` to include engine tracebacks in `error.detail` (stderr) or
to print a JavaScript stack for unexpected internal errors.

## Discoverability

`bio-qc --describe --format json` is the machine-readable command registry.
`bio-qc <command> --help` is generated from the same declaration and includes
options, defaults, artifacts, and examples. Keep `SKILL.md` limited to task
selection and interpretation; do not duplicate the full option table there.

## Limitations

- FASTQ quality is assumed to be Phred+33; colorspace and multi-run mixtures
  are not interpreted.
- No adapter detection, over-represented-sequence scan, or per-position quality
  profile is produced. Run FastQC/fastp separately when those modules matter.
- BAM counting includes secondary and supplementary records in `total_reads`;
  CRAM is not supported by `bam`.
- Matrix QC loads `.h5ad` and dense matrices into memory.
- `pct_mito` requires the `MT-` prefix; mouse `mt-` names are also recognized.

## Tests

```bash
cd clitool/bioqc
npm test
```

Tests cover the registry contract, help/version, exit-code and JSON-error
behavior, `--dry-run` side effects, deterministic FASTQ statistics and gzip
magic detection, artifact/manifest hashes, BAM counting (when `pysam` is
available), and CSV/10x/h5ad matrix QC (when `scipy`/`anndata` are available).
Missing optional Python dependencies cause the corresponding test to be
reported as skipped rather than failed.

This CLI is standalone: it does not register a core tool or an MCP server. The
Agent learns how to invoke it only through the separately installed `bio-qc`
Skill. See the shared [CLI development and integration boundary](../docs/clitool-development-boundary.md).
