# bio-report

`bio-report` is a machine-first CLI that assembles a reproducible analysis
report from artifacts a pipeline already produced: tool manifests, result
tables, figures and a methods file. It writes one Markdown document and can
render the same content to PDF with matplotlib, without pandoc or LaTeX.

The CLI is standalone: it does not modify Agent configuration, register a core
tool or MCP server, or change any prompt. It must be linked or installed as a
global command before an Agent can invoke it through the included skill
template.

## Requirements

- Node.js 20 or newer. There are no runtime package dependencies.
- Python 3.9 or newer to run `src/engine.py` (the standard library is enough
  for Markdown output).
- matplotlib only for `--pdf`.

The engine interpreter is resolved in this order:

1. `$BIOAGENT_ENV_BIN/python3`
2. `<repo>/.bioenv/bin/python`
3. `python3` on `PATH`

Run `bio-report check` to see which interpreter was selected and whether
matplotlib is importable.

## Run locally

```bash
# 从仓库根目录执行
cd clitool/bioreport
npm link
command -v bio-report
bio-report --describe --format json
bio-report check

# Or invoke directly during development before linking.
node bin/bio-report.js --describe --format json
node bin/bio-report.js build \
  --manifest run/fastp.json --manifest run/star.json \
  --results-dir results --figures-dir figures \
  --methods methods.md --title "RNA-seq QC" \
  --output out/report.md --pdf out/report.pdf
```

`npm test` runs the contract tests with `node --test`. The PDF test is skipped
automatically when the resolved interpreter cannot import matplotlib.

## Commands

| Command | Purpose | Side effects |
| --- | --- | --- |
| `build` | Read manifests, tables, figures and methods; write the report. | Creates `--output` (and `--pdf` when requested); nothing else is modified. |
| `check` | Report the Python interpreter and matplotlib availability. | None. |

`build` accepts at least one of `--manifest`, `--results-dir`,
`--figures-dir` or `--methods`:

- `--manifest PATH` (repeatable) — manifest JSON from one tool run. Missing
  fields are warned about, never fatal.
- `--results-dir DIR` (repeatable) — scanned recursively for `.csv`/`.tsv`.
  Each file becomes one table with its first 20 data rows plus row and column
  counts.
- `--figures-dir DIR` (repeatable) — scanned recursively for `.png`, `.pdf`
  and `.svg`; each file is listed with its size and sha256.
- `--methods PATH` — Markdown spliced into the Methods section.
- `--title TEXT` — report title (default `Analysis Report`).
- `--output PATH` — Markdown destination (default `report.md`).
- `--pdf PATH` — optional matplotlib PDF.
- `--dry-run` — print the planned reads, writes and actions; write nothing.

The report always contains Summary, Methods, Parameters & software versions,
Results tables, Figures and Provenance sections. Headings inside the methods
file are shifted down so they nest under the Methods section instead of
competing with the report outline.

### Manifest shape

`bio-report` accepts several common shapes and reports what it cannot find:

```json
{
  "tool": "fastp",
  "version": "0.23.4",
  "command": "fastp -i raw.fastq -o clean.fastq",
  "parameters": { "threads": 4 },
  "inputs":  [{ "path": "raw.fastq", "sha256": "…" }],
  "outputs": [{ "path": "clean.fastq", "sha256": "…" }]
}
```

Aliases are accepted (`name`/`tool_name`/`software` for the tool, `params`/
`args` for parameters, `cmd`/`command_line` for the command, `{path: sha256}`
maps for inputs/outputs). A manifest may be a single object, a list, or an
object with a `tools`, `runs`, `entries`, `records` or `steps` list. A missing
sha256 is computed from the file when it can be resolved next to the manifest
and is at most 64 MiB; otherwise it is reported as a warning.

### Reproducibility

`SOURCE_DATE_EPOCH` fixes both the report timestamp and the PDF
`CreationDate`/`ModDate`, so identical inputs render byte-identical PDFs.

## Output contract

Successful commands write one JSON document to stdout. Errors write a JSON
error envelope to stderr. `--format json` is the default and only format.

```json
{
  "schema_version": 1,
  "ok": true,
  "title": "RNA-seq QC",
  "outputs": { "markdown": "/abs/out/report.md", "pdf": "/abs/out/report.pdf" },
  "counts": { "manifests": 2, "tables": 1, "figures": 1 },
  "warnings": ["manifest /abs/star.json: tool 'STAR' has no version"]
}
```

Exit codes: `0` success; `1` runtime failure (Python engine unavailable,
matplotlib missing for `--pdf`, PDF not writable); `2` usage or input error.

If matplotlib is missing while `--pdf` was requested, the Markdown report is
still written, `ok` is `false`, `outputs.markdown` is populated, and the
process exits `1` with an install hint on stderr.

## Relationship to the Agent

This CLI is not wired into the Agent automatically. Install the command with
`npm link` (development) or `npm install -g /absolute/path/to/clitool/bioreport`
(deployment), then install the template at
`agent-client/skills/bio-report/SKILL.md` into the target Agent's skills
directory. See the shared [CLI development and integration
boundary](../docs/clitool-development-boundary.md).
