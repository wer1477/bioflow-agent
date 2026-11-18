---
name: bio-seq
description: Validate DNA/RNA or protein sequence records, translate nucleotide sequences, and submit a small single-sequence remote NCBI BLAST query. Use for new sequences that cannot be answered by annotated-record lookup alone.
---

# Bio Sequence CLI

This Skill invokes the independently packaged CLI. Verify `command -v bio-seq`
from the Agent Shell before use.

Discover the installed command contract first:

```bash
bio-seq --describe --format json
```

Validate before a downstream operation when sequence type or formatting is
unclear:

```bash
bio-seq validate --input query.fasta --format json
bio-seq translate --sequence ATGAAATGA --frame 1 --format json
```

For one remote NCBI BLAST request, first dry-run it. Submission creates a remote
job and returns an asynchronous request ID (RID), rather than waiting and
polling automatically:

```bash
bio-seq blast --sequence MKWVTF --program blastp --email researcher@example.org --dry-run --format json
bio-seq blast --input query.fasta --program blastp --email researcher@example.org --format json
bio-seq blast-status --rid RID_FROM_SUBMISSION --format json
bio-seq blast-results --rid RID_FROM_SUBMISSION --format json
```

Wait at least one minute before each status poll. Do not use remote BLAST for
large batches or frequent automated requests; this first release has no local
BLAST+/MMseqs2 or clustering support. `blast-results` returns NCBI's JSONSA
report unchanged under `report`; use the source schema rather than assuming a
normalized hit layout.
