#!/usr/bin/env bash
# Clair3 v2 germline — parameterised template (official README snapshot 2026-10-20).
# Fill placeholders; run on the laboratory server; this Skill never executes it.
set -euo pipefail

BAM_NAME="${BAM_NAME:-sample.bam}"
REF_NAME="${REF_NAME:-ref.fa}"
INPUT_DIR="${INPUT_DIR:?absolute dir containing the BAM and FASTA}"
OUTPUT_DIR="${OUTPUT_DIR:?absolute output dir on the server}"
THREADS="${THREADS:-8}"
PLATFORM="${PLATFORM:-ont}"                  # {ont,hifi,ilmn}
MODEL_NAME="${MODEL_NAME:-r1041_e82_400bps_hac_v600}"
IMAGE="${IMAGE:-hkubal/clair3:latest}"       # pin e.g. hkubal/clair3:v2.0.4; GPU: hkubal/clair3:gpu + --use_gpu
EXTRA_ARGS="${EXTRA_ARGS:-}"                 # e.g. --include_all_ctgs --gender=male
mkdir -p "${OUTPUT_DIR}"

# No -it here: the official README uses -it for interactive use, batch jobs need --rm only.
# shellcheck disable=SC2086
docker run --rm \
  -v "${INPUT_DIR}:${INPUT_DIR}" \
  -v "${OUTPUT_DIR}:${OUTPUT_DIR}" \
  "${IMAGE}" \
  /opt/bin/run_clair3.sh \
    --bam_fn="${INPUT_DIR}/${BAM_NAME}" \
    --ref_fn="${INPUT_DIR}/${REF_NAME}" \
    --threads="${THREADS}" \
    --platform="${PLATFORM}" \
    --model_path="/opt/models/${MODEL_NAME}" \
    --output="${OUTPUT_DIR}" \
    ${EXTRA_ARGS}

# Final call set: ${OUTPUT_DIR}/merge_output.vcf.gz
