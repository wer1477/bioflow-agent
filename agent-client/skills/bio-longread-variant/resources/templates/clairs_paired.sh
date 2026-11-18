#!/usr/bin/env bash
# ClairS paired tumor/normal somatic template (official README snapshot 2026-10-20).
set -euo pipefail

TUMOR_BAM="${TUMOR_BAM:-tumor.bam}"
NORMAL_BAM="${NORMAL_BAM:-normal.bam}"
REF_NAME="${REF_NAME:-ref.fa}"
INPUT_DIR="${INPUT_DIR:?absolute dir containing both BAMs and the FASTA}"
OUTPUT_DIR="${OUTPUT_DIR:?absolute output dir on the server}"
THREADS="${THREADS:-8}"
PLATFORM="${PLATFORM:-ont_r10_dorado_hac_5khz_v6}"
IMAGE="${IMAGE:-hkubal/clairs:latest}"
EXTRA_ARGS="${EXTRA_ARGS:-}"                 # e.g. --include_all_ctgs; add -d for a dry run
mkdir -p "${OUTPUT_DIR}"

# shellcheck disable=SC2086
docker run --rm \
  -v "${INPUT_DIR}:${INPUT_DIR}" \
  -v "${OUTPUT_DIR}:${OUTPUT_DIR}" \
  "${IMAGE}" \
  /opt/bin/run_clairs \
    --tumor_bam_fn "${INPUT_DIR}/${TUMOR_BAM}" \
    --normal_bam_fn "${INPUT_DIR}/${NORMAL_BAM}" \
    --ref_fn "${INPUT_DIR}/${REF_NAME}" \
    --threads "${THREADS}" \
    --platform "${PLATFORM}" \
    --output_dir "${OUTPUT_DIR}" \
    ${EXTRA_ARGS}

# Final call set: ${OUTPUT_DIR}/output.vcf.gz
