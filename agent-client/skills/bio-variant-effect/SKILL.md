---
name: bio-variant-effect
description: "Query AlphaGenome variant-effect predictions with the official Python client (gRPC API) for SNVs/indels: chromatin, splicing, expression and regulatory impact evidence after VEP/ClinVar annotation. Requires ALPHA_GENOME_API_KEY (ALPHAGENOME_API_KEY accepted as an alias) and is research-use only; not a clinical interpretation."
---

# AlphaGenome variant-effect evidence

**Research use only.** AlphaGenome outputs are theoretical model predictions. They are
not diagnostic findings, pathogenic/benign classifications, or clinical advice. The
AlphaGenome Terms of Service restrict API outputs and Atlas data to non-commercial use
and prohibit clinical decision-making, medical advice, and training other ML models on
them.

**Access mode: `requires_api_key` + network.** Official public access is the
`alphagenome` Python client (pip) talking to Google's gRPC service with an API key. At
snapshot time the official docs document this client; they do **not** publish a public
REST/JSON endpoint for the API-key service. Confirm the current transport in the official
docs before promising a REST call (Step 4). Never invent an endpoint, header, or field.

## When to use

Use after annotation (bio-variant/VEP, ClinVar, gnomAD) when the question is "what might
this small variant do functionally?" — chromatin accessibility, splicing, gene
expression, TF/histone binding, 3D contacts. Good for non-coding variant prioritisation,
VUS follow-up, eQTL/sQTL hypothesis generation, and ranking candidates for experiments.

Not for: structural variants/CNVs or other large events (the model is evaluated on SNVs
and small indels), clinical classification, definitive causal claims, or species other
than human and mouse.

## Step 1 — pin the variant and assembly

- Human assembly: hg38 (GRCh38.p13); mouse: mm10. For hg19/other builds, liftover to
  hg38 with UCSC LiftOver and record the original coordinates.
- Inputs: `chromosome` (as used by the model docs, `chr`-prefixed), 1-based `position`,
  `reference_bases`, `alternate_bases`. One ALT allele per record; no symbolic alleles.
- Verify that `REF` matches the reference genome at `POS` before querying; a wrong REF
  silently changes the REF/ALT comparison.
- The context interval around the variant must be one of the supported lengths:
  16,384 | 131,072 | 524,288 | 1,048,576 bp, 0-based half-open, resized around the
  variant (`variant.reference_interval.resize(dna_client.SEQUENCE_LENGTH_1MB)`).

## Step 2 — authentication and environment preflight

```bash
python3 -c 'import alphagenome; print(alphagenome.__version__)' || pip install -U alphagenome
test -n "${ALPHA_GENOME_API_KEY:-}" && echo key_present || echo key_missing
# Never print, log, or commit the key value.
```

Official docs name the credential `ALPHA_GENOME_API_KEY` (Colab secret name, and the
default of `alphagenome.colab_utils.get_api_key()`). This harness may expose it as
`ALPHAGENOME_API_KEY`; normalise to the official name and keep one source of truth:

```bash
export ALPHA_GENOME_API_KEY="${ALPHA_GENOME_API_KEY:-${ALPHAGENOME_API_KEY:?set one of the two}}"
```

Get a key at <https://alphagenome.google/api> and read the terms at
<https://alphagenome.google/terms>. Preflight the terms too: free for non-commercial
research; no clinical use; no model-training use. Also check network reachability to the
documented service before promising results.

## Step 3 — query the effect through the official client

```python
import os
from alphagenome.data import genome
from alphagenome.models.v1 import dna_client, variant_scorers

model = dna_client.create(api_key=os.environ["ALPHA_GENOME_API_KEY"])
variant = genome.Variant(chromosome="chr22", position=36201698,
                         reference_bases="A", alternate_bases="C")
interval = variant.reference_interval.resize(dna_client.SEQUENCE_LENGTH_1MB)

scores = model.score_variant(
    interval=interval,
    variant=variant,
    variant_scorers=[
        variant_scorers.RECOMMENDED_VARIANT_SCORERS["RNA_SEQ"],
        variant_scorers.RECOMMENDED_VARIANT_SCORERS["SPLICE_SITES"],
        variant_scorers.RECOMMENDED_VARIANT_SCORERS["ATAC"],
        variant_scorers.RECOMMENDED_VARIANT_SCORERS["CHIP_HISTONE"],
    ],
    organism=dna_client.Organism.HOMO_SAPIENS,
)
df = variant_scorers.tidy_scores(scores)   # one row per variant/track or gene/track
```

Invoke the same query from the shell through the parameterised template (run it from the
skill directory so the resource path resolves; the key stays in the environment and off
the command line):

```bash
export ALPHA_GENOME_API_KEY="${ALPHA_GENOME_API_KEY:?missing}"
python3 resources/templates/score_variant.py \
  --chrom chr22 --pos 36201698 --ref A --alt C \
  --scorers RNA_SEQ SPLICE_SITES ATAC CHIP_HISTONE --out scores.tsv
```

Expected output shape (column names are from `tidy_scores`; example numbers are
illustrative placeholders, not real predictions):

| variant_id | output_type | variant_scorer | gene_symbol | raw_score | quantile_score |
| --- | --- | --- | --- | --- | --- |
| chr22:36201698:A>C | RNA_SEQ | GeneMaskLFCScorer | EXAMPLE | -0.42 | -0.87 |
| chr22:36201698:A>C | SPLICE_SITES | GeneMaskSplicingScorer | EXAMPLE | 0.11 | 0.62 |

Confirmed API surface (official client source and docs, snapshot 2026-10-20):

- `dna_client.create(api_key, *, model_version=None, timeout=None, address=None)`; the
  default address is `dns:///gdmscience.googleapis.com:443`; the key travels as gRPC
  metadata `x-goog-api-key`. `create()` does not read the environment itself — pass the
  key explicitly (or use `colab_utils.get_api_key()` inside Colab).
- Output types: `ATAC`, `CAGE`, `DNASE`, `RNA_SEQ`, `CHIP_HISTONE`, `CHIP_TF`,
  `SPLICE_SITES`, `SPLICE_SITE_USAGE`, `SPLICE_JUNCTIONS`, `CONTACT_MAPS`, `PROCAP`.
- `RECOMMENDED_VARIANT_SCORERS` keys include `RNA_SEQ`, `RNA_SEQ_ACTIVE`,
  `SPLICE_SITES`, `SPLICE_SITE_USAGE`, `SPLICE_JUNCTIONS`, `POLYADENYLATION`, `ATAC`,
  `DNASE`, `CAGE`, `PROCAP`, `CHIP_TF`, `CHIP_HISTONE`, `CONTACT_MAPS`, and the
  `*_ACTIVE` variants.
- `score_variant(...)` returns one AnnData per scorer; `tidy_scores()` produces
  `variant_id`, `output_type`, `variant_scorer`, `raw_score`, `quantile_score` (when
  available), plus gene/track metadata such as `gene_symbol`.
- `predict_variant(...)` returns raw REF and ALT tracks (`outputs.reference`,
  `outputs.alternate`) when tracks, not aggregated scores, are needed; pass
  `requested_outputs` and optional `ontology_terms=["UBERON:0002048"]` to restrict
  tissue/cell-type context.

## Step 4 — transport: confirm REST before any REST request

The official docs for this snapshot describe the Python client (gRPC) and do not publish
a public REST/JSON endpoint or schema for the API-key service. When a task explicitly
requires REST/HTTP:

1. Read the official docs (API index <https://www.alphagenomedocs.com/api/>, key page
   <https://alphagenome.google/api>) and the client repository
   <https://github.com/google-deepmind/alphagenome> for a documented HTTP endpoint.
2. Record what was verified — page URL, date, endpoint path, auth header. If none is
   documented, say so and use the official client path instead.
3. Do not use endpoints from community forum posts, blogs, or third-party servers: they
   are not official, may change, and may leak the key. A third-party PyTorch
   implementation (Kundaje Lab) documents a self-hosted REST serving mode, but it is not
   Google's API-key service — never present it as the official API.

If the environment has no network or no installed client, report the query as `blocked`
with the missing prerequisite. Never return invented scores or fields.

## Step 5 — interpret with limits

- Prefer `quantile_score` (empirical percentile against common variants) as the
  significance-like indicator; use `raw_score` for magnitude within one scorer only.
- Direction matters: signed scorers report the REF-to-ALT change; `*_ACTIVE` scorers
  report absolute activity in either allele and are not "increases" or "decreases".
- Gene-centric scores (RNA_SEQ, splicing) depend on the gene annotation used; keep
  `tidy_scores(..., match_gene_strand=True)` (the default) to drop mismatched strands.
- A high score is a hypothesis, not proof. Look for orthogonal support (eQTL/sQTL,
  conservation, perturbation data) and label every claim with its evidence type.
- Record the model version/address, assembly, sequence length, scorer names, ontology
  terms, and the exact request so the score is reproducible.
- Research-use-only and non-commercial limits apply to outputs and to Atlas data.

## Step 6 — connect to bio-variant (VEP)

Run bio-variant first for gene/transcript consequences, HGVS, and ClinVar co-located
evidence, then join on CHROM/POS/REF/ALT and assembly. Keep the VEP consequence and the
AlphaGenome score in the same row and flag discordance — for example a synonymous or
intronic VEP call with a high splicing score, or a missense variant with no regulatory
signal — for review. AlphaGenome complements annotation; it does not replace it, and the
two evidence streams must stay separately labelled.

## Sources and attribution

- AlphaGenome API overview: <https://alphagenome.google/api>; documentation:
  <https://www.alphagenomedocs.com/> (installation, API, variant scoring, FAQ)
- Client repository and Colab tutorials: <https://github.com/google-deepmind/alphagenome>
- Atlas precomputed genome-wide scores: <https://alphagenome.google/atlas>

The shape of this instruction was informed by the Apache-2.0-licensed
`google-deepmind/science-skills` entries `skills/alphagenome_single_variant_analysis/`
and `skills/alphagenome_variant_impact_score/` (snapshot 2026-10-20). No text is copied;
every API detail above was re-checked against the official AlphaGenome docs and client
source.
