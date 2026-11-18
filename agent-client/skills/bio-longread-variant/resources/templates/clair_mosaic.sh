#!/usr/bin/env bash
# Clair-Mosaic template: omit CONTROL_BAM for single-sample mode (official README snapshot 2026-10-20).
set -euo pipefail

BAM_NAME="${BAM_NAME:-sample.bam}"
REF_NAME="${REF_NAME:-ref.fa}"
INPUT_DIR="${INPUT_DIR:?absolute dir containing the BAM(s) and FASTA}"
OUTPUT_DIR="${OUTPUT_DIR:?absolute output dir on the server}"
THREADS="${THREADS:-8}"
PLATFORM="${PLATFORM:-ont_r10_dorado_sup_5khz}"
IMAGE="${IMAGE:-hkubal/clair-mosaic:latest}"
CONTROL_BAM="${CONTROL_BAM:-}"               # set in paired mode, leave empty otherwise
EXTRA_ARGS="${EXTRA_ARGS:-}"                 # e.g. --enable_post_filtering --enable_indel_calling
mkdir -p "${OUTPUT_DIR}"

if [ -n "${CONTROL_BAM}" ]; then
  CONTROL_ARGS=(--control_bam_fn "${INPUT_DIR}/${CONTROL_BAM}")
else
  CONTROL_ARGS=()
fi

# shellcheck disable=SC2086
docker run --rm \
  -v "${INPUT_DIR}:${INPUT_DIR}" \
  -v "${OUTPUT_DIR}:${OUTPUT_DIR}" \
  "${IMAGE}" \
  /opt/bin/run_clair_mosaic \
    --bam_fn "${INPUT_DIR}/${BAM_NAME}" \
    ${CONTROL_ARGS[@]+"${CONTROL_ARGS[@]}"} \
    --ref_fn "${INPUT_DIR}/${REF_NAME}" \
    --threads "${THREADS}" \
    --platform "${PLATFORM}" \
    --output_dir "${OUTPUT_DIR}" \
    ${EXTRA_ARGS}

# Final call set: ${OUTPUT_DIR}/snv.vcf.gz
