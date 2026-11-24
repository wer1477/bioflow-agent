#!/usr/bin/env python3
"""artifact-guard v1.0.0: immutable, versioned provenance for analysis artifacts.

Commands
  snapshot --manifest prov.json --label effect-v1 --input F... --output F...
      Write hashes/sizes and tool identity. Refuses to overwrite (exit 4) unless --force.
  verify --manifest prov.json [--report report.json]
      Recompute hashes; exit 3 when any file changed/missing, 0 when identical.
  publish --manifest prov.json --version v2 --dest versions/
      Copy the manifest's outputs into <dest>/<label>-<version>/ and write version.json.
      Refuses to overwrite an existing version directory (exit 4).

This mirrors the repeated development need to keep accepted v1 artifacts intact,
re-run a computation, and prove which inputs/outputs changed. It is intentionally
small: no database, no remote state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone

VERSION = "1.0.0"
SCHEMA = "bioflow.artifact-provenance/v1"


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def record(path: str, role: str) -> dict:
    return {"role": role, "path": os.path.abspath(path), "bytes": os.path.getsize(path),
            "sha256": sha256(path)}


def load(path: str) -> dict:
    return json.load(open(path))


def snapshot(args: argparse.Namespace) -> int:
    if os.path.exists(args.manifest) and not args.force:
        print(json.dumps({"error": f"manifest exists: {args.manifest} (use --force to rewrite)"}))
        return 4
    inputs = [record(p, "input") for p in args.input or []]
    outputs = [record(p, "output") for p in args.output or []]
    if not outputs:
        print(json.dumps({"error": "at least one --output is required"}))
        return 2
    payload = {
        "schema": SCHEMA,
        "label": args.label,
        "version": args.version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tool": {"name": "artifact-guard", "version": VERSION, "sha256": sha256(__file__)},
        "inputs": inputs,
        "outputs": outputs,
        "output_hashes": {os.path.basename(o["path"]): o["sha256"] for o in outputs},
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.manifest)) or ".", exist_ok=True)
    json.dump(payload, open(args.manifest, "w"), indent=2)
    print(json.dumps({"manifest": args.manifest, "inputs": len(inputs), "outputs": len(outputs)}))
    return 0


def verify(args: argparse.Namespace) -> int:
    manifest = load(args.manifest)
    rows, changed, missing = [], 0, 0
    for role in ("inputs", "outputs"):
        for item in manifest.get(role) or []:
            path = item["path"]
            if not os.path.exists(path):
                rows.append({"role": role, "path": path, "status": "missing"})
                missing += 1
                continue
            current = sha256(path)
            status = "ok" if current == item["sha256"] else "changed"
            if status == "changed":
                changed += 1
            rows.append({"role": role, "path": path, "status": status,
                         "recorded": item["sha256"], "current": current})
    report = {"manifest": os.path.abspath(args.manifest), "label": manifest.get("label"),
              "version": manifest.get("version"), "ok": changed == 0 and missing == 0,
              "changed": changed, "missing": missing, "files": rows}
    if args.report:
        json.dump(report, open(args.report, "w"), indent=2)
    print(json.dumps(report))
    return 0 if report["ok"] else 3


def publish(args: argparse.Namespace) -> int:
    manifest = load(args.manifest)
    target = os.path.join(args.dest, f"{manifest.get('label')}-{args.version}")
    if os.path.exists(target):
        print(json.dumps({"error": f"target exists: {target}"}))
        return 4
    os.makedirs(target)
    copied = []
    for item in manifest.get("outputs") or []:
        src = item["path"]
        if not os.path.exists(src):
            print(json.dumps({"error": f"missing output: {src}"}))
            return 3
        dest = os.path.join(target, os.path.basename(src))
        shutil.copy2(src, dest)
        copied.append({"file": dest, "sha256": sha256(dest)})
    version_doc = {
        "schema": "bioflow.artifact-version/v1",
        "label": manifest.get("label"), "version": args.version,
        "source_manifest": os.path.abspath(args.manifest),
        "source_manifest_sha256": sha256(args.manifest),
        "published_at": datetime.now(timezone.utc).isoformat(),
        "files": copied,
    }
    json.dump(version_doc, open(os.path.join(target, "version.json"), "w"), indent=2)
    print(json.dumps({"published": target, "files": len(copied)}))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="command", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("--manifest", required=True)
    s.add_argument("--label", required=True)
    s.add_argument("--version", default="v1")
    s.add_argument("--input", action="append")
    s.add_argument("--output", action="append")
    s.add_argument("--force", action="store_true")
    v = sub.add_parser("verify")
    v.add_argument("--manifest", required=True)
    v.add_argument("--report")
    p = sub.add_parser("publish")
    p.add_argument("--manifest", required=True)
    p.add_argument("--version", required=True)
    p.add_argument("--dest", required=True)
    args = ap.parse_args()
    if args.command == "snapshot":
        return snapshot(args)
    if args.command == "verify":
        return verify(args)
    return publish(args)


if __name__ == "__main__":
    raise SystemExit(main())
