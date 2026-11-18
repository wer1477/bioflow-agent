#!/usr/bin/env bash
# ClairS-TO tumor-only somatic template (official README snapshot 2026-10-20).
set -euo pipefail

TUMOR_BAM="${TUMOR_BAM:-tumor.bam}"
REF_NAME="${REF_NAME:-ref.fa}"
INPUT_DIR="${INPUT_DIR:?absolute dir containing the tumor BAM and FASTA}"
OUTPUT_DIR="${OUTPUT_DIR:?absolute output dir on the server}"
THREADS="${THREADS:-8}"
PLATFORM="${PLATFORM:-ont_r10_dorado_hac_5khz_v6}"
IMAGE="${IMAGE:-hkubal/clairs-to:latest}"
EXTRA_ARGS="${EXTRA_ARGS:-}"                 # e.g. --panel_of_normals a.vcf.gz,b.vcf.gz --disable_verdict
mkdir -p "${OUTPUT_DIR}"

# shellcheck disable=SC2086
docker run --rm \
  -v "${INPUT_DIR}:${INPUT_DIR}" \
  -v "${OUTPUT_DIR}:${OUTPUT_DIR}" \
  "${IMAGE}" \
  /opt/bin/run_clairs_to \
    --tumor_bam_fn "${INPUT_DIR}/${TUMOR_BAM}" \
    --ref_fn "${INPUT_DIR}/${REF_NAME}" \
    --threads "${THREADS}" \
    --platform "${PLATFORM}" \
    --output_dir "${OUTPUT_DIR}" \
    ${EXTRA_ARGS}

# Final call sets: ${OUTPUT_DIR}/snv.vcf.gz and ${OUTPUT_DIR}/indel.vcf.gz
