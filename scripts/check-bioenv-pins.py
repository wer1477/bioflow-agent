#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Compare the direct pins in requirements.txt with the active interpreter.

The Bioflow runtime resolves Python packages from `.bioenv`, and a fresh environment
is built from `environment.yml` -> `requirements.txt`. When the existing environment
drifts from those pins, every skill still "works" until a call hits the difference —
the scanpy `hvg -> pca` DLPack failure was exactly one of those (numpy 2.0.2 installed
while requirements already pinned 2.3.5).

Usage:
    .bioenv/bin/python scripts/check-bioenv-pins.py [--json]

Exit codes: 0 all pins match; 1 at least one package is missing or on another version.
Read-only: the script never installs anything.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from importlib import metadata
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = REPOSITORY_ROOT / "requirements.txt"
PIN_PATTERN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)==([^\s;#]+)")


def read_pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        match = PIN_PATTERN.match(line)
        if match:
            pins[match.group(1)] = match.group(2)
    return pins


def installed_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Check .bioenv against requirements.txt pins.")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--requirements", default=str(REQUIREMENTS), help="requirements file to read")
    args = parser.parse_args()

    requirements = Path(args.requirements)
    if not requirements.exists():
        print(f"requirements file not found: {requirements}", file=sys.stderr)
        return 2

    rows = [
        {"package": name, "required": version, "installed": installed_version(name)}
        for name, version in sorted(read_pins(requirements).items())
    ]
    mismatches = [row for row in rows if row["installed"] != row["required"]]

    if args.json:
        print(json.dumps(
            {
                "ok": not mismatches,
                "requirements": str(requirements),
                "checked": len(rows),
                "mismatches": mismatches,
            },
            indent=2,
            ensure_ascii=False,
        ))
    else:
        for row in rows:
            status = "ok " if row["installed"] == row["required"] else "BAD"
            print(f"{status} {row['package']:<16} required={row['required']:<12} installed={row['installed']}")
        if mismatches:
            print("\nThe environment has drifted from requirements.txt. Rebuild or repair it, e.g.:")
            print("  PIP_REQUIRE_VIRTUALENV=false .bioenv/bin/pip install -r requirements.txt")
        else:
            print(f"\n{len(rows)} direct pins match the active interpreter.")

    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
