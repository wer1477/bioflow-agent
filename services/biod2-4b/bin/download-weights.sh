#!/usr/bin/env bash
# Download the released biod-mt-v2-4b weights from Hugging Face.
set -euo pipefail
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$SERVICE_DIR/weights}"
REPO="${BIOD_HF_REPO:-wer1477/biod-mt-v2-4b}"
mkdir -p "$DEST"
python - "$REPO" "$DEST" <<'PY'
import sys
from huggingface_hub import snapshot_download
repo, dest = sys.argv[1], sys.argv[2]
snapshot_download(repo_id=repo, local_dir=dest)
print("downloaded", repo, "to", dest)
PY
