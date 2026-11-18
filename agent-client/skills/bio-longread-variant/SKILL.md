---
name: bio-longread-variant
description: "Generate and troubleshoot long-read variant-calling commands with the Clair3 family (Clair3, Clair3-RNA, ClairS, ClairS-TO, Clair-Mosaic): platform and model selection, preprocessing checks, Docker/conda preflight, parameterised command templates, post-processing and benchmarking guidance. Use for ONT/PacBio germline, somatic or mosaic variant detection when the actual run must happen on a laboratory server with Docker/Clair3 installed; never claim local execution."
---

# Long-read variant calling with the Clair3 family

**Execution mode: `server_required`.** This Skill produces a run contract — audited
inputs, a tool and model choice, one copy-paste command, and the expected artifacts —
for a laboratory Linux server where Docker or conda and the Clair family are installed.
The Agent Shell does not run Clair3 itself. Until the operator returns server evidence
(echoed command, exit status, log tail, `merge_output.vcf.gz` header), report the run as
**not executed** and the VCFs as **not produced**. Never describe an inferred result as a
call.

## Scope and boundaries

| Need | Tool | Final artifact |
| --- | --- | --- |
| Germline small variants, ONT/PacBio/Illumina | Clair3 | `merge_output.vcf.gz` |
| Germline small variants from long-read RNA-seq | Clair3-RNA | `output.vcf.gz` |
| Somatic, matched tumor/normal pair | ClairS | `output.vcf.gz` |
| Somatic, tumor-only | ClairS-TO | `snv.vcf.gz`, `indel.vcf.gz` |
| Mosaic small variants, paired or single sample | Clair-Mosaic | `snv.vcf.gz` |

Use this Skill for ONT, PacBio HiFi, and (where the tool supports it) Illumina data.
For short-read-only germline calling use the short-read variant Skills. Clair3 calls
small variants (SNPs/short indels); structural variants need a separate caller. All
outputs are research evidence, not a clinical interpretation.

## Step 1 — collect the run contract

Ask for these facts before selecting a model; missing facts become explicit unknowns,
not assumptions.

1. Sample design: germline DNA / long-read RNA / tumor-normal pair / tumor-only / mosaic (paired or single).
2. Platform and chemistry: ONT R9.4.1 or R10.4.1, 4 kHz or 5 kHz, Guppy or Dorado
   version and mode (SUP/HAC), or PacBio Sequel II / Revio, or Illumina.
3. Reference build and contig style (`chr1` vs `1`), plus paths to BAM(s) and FASTA.
4. **Reads are already aligned.** Clair3 does not align reads; the aligner and basecaller
   recorded in `@PG` must match the model you pick (the official training data used
   minimap2 for ONT/PacBio and BWA-MEM/NovoAlign for Illumina).
5. Region scope: whole genome, `--ctg_name`, `--bed_fn`, or candidate `--vcf_fn`.
6. Resources: thread budget, GPU available, output disk, run time limit.
7. Deliverable: VCF, GVCF, phased calls, or a benchmarking table.

## Step 2 — preflight (read-only, on the target server)

Run these in the server shell, or hand them to the operator verbatim. Any failed gate
blocks command generation; record `pass`, `fail`, or `unknown`.

```bash
samtools quickcheck -v sample.bam            # BAM/CRAM readable, not truncated
samtools view -H sample.bam | head -20       # @HD SO:coordinate; @SQ names; @PG aligner/basecaller
samtools index sample.bam                    # creates .bai/.csi; also confirms sort order
samtools faidx ref.fa                        # creates ref.fa.fai
samtools view sample.bam | head -1 | tr '\t' '\n' | grep -E '^(mv|ts):'   # Dorado mv tags (optional)
samtools idxstats sample.bam | awk '{s+=$3} END {print s" mapped reads"}'  # coverage sanity
samtools stats sample.bam | grep -E '^(SN|FFQ)' | head                     # base-quality/read-length sanity
df -h out_dir                                # free space for intermediates (human WGS: tens of GB)
docker image inspect hkubal/clair3:latest >/dev/null || echo MISSING_IMAGE
docker run --rm hkubal/clair3:latest ls /opt/models | head   # models visible in image
command -v docker conda mamba samtools       # runtime present
nvidia-smi                                   # only if GPU acceleration is requested
```

Gate table:

- `@HD SO:coordinate` missing or unsorted BAM → `samtools sort` then `samtools index`.
- No `.bai`/`.csi` → `samtools index` (Clair3 requires an indexed BAM).
- No `.fai` → `samtools faidx` (Clair3 requires an indexed FASTA).
- Contig names in the BAM header differ from `ref.fa.fai` (for example `chr1` vs `1`) →
  stop; remap or rename consistently before calling.
- Basecaller/chemistry in `@PG` and quality profile contradict the chosen model (e.g. an
  R9 Guppy model on Dorado R10 reads, or very short/very low-Q reads) → switch model or
  re-basecall; a mismatched model is worse than no call.
- Model directory lacks `pileup.pt` and `full_alignment.pt` → wrong path or a v1
  TensorFlow model; pick a PyTorch v2 model (see Step 3).
- Free space under ~30 GB on the output volume for a human WGS is a safe floor
  (operational rule of thumb, not an official requirement); scale with coverage and
  genome size, and pass `--remove_intermediate_dir`.
- `nvidia-smi` fails or driver < 530.30.02 → use the CPU image and drop `--use_gpu`.

## Step 3 — choose the tool and model

Clair3 v2 is a PyTorch release (v2.0.0, Feb 2026; current README documents v2.0.4).
**v1 TensorFlow models are not compatible with v2**, including the TF models ONT
distributes through Rerio: convert them with `convert_tf_checkpoint_to_torch.py`
(official `docs/model_migration_guide.md`) or use the pre-converted PyTorch catalogs:

- HKU PyTorch models: <https://www.bio8.cs.hku.hk/clair3/clair3_models_pytorch/>
- Converted Rerio models: <https://www.bio8.cs.hku.hk/clair3/clair3_models_rerio_pytorch/>
- Bundled locations: `/opt/models/` in the Docker image; `${CONDA_PREFIX}/bin/models/`
  in Bioconda.

Model rules that change the command:

- Clair3 `--platform` accepts only `ont`, `hifi`, `ilmn`; the model directory encodes
  chemistry/basecaller/version. Match the model to the `@PG` basecaller version.
- ONT R10.4.1 data with Dorado `mv` tags: use a `*_with_mv` model **and**
  `--enable_dwell_time`. A move-table model run without the flag fails early by design
  (v2.0.2). `--enable_dwell_time` is ONT-only and requires the C implementation
  (never pass `--disable_c_impl`).
- Clair3-RNA `-p/--platform` values: `ont_dorado_drna004`, `ont_r10_dorado_cdna`,
  `ont_guppy_drna002`, `ont_r9_guppy_cdna`, `hifi_sequel2_pbmm2`,
  `hifi_sequel2_minimap2`, `hifi_mas_pbmm2`, `hifi_mas_minimap2`.
- ClairS/ClairS-TO `-p/--platform` values name chemistry plus model lineage, e.g.
  `ont_r10_dorado_sup_5khz`, `ont_r10_dorado_hac_5khz_v6`, `ilmn`, `hifi_revio`.
  `ssrs` models (synthetic + real training) are the default recommendation; `ss` models
  suit cancer types absent from training. The ClairS `hifi_sequel2` model is documented
  as experimental.
- ClairS-TO ships four default panels of normals and a `verdict` module that uses tumor
  purity/CNA; keep them enabled unless the run contract says otherwise.
- Clair-Mosaic takes `--bam_fn` plus optional `--control_bam_fn` (paired mode) and
  exposes optional tagging modules (`--enable_baymgd_tagging`,
  `--enable_mosaicbase_tagging`, `--enable_post_filtering`).
- Sex chromosomes: Clair3 v2.0.3+ supports `--gender {unknown,male,female}` and
  `--par_regions_bed`. The PAR BED is a **local path only** and its contig names must
  match the reference style, otherwise the PAR exemption silently does not apply.

If a model name is not listed in the official README for that repository, stop and ask;
do not invent names or map a short-read model to a long-read platform.

## Step 4 — generate the command

Start from the parameterised templates in `resources/templates/` (Clair3 germline,
Clair3-RNA, ClairS, ClairS-TO, Clair-Mosaic) and fill every placeholder. Rules:

- Clair3 `run_clair3.sh` requires `--flag=value` for **all** parameters (official
  README caution); space-separated values are rejected. The other runners
  (`run_clair3_rna`, `run_clairs`, `run_clairs_to`, `run_clair_mosaic`) are invoked
  with `--flag value` as shown in their READMEs; if a runner rejects that form, read its
  `--help` on the server.
- Docker: mount input and output directories with **absolute paths**, and keep
  `OUTPUT_DIR` identical inside and outside the container. `-it` is optional for batch
  runs.
- Threads: each Clair3 chunk uses 4 threads and `ceil(threads/4)*3` chunks run in
  parallel; set `--threads` to the real CPU allocation, not the host total.
- GPU: use `hkubal/clair3:gpu`, add `--use_gpu` and optionally
  `--device=cuda:0`. Verify passthrough first with
  `docker run --rm --gpus all hkubal/clair3:gpu nvidia-smi`.
- Image tags: the README documents `:latest` (CPU) and `:gpu` (CUDA 12.1); Docker Hub
  also publishes release tags `v2.0.0` … `v2.0.4` (CPU) with matching `*_gpu` tags, so
  pin e.g. `hkubal/clair3:v2.0.4` (or `v2.0.0`) instead of `:latest` when reproducibility
  matters, and prefer v2.0.2+ for the indexed-VCF fix.
- Non-human or non-default contigs: add `--include_all_ctgs` (Clair3 defaults to
  `chr{1..22,X,Y}` and `{1..22,X,Y}`); a BED is preferred over point coordinates for
  region-restricted calling.
- Optional switches commonly needed: `--gvcf`, `--print_ref_calls`,
  `--enable_long_indel` (indels > 50 bp), `--gender`, `--haploid_precise` /
  `--haploid_sensitive` (non-diploid), the WhatsHap/LongPhase phasing flags listed in
  the README, `--qual`, `--sample_name`, `--chunk_size`, `--remove_intermediate_dir`.
- Amplicon/high-coverage runs: `--enable_variant_calling_at_sequence_head_and_tail` plus
  `--var_pct_full=1 --ref_pct_full=1` (human: also `--var_pct_phasing=1`; non-human: add
  `--no_phasing_for_fa`).
- `run_clairs`, `run_clairs_to`, and `run_clair_mosaic` accept `-d/--dry_run` to print
  the underlying commands; it is a safe server-side smoke test before the real run.

## Step 5 — outputs, post-processing, benchmark

Confirms what a real run must return:

- Clair3 writes `pileup.vcf.gz`, `full_alignment.vcf.gz`, and `merge_output.vcf.gz`
  (the final call set). Clair3-RNA and ClairS write `output.vcf.gz`; ClairS-TO writes
  `snv.vcf.gz` and `indel.vcf.gz`; Clair-Mosaic writes `snv.vcf.gz`.
- VCF is 4.2; INFO `P` marks pileup-model calls, `F` marks full-alignment calls. GVCF is
  GATK-compatible (`<NON_REF>`, validates with GATK) and can be merged with GLNexus using
  the published Clair3 config.
- Optional post-processing: `SwitchZygosityBasedOnSVCalls` relabels homozygous Clair3
  SNPs as heterozygous when AF <= 0.7 and the ±16 bp flanks fall inside a Sniffles2 SV
  deletion, adding `SVBASEDHET` and `ORG_CLAIR3_SCORE`.
- Benchmark with a truth set (GIAB for human), `hap.py` or `vcfeval`, and stratified
  regions. Report SNV/indel precision, recall, and F1 per stratification; compare against
  short-read calls and orthogonal evidence, and state that disagreement is unresolved
  rather than declaring either caller wrong.
- Check the VCF header for `clair3_version` (a pre-v2.0.1 header bug reported a stale
  version) and confirm `PASS`/`LowQual` matches the requested `--qual`.

## Step 6 — troubleshooting checklist

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `Illegal option` / unknown argument | `run_clair3.sh` given `--flag value` | use `--flag=value` |
| Model load error, missing `pileup.pt` | v1 TF model or wrong directory | use the PyTorch v2 catalog; verify `/opt/models/<name>` |
| Early failure mentioning move table | `*_with_mv` model without `--enable_dwell_time` | add the flag or pick a non-mv model |
| Empty or unindexed VCF on a clean run | older release bug | upgrade to v2.0.2+ (always emits indexed VCF) |
| Silently empty VCF on CRAM decode error | fixed in v2.0.3 (now non-zero exit) | upgrade; inspect logs |
| `chunk region ctg:nan-nan` | v2.0.4 fixed `SplitExtendBed` for single-region BEDs | upgrade |
| GPU job on the wrong device | v2.0.4 fixed `--device=cuda:N` mapping | upgrade; confirm with `nvidia-smi` during the run |
| Reference/BAM contig mismatch | `chr1` vs `1` | harmonise names; do not "fix" by editing VCFs |
| Out of disk | intermediates retained | `--remove_intermediate_dir`; stage output on a large volume |

## Handoff contract

Return exactly: (1) tool and model with the reason; (2) a preflight table with
`pass/fail/unknown` per gate; (3) the filled command; (4) expected artifact paths and
what to check in the VCF header; (5) unresolved unknowns and the operator's next action.
State execution status explicitly: `not run` unless the operator supplied server
evidence.

## Sources (official, snapshot 2026-10-20)

- <https://github.com/HKU-BAL/Clair3> — README, `docs/gpu_quick_start.md`,
  `docs/dwelling_time.md`, `docs/gender_option.md`, `docs/model_migration_guide.md`
- <https://github.com/HKU-BAL/Clair3-RNA>, <https://github.com/HKU-BAL/ClairS>,
  <https://github.com/HKU-BAL/ClairS-TO>, <https://github.com/HKU-BAL/Clair-Mosaic>
- Model catalogs and Docker images linked from those READMEs.

Written independently from the official READMEs above; no text was copied from
HKU-BAL/Clair-skills.
