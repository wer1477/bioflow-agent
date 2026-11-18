#!/usr/bin/env bash
# 健康检查：/v1/health + /v1/version，并与 MANIFEST 记录的指纹比对。
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BIOD_BASE_URL:-http://127.0.0.1:8790}"

python3 - "$BASE_URL" "$SERVICE_DIR/MANIFEST.json" <<'PY'
import json, sys, urllib.request

base, manifest_path = sys.argv[1], sys.argv[2]

def get(path):
    with urllib.request.urlopen(base + path, timeout=10) as resp:
        return json.loads(resp.read().decode())

health = get("/v1/health")
version = get("/v1/version")
manifest = json.load(open(manifest_path, encoding="utf-8"))
expected = (manifest.get("weights") or {}).get("serve_ckpt_sha256")

print("health.ok            :", health.get("ok"))
print("health.status        :", health.get("status"))
print("modelVersion         :", health.get("modelVersion"))
print("device               :", health.get("device"))
print("ckptPath             :", health.get("ckptPath"))
print("ckptSha256           :", health.get("ckptSha256"))
print("ckptFiles/bytes      :", health.get("ckptFiles"), "/", health.get("ckptBytes"))
print("loadedAt             :", health.get("loadedAt"))
print("optionCounts         :", health.get("optionCounts"), "(0/0 expected for biod-mt-v2)")
print("version.optionIds    :", {k: len(v) for k, v in (version.get("optionIds") or {}).items()})
if expected:
    print("manifest.cksum match :", "YES" if expected == health.get("ckptSha256") else "NO (weights changed!)")
sys.exit(0 if health.get("ok") else 1)
PY
