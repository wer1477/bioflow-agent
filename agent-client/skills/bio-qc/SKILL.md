---
name: "bio-qc"
description: "Summarize FASTQ read quality, BAM alignment sanity, or single-cell expression-matrix QC (cells, genes, counts, mitochondrial fraction). Use when asked whether sequencing data or an expression matrix is usable, before clustering/differential expression, or whenever a QC report and provenance manifest are needed without writing an ad-hoc Python script."
---

# bio-qc

Use this Skill when the task is to inspect input data quality, not to filter or
analyze it. Typical triggers: "check these FASTQs", "is this BAM okay", "QC the
matrix before clustering", "how many cells/genes and what is the mito
fraction". Do not use it for alignment, quantification, clustering, or
differential expression; those belong to other tools.

## Before running

Verify the command is installed (`command -v bio-qc`), then discover the
installed contract instead of assuming flags:

```bash
bio-qc --describe --format json
bio-qc check --format json
```

`check` reports the selected Python interpreter, `pysam`/`anndata`/`scipy`
availability, and whether `fastp`/`fastqc`/`samtools` are on `PATH`. Exit `1`
means a required backend is missing; follow the `hints` and re-run `check`.
Never install packages or switch interpreters just to make QC pass without
telling the user.

## Command order

1. `bio-qc check --format json` once per environment.
2. Pick exactly one data command:
   - `bio-qc fastq` for FASTQ/FASTQ.gz reads (add `--input2` for paired-end).
   - `bio-qc bam` for BAM alignments (pysam required).
   - `bio-qc matrix` for `.h5ad`, a 10x `matrix.mtx` directory, or a dense
     CSV/TSV matrix.
3. For any write command, run once with `--dry-run` to validate inputs and see
   the planned outputs. It writes nothing.
4. Run the real command with `--output <dir>`. The CLI creates the directory
   and writes `qc.json`, `qc.tsv`, and `manifest.json`.
5. Read `summary` from stdout first; open `qc.json` only for details such as
   per-file metrics, length distribution, or top references.

The CLI defaults to JSON and is non-interactive. Pass absolute paths. For
command-specific flags, use `bio-qc <command> --help` rather than relying on
this Skill.

## Reading the output

- Exit `0` = success. Exit `2` = bad usage or input (missing path, wrong
  extension, invalid flag); the JSON error on stderr contains `code`, `message`,
  and `hint`. Exit `1` = missing dependency, Python failure, or unwritable
  output.
- `summary` is the compact answer: FASTQ reads/bases/Q20/Q30/GC/N/length;
  BAM mapped/duplicate/proper-pair ratios, insert size, and coverage; matrix
  cells/genes/counts and mitochondrial fraction.
- `qc.json` holds `files`/`combined` for FASTQ, `metrics` for BAM/matrix, and
  `warnings`. Warnings are meaningful (paired read-count mismatch, non-integer
  matrix values, no `MT-` genes); mention them in the answer.
- `manifest.json` is provenance: command, tool/Python versions, input SHA-256,
  parameters, output SHA-256. Quote it when reproducibility matters; do not
  edit it.

## Risks and interpretation

- These are summary statistics, not a full FastQC report: no adapter content,
  over-represented sequences, or per-position quality profiles. Do not claim a
  library is "FastQC-passed" based on this output.
- FASTQ quality assumes Phred+33. Paired reads are statted independently;
  `read_pairs` is null when read counts differ.
- BAM coverage is a rough mean over aligned query bases, not depth histograms.
  `total_reads` includes secondary/supplementary records; CRAM is unsupported.
- Matrix QC loads the matrix into memory. `pct_mito` is null unless gene names
  start with `MT-` (case-insensitive); normalized values are reported as
  provided and flagged by `matrix.count_values_look_raw`.
- QC does not modify, trim, or filter the input. If filtering is requested,
  state that and use a dedicated trimming/filtering step afterward.
