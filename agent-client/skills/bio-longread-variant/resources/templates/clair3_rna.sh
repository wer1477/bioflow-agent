#!/usr/bin/env bash
# Clair3-RNA germline template (official README snapshot 2026-10-20).
set -euo pipefail

BAM_NAME="${BAM_NAME:-rna.bam}"
REF_NAME="${REF_NAME:-ref.fa}"
INPUT_DIR="${INPUT_DIR:?absolute dir containing the BAM and FASTA}"
OUTPUT_DIR="${OUTPUT_DIR:?absolute output dir on the server}"
THREADS="${THREADS:-8}"
PLATFORM="${PLATFORM:-ont_dorado_drna004}"   # see README: ont_*/hifi_* RNA models
IMAGE="${IMAGE:-hkubal/clair3-rna:latest}"
EXTRA_ARGS="${EXTRA_ARGS:-}"                 # e.g. --enable_phasing_model --tag_variant_using_readiportal
mkdir -p "${OUTPUT_DIR}"

# shellcheck disable=SC2086
docker run --rm \
  -v "${INPUT_DIR}:${INPUT_DIR}" \
  -v "${OUTPUT_DIR}:${OUTPUT_DIR}" \
  "${IMAGE}" \
  /opt/bin/run_clair3_rna \
    --bam_fn "${INPUT_DIR}/${BAM_NAME}" \
    --ref_fn "${INPUT_DIR}/${REF_NAME}" \
    --threads "${THREADS}" \
    --platform "${PLATFORM}" \
    --output_dir "${OUTPUT_DIR}" \
    ${EXTRA_ARGS}

# Final call set: ${OUTPUT_DIR}/output.vcf.gz
