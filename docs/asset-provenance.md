# Asset provenance for published Skills, CLIs and MCP entries

A published capability may carry a `provenance.json` next to its `SKILL.md`:

```text
agent-client/skills/<skill-id>/
  SKILL.md
  provenance.json   # optional
```

The runtime reads only the version and never rewrites the file. When present, the
version travels with the candidate card into `tool_select` and into the recorded
decision, so a selected asset can be tied back to the run/trace that produced it.
Missing provenance means **no declared provenance**, not "verified".

## Schema

All fields are optional, but a real entry should fill them:

```json
{
  "schemaVersion": 1,
  "assetVersion": "plant-qc-v2",
  "sourceRun": "run-20261121-...",
  "sourceTrace": "transcripts/run-.../events.ndjson",
  "inputs": [
    {"path": "plant-inputs/GSE273926.csv", "sha256": "..."}
  ],
  "verification": {
    "command": "python3 scripts/verify_asset.py --asset plant-qc-v2",
    "result": "pass",
    "at": "2026-11-21T12:00:00Z"
  },
  "createdAt": "2026-11-21T11:00:00Z"
}
```

- `assetVersion`: stable curator version. If omitted, the runtime reports
  `sha256:<hash of provenance.json>`.
- `sourceRun`, `sourceTrace`: where the asset came from. These are locators, not
  proof by themselves.
- `inputs`: input paths and hashes used when the asset was validated.
- `verification`: the command/result that justified publication.

The file is capped at 64 KiB. Malformed JSON is ignored (treated as absent) and
never fails a run.

## How it is used

1. `collectToolLibraryCandidates` attaches `version` to Skill candidates whose
   directory has a provenance file.
2. `candidate_shortlist` includes the version in the catalog fingerprint and in
   the sidecar candidate card.
3. The decision ledger (`biod-decisions.jsonl`) records the transport mode,
   description characters, catalog fingerprint, and fallback (if any).
4. `tool_select` returns the selected card (including version) and the load result
   in the same tool response.

This is deliberately file-based and does not add a provenance service. The
minimum claim it supports is: "the version selected at decision time is the one
recorded with the decision/artifact"; it does not prove that the asset is correct.
