# bio-align

Read alignment and quantification behind one command. It mirrors the
fastp → STAR/HISAT2/BWA/Salmon → featureCounts order used by nf-core/rnaseq;
it does not implement an aligner.

```bash
bio-align check --format json
bio-align plan --reads data/R1.fq.gz,data/R2.fq.gz --reference ref/star-index \
  --annotation ref/genes.gtf --output results/align --aligner star
bio-align run  --reads data/R1.fq.gz,data/R2.fq.gz --reference ref/star-index \
  --annotation ref/genes.gtf --output results/align --aligner star
```

Contract:

- `check` reports `available` / `missing` / `engines`; exit 1 when no native
  aligner + samtools combination is usable.
- `plan` prints `steps[{name, command, requires}]` and never writes files.
- `run` executes only when every `requires` tool is present; it writes
  `manifest.json` and `run.log` into `--output`. `--engine docker` is a
  plan-only preview in this release (install native tools to execute).
- The runtime shell prepends `.bioenv/bin` and the nvm bin directory; the CLI
  does the same for its own probes.

Tools are provisioned by `scripts/setup-ngs-tools.sh` into `.tools/ngs` and
exposed as wrappers in `.bioenv/bin`; `bio-align check` should report `ok:true`
on a provisioned host. Reference indexes and annotations are still per-species.
