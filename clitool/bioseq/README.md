# bio-seq

`bio-seq` is a machine-first CLI for validating raw/FASTA sequence records,
translating nucleotide records with the standard genetic code, and submitting a
single sequence to the NCBI BLAST URL API. It requires Node.js 20 or newer and
has no runtime package dependencies.

The CLI is standalone: it does not modify Agent configuration, register an MCP
server, or add a core tool. It must be installed globally before an Agent can
invoke it through the included skill template.

## Run locally

```bash
# 从仓库根目录执行
cd clitool/bioseq
npm link
command -v bio-seq
bio-seq --describe --format json

node bin/bio-seq.js validate --sequence '>example\nATGNNNTAA' --format json
node bin/bio-seq.js translate --sequence ATGAAATGA --frame 1 --format json
bio-seq blast --sequence MKWVTF --program blastp --email researcher@example.org --dry-run --format json
```

For a non-development installation, run `npm install -g /absolute/path/to/bioseq`.
Restart the Agent backend after installation if it was started before the Node
global bin directory was added to `PATH`.

## Commands

| Command | Purpose | External state |
| --- | --- | --- |
| `validate` | Parse raw or FASTA records and report alphabet/length metadata. | None |
| `translate` | Translate nucleotide records using NCBI translation table 1. | None |
| `blast` | Submit one `blastn` or `blastp` query to NCBI and return a RID. | Creates a remote NCBI BLAST job. |
| `blast-status` | Read state for a supplied NCBI BLAST RID. | Read-only NCBI request. |
| `blast-results` | Retrieve a ready RID as the provider JSONSA report. | Read-only NCBI request. |

`blast` accepts exactly one raw or FASTA sequence. `blastn` requires nucleotide
input and defaults to `nt`; `blastp` requires protein input and defaults to
`nr`. The command requires `--email` in line with NCBI's usage guidance. It
returns immediately with the remote request ID (RID), not a potentially
long-running local process. Use `--dry-run` before submission, then wait at
least 60 seconds before `blast-status`; NCBI asks clients not to poll a RID more
frequently than once per minute.

This initial release deliberately excludes local BLAST+/MMseqs2 databases,
sequence clustering, reverse-complement translation, and nonstandard genetic
codes. Those resource-intensive capabilities should run inside the future whole
Agent sandbox, not become an optional agent-level safety boundary.

All successful commands emit one JSON document on stdout. Errors emit a JSON
error envelope on stderr.

See the shared [CLI development and integration boundary](../docs/clitool-development-boundary.md) and the [NCBI BLAST URL API](https://blast.ncbi.nlm.nih.gov/doc/blast-help/urlapi.html).
