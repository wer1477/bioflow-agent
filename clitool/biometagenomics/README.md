# bio-metagenomics

Shotgun metagenomics behind one command: fastp → optional host removal →
MEGAHIT/SPAdes → Kraken2/Kaiju → Taxpasta. It mirrors the nf-core/mag and
nf-core/taxprofiler step order; it does not implement an assembler or classifier.

```bash
bio-metagenomics check --format json
bio-metagenomics plan --reads data/R1.fq.gz,data/R2.fq.gz \
  --output results/meta --database db/kraken2 --classifier kraken2
bio-metagenomics run  --reads data/R1.fq.gz,data/R2.fq.gz \
  --output results/meta --database db/kraken2 --classifier kraken2
```

Contract:

- `check` reports `available` / `missing` / `engines`; exit 1 until a working
  `samtools` + classifier + assembler combination exists.
- `plan` prints `steps[{name, command, requires}]` and never writes files.
- `run` executes only when every `requires` tool is present; it writes
  `manifest.json` and `run.log`. `--engine docker` is a plan-only preview.
- Classification needs a prebuilt database (Kaiju: `nodes.dmp` + `kaiju_db.fmi`;
  Kraken2: a standard `--db` directory).

Tools are provisioned by `scripts/setup-ngs-tools.sh` into `.tools/ngs` and
exposed as wrappers in `.bioenv/bin`; `check` should report `ok:true` on a
provisioned host. Classification databases are still required and are not
installed by that script.
