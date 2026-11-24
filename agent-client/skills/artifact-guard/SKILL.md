---
name: "artifact-guard"
description: "Create, verify and publish versioned provenance for analysis artifacts: sha256 of declared inputs/outputs, immutable vN directories, explicit changed/missing verification. Use when accepted v1 outputs must stay intact while a recomputation produces a new version."
---

# artifact-guard

`artifact_guard.py` implements the small protocol the development traces repeated:
record what an accepted artifact depends on, keep it intact, and prove what changed
when a new version is produced.

## Commands

```bash
# 1. freeze the accepted outputs
python3 artifact_guard.py snapshot --manifest results/prov-v1.json \
  --label effect-v1 --version v1 \
  --input data/counts.csv --input data/manifest.json \
  --output results/effect-v1.json

# 2. after a recomputation or a new input, detect drift
python3 artifact_guard.py verify --manifest results/prov-v1.json --report results/verify-v1.json
# exit 0 = identical, 3 = changed/missing

# 3. publish a new version without touching v1
python3 artifact_guard.py publish --manifest results/prov-v2.json \
  --version v2 --dest results/versions
```

`snapshot` refuses to overwrite an existing manifest (exit 4) and `publish` refuses
an existing version directory (exit 4), so an accepted version cannot be silently
replaced.

## Use rules

- Snapshot accepts only files that already exist; do not list expected outputs.
- `verify` never rewrites the manifest.
- A changed input is not an error in the artifact; it means the derived result is
  stale and needs a new version.

## Limits

- Local filesystem only; no signing, no remote store.
- Directory recursion is not supported; list files explicitly.
