#!/usr/bin/env python3
"""geo-contract v1.0.0: auditable GEO matrix/sample contract.

Given a GEO supplementary matrix and its SOFT family text, decide which matrix
columns are which samples and what scale the values are on. The tool is allowed
to say "unresolved": it never invents a join from position alone.

Commands
  inspect --matrix PATH --soft PATH --out PATH [--synonyms PATH] [--dataset-id ID]
          [--strict]

Exit codes: 0 analysed, 2 input/parse error, 3 --strict and join incomplete.
Output: JSON contract (schema bioflow.contract/v1).

Design notes
  * Encoding, delimiter, comment lines and annotation columns are detected, because
    GEO submissions mix ';'-delimited CSV, UTF-16 tables and featureCounts headers.
  * Join evidence is layered: exact -> normalized -> declared synonym subset.
    Positional agreement is reported only as a diagnostic.
  * Scale labels come from observed per-column sums and integer density:
    integer_counts / normalized_sum_1e6 / author_normalized_other.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

VERSION = "1.0.0"
SCHEMA = "bioflow.contract/v1"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_text(path: str) -> tuple[str, str]:
    data = open(path, "rb").read()
    if path.endswith(".gz"):
        data = gzip.decompress(data)
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16"), "utf-16"
    try:
        text = data.decode("utf-8-sig")
        if text.count("\x00") > len(text) * 0.05:
            raise UnicodeDecodeError("utf-8", b"", 0, 1, "nul-heavy")
        return text, "utf-8"
    except UnicodeDecodeError:
        if data[:1] == b"\x00" or data[1:2] == b"\x00":
            enc = "utf-16-le" if data[1:2] == b"\x00" else "utf-16-be"
            return data.decode(enc), enc
        return data.decode("latin-1"), "latin-1"


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def tokens(text: str) -> list[str]:
    return normalize(text).split()


def load_synonyms(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    raw = json.load(open(path))
    return {str(k): str(v) for k, v in raw.items()}


def expand(text: str, synonyms: dict[str, str]) -> list[str]:
    # Raw keys drive phrase substitution (zf14_6); normalized keys drive single tokens.
    raw = {k.lower(): v.lower() for k, v in synonyms.items()}
    low = text.lower()
    for key, value in raw.items():
        if re.search(r"[^a-z0-9]", key):
            low = re.sub(re.escape(key), " " + value + " ", low)
    syn = {normalize(k): normalize(v) for k, v in synonyms.items()}
    out = []
    for tok in tokens(low):
        out.extend(tokens(syn.get(tok, tok)))
    return out


def parse_soft(path: str) -> dict:
    text, encoding = read_text(path)
    series: dict[str, list[str]] = {}
    samples = []
    current = series
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        if line.startswith("^SERIES"):
            current = series
        elif line.startswith("^SAMPLE"):
            current = {"gsm": line.split("=", 1)[1].strip(), "fields": {}}
            samples.append(current)
        elif line.startswith("!") and "=" in line:
            key, value = line[1:].split("=", 1)
            target = series if current is series else current["fields"]
            target.setdefault(key.strip(), []).append(value.strip())
    return {"encoding": encoding, "series": series, "samples": samples}


def sample_record(sample: dict) -> dict:
    fields = sample["fields"]
    desc = fields.get("Sample_description", []) or []
    library = ""
    for line in desc:
        m = re.match(r"(?i)library name:\s*(.+)", line.strip())
        if m:
            library = m.group(1).strip()
    chars = {}
    for item in fields.get("Sample_characteristics_ch1", []) or []:
        if ":" in item:
            k, v = item.split(":", 1)
            chars[k.strip().lower()] = v.strip()
    return {
        "gsm": sample["gsm"],
        "title": " ".join(fields.get("Sample_title", []) or []),
        "library_name": library,
        "description": desc,
        "genotype": chars.get("genotype", ""),
        "treatment": chars.get("treatment", ""),
        "protocol": chars.get("protocol", ""),
        "characteristics": chars,
    }


def column_variants(col: str) -> list[str]:
    base = col.replace("\\", "/").rsplit("/", 1)[-1]
    out = [col, base]
    for suffix in (".highQ.bam", ".bam", ".sam"):
        if base.endswith(suffix):
            out.append(base[: -len(suffix)])
    return [x for x in dict.fromkeys(out) if x]


def match_column(col: str, samples: list[dict], synonyms: dict[str, str]) -> dict:
    exact, norm, subset, evidence = [], [], [], []
    for s in samples:
        strings = [s["title"], s["library_name"], *s["description"]]
        strings += [re.sub(r"(?i)^library name:\s*", "", x) for x in s["description"]]
        for variant in column_variants(col):
            if variant in strings:
                exact.append(s["gsm"])
                evidence.append(f"exact:{s['gsm']}:{variant}")
            nv = normalize(variant)
            if nv and nv in {normalize(x) for x in strings if x}:
                norm.append(s["gsm"])
            col_tokens = expand(variant, synonyms)
            if len(col_tokens) >= 2:
                for x in strings:
                    if set(col_tokens) <= set(expand(x, synonyms)):
                        subset.append(s["gsm"])
                        break
    status, gsm = "unresolved", None
    if len(set(exact)) == 1:
        status, gsm = "exact", exact[0]
    elif len(set(norm)) == 1:
        status, gsm = "normalized", norm[0]
    elif len(set(subset)) == 1:
        status, gsm = "declared_subset", subset[0]
    elif set(exact) or set(norm) or set(subset):
        status = "ambiguous"
    return {"column": col, "gsm": gsm, "status": status,
            "candidates": {"exact": sorted(set(exact)), "normalized": sorted(set(norm)),
                           "declared_subset": sorted(set(subset))},
            "declared_evidence": evidence[:1]}


def read_matrix(path: str) -> dict:
    text, encoding = read_text(path)
    lines = text.splitlines()
    comments = [l for l in lines[:5] if l.startswith("#")]
    idx = next((i for i, l in enumerate(lines) if l.strip() and not l.startswith("#")), 0)
    header_line = lines[idx]
    delim = max(["\t", ",", ";"], key=lambda d: header_line.count(d))
    header = [h.strip().strip('"') for h in header_line.split(delim)]
    rows = []
    for line in lines[idx + 1:]:
        if line.strip():
            rows.append(line.split(delim))
    numeric = []
    for j in range(len(header) - 1):
        ok = total = 0
        for row in rows[:300]:
            if j + 1 >= len(row):
                continue
            total += 1
            try:
                float(row[j + 1])
                ok += 1
            except ValueError:
                pass
        numeric.append(ok / total if total else 0.0)
    return {"encoding": encoding, "delimiter": {"\t": "tab", ",": "comma", ";": "semicolon"}[delim],
            "comments": comments, "header": header, "rows": rows, "numeric_fraction": numeric}



RAW_EVIDENCE = re.compile(
    r"(read counts?|raw counts?|raw gene counts?|gene[- ]level read counts?|"
    r"htseq|featurecounts|feature counts|summarizeoverlaps|count matrix)", re.I)
NORM_EVIDENCE = re.compile(
    r"(\btpm\b|\bfpkm\b|\brpkm\b|\bcpm\b|normaliz|1e6|1,000,000|stringtie|quantif)", re.I)
COUNT_FILE = re.compile(r"(read.?count|raw.*count|counts?\.(matrix|txt|csv|tsv))", re.I)
NORM_FILE = re.compile(r"(\btpm\b|\bfpkm\b|\brpkm\b|\bcpm\b)", re.I)


def processing_evidence(soft_path: str, matrix_path: str, matrix_comments: list[str]) -> list[dict]:
    """Locatable scale statements: SOFT data_processing lines + matrix header comments."""
    out = []
    for number, line in enumerate(open(soft_path, errors="replace"), 1):
        if line.startswith("!Sample_data_processing =") or line.startswith("!Series_data_processing ="):
            out.append({"source": "soft", "line": number,
                        "text": line.split("=", 1)[1].strip()})
    for comment in matrix_comments:
        out.append({"source": "matrix_comment", "line": None, "text": comment.strip()})
    out.append({"source": "matrix_filename", "line": None,
                "text": os.path.basename(matrix_path)})
    return out


def classify_scale(evidence: list[dict], matrix_name: str, integer_like: bool,
                   near_million: bool, declared_override: str | None) -> dict:
    """Separate observed value form from the declared/processing scale."""
    raw_hits = [e for e in evidence if RAW_EVIDENCE.search(e["text"])]
    norm_hits = [e for e in evidence if NORM_EVIDENCE.search(e["text"])]
    file_norm = bool(NORM_FILE.search(matrix_name))
    file_count = bool(COUNT_FILE.search(matrix_name))
    if declared_override:
        declared = declared_override
        declared_source = "cli_declared"
    elif raw_hits and file_norm:
        declared = "metadata_conflict"
        declared_source = "evidence_conflict"
    elif raw_hits and file_count:
        declared = "raw_counts"
        declared_source = "processing_evidence"
    elif raw_hits:
        declared = "raw_counts" if not file_norm else "metadata_conflict"
        declared_source = "processing_evidence"
    elif norm_hits or file_norm:
        declared = "normalized"
        declared_source = "processing_evidence"
    else:
        declared = "unknown"
        declared_source = "none"
    # Numeric consistency only; appearance never grants raw-count eligibility.
    consistent = None
    warnings = []
    if declared == "raw_counts":
        # A documented raw-count matrix that was downsampled can have integer values
        # and a total of exactly 1e6 per column. Sum ~1e6 alone is neither proof of
        # normalization nor counterevidence against a sufficiently documented raw claim.
        if not integer_like:
            label, consistent = "observed_non_integer", False
            warnings.append("processing claims counts but values are not integer-like")
        else:
            label, consistent = "raw_counts", True
            if near_million:
                warnings.append("column sums are ~1e6 but the count-processing evidence is explicit; "
                                "treated as documented raw totals, not as evidence of normalization")
    elif declared == "normalized":
        label = "normalized_sum_1e6" if near_million else "author_normalized_other"
        consistent = True
    elif declared == "metadata_conflict":
        label = "observed_sum_1e6" if near_million else "observed_non_integer"
        consistent = False
        warnings.append("SOFT processing and matrix filename/value form disagree; "
                        "scale label stays observational, raw-count use is denied")
    else:
        label = ("observed_sum_1e6" if near_million else
                 ("observed_integer" if integer_like else "observed_non_integer"))
        consistent = None
        if integer_like and not near_million:
            warnings.append("integer appearance alone does not establish raw counts; "
                            "no locatable count-processing evidence")
    can_raw = declared == "raw_counts" and consistent is True and integer_like
    method_class = ("count_model_cpm_log" if can_raw else
                    ("descriptive_log" if label in ("normalized_sum_1e6", "observed_sum_1e6",
                                                    "author_normalized_other") else "none"))
    return {"label": label, "declared": declared, "declared_source": declared_source,
            "consistent": consistent, "can_use_raw_counts": can_raw,
            "method_class": method_class,
            "raw_evidence": [{"source": e["source"], "line": e["line"], "text": e["text"][:240]}
                             for e in raw_hits[:4]],
            "normalized_evidence": [{"source": e["source"], "line": e["line"], "text": e["text"][:240]}
                                    for e in norm_hits[:4]],
            "warnings": warnings}


def analyze(args: argparse.Namespace) -> dict:
    synonyms = load_synonyms(args.synonyms)
    soft = parse_soft(args.soft)
    samples = [sample_record(s) for s in soft["samples"]]
    mat = read_matrix(args.matrix)
    header, rows = mat["header"], mat["rows"]
    numeric_idx = [i for i, f in enumerate(mat["numeric_fraction"]) if f >= 0.95]
    # Sample columns from metadata evidence first; numeric left-to-right only as fallback.
    chosen, seen = [], set()
    for i in numeric_idx:
        m = match_column(header[i + 1], samples, synonyms)
        if m["gsm"] and m["gsm"] not in seen:
            chosen.append(i)
            seen.add(m["gsm"])
    selection = "metadata_match" if len(chosen) == len(samples) else "leftmost_numeric"
    if selection == "leftmost_numeric":
        chosen = numeric_idx[: len(samples)]
    cols = [header[i + 1] for i in chosen]
    sums = [0.0] * len(chosen)
    detected = [0] * len(chosen)
    values: list[list[float]] = [[] for _ in chosen]
    non_integer = [0] * len(chosen)
    for row in rows:
        for k, j in enumerate(chosen):
            if j + 1 >= len(row):
                continue
            try:
                v = float(row[j + 1])
            except ValueError:
                continue
            sums[k] += v
            if v > 0:
                detected[k] += 1
            if not float(v).is_integer():
                non_integer[k] += 1
            values[k].append(v)
    medians = []
    for vals in values:
        ordered = sorted(vals)
        medians.append(round(ordered[len(ordered) // 2], 6) if ordered else None)
    pairs = [match_column(c, samples, synonyms) for c in cols]
    matched = [p for p in pairs if p["gsm"]]
    positional = []
    if len(cols) == len(samples):
        positional = [{"column": c, "gsm": samples[i]["gsm"]} for i, c in enumerate(cols)]
    agree = sum(1 for p in positional if any(p["gsm"] == q["gsm"] for q in pairs if q["column"] == p["column"]))
    near_million = bool(sums) and all(abs(s - 1e6) / 1e6 < 1e-3 for s in sums)
    total_cells = max(1, sum(len(v) for v in values))
    non_integer_total = sum(non_integer)
    integer_like = non_integer_total <= int(0.001 * total_cells)
    evidence = processing_evidence(args.soft, args.matrix, mat["comments"])
    scale_info = classify_scale(evidence, os.path.basename(args.matrix), integer_like,
                                near_million, args.declared_scale)
    scale = scale_info["label"]
    join = {
        "matched": len(matched),
        "unresolved": sum(1 for p in pairs if p["status"] == "unresolved"),
        "ambiguous": sum(1 for p in pairs if p["status"] == "ambiguous"),
        "fully_matched": len(matched) == len(cols) == len(samples),
        "unique_gsms": len({p["gsm"] for p in matched}) == len(matched),
        "status_counts": {s: sum(1 for p in pairs if p["status"] == s)
                          for s in ("exact", "normalized", "declared_subset", "unresolved", "ambiguous")},
        "positional_agreement": f"{agree}/{len(positional)}" if positional else "n/a",
        "pairs": pairs,
    }
    warnings = []
    if selection == "leftmost_numeric":
        warnings.append("sample columns came from numeric position, not metadata; join is diagnostic only")
    if not join["fully_matched"]:
        warnings.append("join incomplete; pass a declared synonym map or treat as unmapped")
    warnings.extend(scale_info["warnings"])
    if scale == "normalized_sum_1e6":
        warnings.append("column sums are ~1e6; do not describe values as raw counts")
    if scale == "author_normalized_other":
        warnings.append("author-normalized values away from 1e6; descriptive use only")
    if scale == "observed_sum_1e6" and scale_info["declared"] == "unknown":
        warnings.append("no declared normalization method; 1e6 sums are an observation, "
                        "not a confirmed TPM/CPM unit")
    if len(set(s["gsm"] for s in samples)) != len(samples):
        warnings.append("duplicate GSM ids in SOFT")
    return {
        "schema": SCHEMA,
        "dataset_id": args.dataset_id or os.path.basename(os.path.dirname(os.path.abspath(args.matrix))),
        "tool": {"name": "geo-contract", "version": VERSION, "sha256": sha256_file(__file__)},
        "matrix": {
            "path_name": os.path.basename(args.matrix),
            "sha256": sha256_file(args.matrix),
            "encoding": mat["encoding"],
            "delimiter": mat["delimiter"],
            "n_rows": len(rows),
            "n_columns_total": len(header) - 1,
            "sample_columns": cols,
            "sample_column_selection": selection,
            "annotation_columns": [header[i + 1] for i in range(len(header) - 1) if i not in chosen],
        },
        "samples": samples,
        "join": join,
        "scale": {
            "label": scale,
            "observed": {
                "value_form": "integer_like" if integer_like else "non_integer_or_rounded",
                "integer_like": integer_like,
                "near_sum_1e6": near_million,
                "sum_range": [round(min(sums), 3), round(max(sums), 3)] if sums else [0, 0],
                "non_integer_cells": non_integer_total,
            },
            "declared": {
                "label": scale_info["declared"],
                "source": scale_info["declared_source"],
                "consistent_with_values": scale_info["consistent"],
                "evidence": scale_info["raw_evidence"] + scale_info["normalized_evidence"],
                "raw_evidence": scale_info["raw_evidence"],
                "normalized_evidence": scale_info["normalized_evidence"],
            },
            "can_use_raw_counts": bool(scale_info["can_use_raw_counts"] and join["fully_matched"]),
            "method_class": scale_info["method_class"],
            "raw_count_eligibility": {
                "rule": "locatable count-processing evidence AND integer-like values AND not sum~1e6",
                "evidence_found": scale_info["declared"] == "raw_counts",
                "value_consistent": scale_info["consistent"],
            },
            "per_column": [
                {"column": c, "gsm": p["gsm"], "sum": round(sums[k], 3),
                 "detected_genes": detected[k], "median": medians[k],
                 "non_integer_cells": non_integer[k]}
                for k, (c, p) in enumerate(zip(cols, pairs))
            ],
        },
        "warnings": warnings,
        "provenance": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "inputs": [
                {"role": "matrix", "path": os.path.abspath(args.matrix), "sha256": sha256_file(args.matrix)},
                {"role": "soft", "path": os.path.abspath(args.soft), "sha256": sha256_file(args.soft)},
                {"role": "synonyms", "path": os.path.abspath(args.synonyms) if args.synonyms else None,
                 "sha256": sha256_file(args.synonyms) if args.synonyms else None},
            ],
            "tool_version": VERSION,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="command", required=True)
    ins = sub.add_parser("inspect")
    ins.add_argument("--matrix", required=True)
    ins.add_argument("--soft", required=True)
    ins.add_argument("--out", required=True)
    ins.add_argument("--synonyms")
    ins.add_argument("--dataset-id")
    ins.add_argument("--declared-scale", choices=["raw_counts", "normalized", "unknown"])
    ins.add_argument("--strict", action="store_true")
    args = ap.parse_args()
    try:
        contract = analyze(args)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}), file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(contract, fh, indent=2)
    print(json.dumps({"out": args.out, "fully_matched": contract["join"]["fully_matched"],
                      "scale": contract["scale"]["label"],
                      "matched": contract["join"]["matched"]}))
    if args.strict and not contract["join"]["fully_matched"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
