#!/usr/bin/env python3
"""bulk-contrast v1.0.0: a fixed, auditable two-group contrast on a GEO matrix.

Consumes a geo-contract JSON, a group file and the matrix, and writes a per-gene
table plus a summary. The statistic is deliberately simple and frozen:

  counts (contract scale integer_counts)
      cpm_s = count_s / library_sum_s * 1e6
      x_s   = log2(cpm_s + 1)
  normalized to 1e6 (contract scale normalized_sum_1e6)
      x_s   = log2(value_s + 1)
  any other scale -> refuse (exit 3)

  log2FC = mean(x_treated) - mean(x_control)
  t      = Welch two-sample t statistic
  p      = two-sided p from the t distribution
  q      = Benjamini-Hochberg over all tested genes

Gene filter is declared, not tuned: keep genes with mean raw (or normalized for
the 1e6 branch) value >= --min-mean over all samples in the matrix. Groups must be
covered by the contract; an incomplete join is refused.

Usage:
  bulk_contrast.py run --matrix M --contract C --groups G --out-prefix OUTDIR/contrast
  bulk_contrast.py describe
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone

VERSION = "1.0.0"
METHOD_RAW = "log2_cpm_plus1_welch_bh_v1"
METHOD_DESCRIPTIVE = "log2_value_plus1_descriptive_welch_bh_v1"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_matrix(path: str) -> tuple[list[str], list[list[float]]]:
    data = open(path, "rb").read()
    if path.endswith(".gz"):
        data = gzip.decompress(data)
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = data.decode("utf-16")
    else:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("latin-1")
    lines = [l for l in text.splitlines() if l.strip()]
    idx = next((i for i, l in enumerate(lines) if not l.startswith("#")), 0)
    header_line = lines[idx]
    delim = max(["\t", ",", ";"], key=lambda d: header_line.count(d))
    header = [h.strip().strip('"') for h in header_line.split(delim)]
    rows = []
    for line in lines[idx + 1:]:
        parts = line.split(delim)
        rows.append((parts[0], parts[1:]))
    return header, rows


def welch_t(a: list[float], b: list[float]) -> tuple[float, float]:
    """Return (t, two-sided p). Normal approximation is not used for small n."""
    na, nb = len(a), len(b)
    ma, mb = sum(a) / na, sum(b) / nb
    va = sum((x - ma) ** 2 for x in a) / (na - 1)
    vb = sum((x - mb) ** 2 for x in b) / (nb - 1)
    se2 = va / na + vb / nb
    if se2 <= 0:
        # Zero variance in both groups: no testable difference. Scanpy/DESeq2-style
        # pipelines also leave these untested; return non-finite so the caller drops them.
        return float("nan"), float("nan")
    t = (ma - mb) / math.sqrt(se2)
    df = se2 ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1))
    return t, tdist_two_sided_p(t, df)


def tdist_two_sided_p(t: float, df: float) -> float:
    try:
        from scipy.stats import t as tdist  # type: ignore
        return float(2 * tdist.sf(abs(t), df))
    except Exception:  # noqa: BLE001
        # Regularized incomplete beta via continued fraction (Numerical Recipes).
        x = df / (df + t * t)
        return betainc(df / 2.0, 0.5, x)


def betainc(a: float, b: float, x: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lbeta = math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    front = math.exp(math.log(x) * a + math.log(1 - x) * b - lbeta) / a
    f, c, d = 1.0, 1.0, 0.0
    for i in range(0, 300):
        m = i // 2
        if i == 0:
            num = 1.0
        elif i % 2 == 0:
            num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m))
        else:
            num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))
        d = 1.0 + num * d
        if abs(d) < 1e-30:
            d = 1e-30
        d = 1.0 / d
        c = 1.0 + num / c
        if abs(c) < 1e-30:
            c = 1e-30
        f *= c * d
        if abs(1.0 - c * d) < 1e-12:
            break
    return front * (f - 1.0)


def bh(pvalues: list[float]) -> list[float]:
    m = len(pvalues)
    order = sorted(range(m), key=lambda i: pvalues[i])
    q = [0.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        idx = order[rank - 1]
        val = pvalues[idx] * m / rank
        running = min(running, val)
        q[idx] = min(1.0, running)
    return q


def run(args: argparse.Namespace) -> dict:
    contract = json.load(open(args.contract))
    groups = json.load(open(args.groups))
    scale = contract["scale"]["label"]
    can_raw = bool(contract["scale"].get("can_use_raw_counts"))
    column_groups = bool(groups.get("control_columns") or groups.get("treated_columns"))
    if not column_groups and not contract["join"]["fully_matched"]:
        raise SystemExit("contract join is incomplete; refusing to run a contrast")
    if scale == "raw_counts":
        if not can_raw:
            raise SystemExit("contract label is raw_counts but raw-count eligibility is false")
        raw_branch = True
    elif scale in ("normalized_sum_1e6", "author_normalized_other", "observed_sum_1e6"):
        raw_branch = False
    else:
        raise SystemExit(f"unsupported scale '{scale}'; refusing to guess units")
    if column_groups:
        # Group-level mode: the matrix labels carry the condition/group, but no
        # per-sample GSM identity is claimed. Only column presence and scale are required.
        control_cols = list(dict.fromkeys(groups.get("control_columns") or []))
        treated_cols = list(dict.fromkeys(groups.get("treated_columns") or []))
        if len(control_cols) < 2 or len(treated_cols) < 2:
            raise SystemExit("each group needs at least 2 columns")
        if set(control_cols) & set(treated_cols):
            raise SystemExit("control/treated groups overlap")
    else:
        control = list(dict.fromkeys(groups.get("control") or []))
        treated = list(dict.fromkeys(groups.get("treated") or []))
        if len(control) < 2 or len(treated) < 2:
            raise SystemExit("each group needs at least 2 samples")
        if set(control) & set(treated):
            raise SystemExit("control/treated groups overlap")
        column_of = {p["gsm"]: p["column"] for p in contract["join"]["pairs"] if p["gsm"]}
        for gsm in control + treated:
            if gsm not in column_of:
                raise SystemExit(f"group sample {gsm} is not mapped by the contract")
    header, rows = read_matrix(args.matrix)
    header_index = {h: i for i, h in enumerate(header[1:])}
    if column_groups:
        missing = [c for c in control_cols + treated_cols if c not in header_index]
        if missing:
            raise SystemExit(f"group columns absent from matrix: {missing[:3]}")
        declared = set(contract["matrix"].get("sample_columns") or [])
        undeclared = [c for c in control_cols + treated_cols if declared and c not in declared]
        if undeclared:
            raise SystemExit(f"group columns not declared in contract: {undeclared[:3]}")
        ctrl_idx = [header_index[c] for c in control_cols]
        trt_idx = [header_index[c] for c in treated_cols]
    else:
        missing = [g for g in control + treated if column_of[g] not in header_index]
        if missing:
            raise SystemExit(f"contract columns absent from matrix: {missing[:3]}")
        ctrl_idx = [header_index[column_of[g]] for g in control]
        trt_idx = [header_index[column_of[g]] for g in treated]
    lib = [0.0] * (len(header) - 1)
    for _, vals in rows:
        for j, raw in enumerate(vals):
            try:
                lib[j] += float(raw)
            except (ValueError, IndexError):
                pass
    records = []
    tested = 0
    filtered = 0
    for gene, vals in rows:
        try:
            raw = [float(vals[j]) for j in ctrl_idx + trt_idx]
            all_vals = [float(v) for v in vals]
        except (ValueError, IndexError):
            filtered += 1
            continue
        mean_all = sum(all_vals) / len(all_vals)
        n_c, n_t = len(ctrl_idx), len(trt_idx)
        raw_c, raw_t = raw[:n_c], raw[n_c:]
        if raw_branch:
            x_c = [math.log2(v / lib[j] * 1e6 + 1.0) for v, j in zip(raw_c, ctrl_idx)]
            x_t = [math.log2(v / lib[j] * 1e6 + 1.0) for v, j in zip(raw_t, trt_idx)]
            means = [sum(raw) / len(raw)]
        else:
            x_c = [math.log2(v + 1.0) for v in raw_c]
            x_t = [math.log2(v + 1.0) for v in raw_t]
            means = [sum(raw) / len(raw)]
        if raw_branch:
            if mean_all < args.min_mean:
                filtered += 1
                continue
        elif mean_all <= 0:
            filtered += 1
            continue
        t, p = welch_t(x_t, x_c)
        if not (math.isfinite(t) and math.isfinite(p)):
            filtered += 1
            continue
        records.append({"gene": gene, "mean_control": sum(x_c) / n_c, "mean_treated": sum(x_t) / n_t,
                        "log2FC": sum(x_t) / n_t - sum(x_c) / n_c, "t_stat": t, "p_value": p})
        tested += 1
    qvals = bh([r["p_value"] for r in records])
    for rec, q in zip(records, qvals):
        rec["q_value"] = q
    records.sort(key=lambda r: (r["q_value"], r["p_value"], -abs(r["log2FC"])))
    os.makedirs(os.path.dirname(os.path.abspath(args.out_prefix)) or ".", exist_ok=True)
    csv_path = args.out_prefix + ".csv"
    with open(csv_path, "w") as fh:
        fh.write("gene,mean_control,mean_treated,log2FC,t_stat,p_value,q_value\n")
        for r in records:
            fh.write(f"{r['gene']},{r['mean_control']:.10f},{r['mean_treated']:.10f},"
                     f"{r['log2FC']:.10f},{r['t_stat']:.10f},{r['p_value']:.12e},{r['q_value']:.12e}\n")
    sig = [r for r in records if r["q_value"] < 0.05]
    summary = {
        "schema": "bioflow.contrast/v1",
        "contrast_id": groups.get("id") or os.path.basename(args.out_prefix),
        "method": (METHOD_RAW if raw_branch else METHOD_DESCRIPTIVE),
        "method_class": "log_cpm_ratio" if raw_branch else "descriptive_log",
        "scale_semantics": {"label": scale, "can_use_raw_counts": can_raw},
        "tool": {"name": "bulk-contrast", "version": VERSION, "sha256": sha256_file(__file__)},
        "scale": scale,
        "filter": ({"min_mean": args.min_mean, "rule": "mean over all matrix samples >= min_mean"}
                   if raw_branch else
                   {"min_mean": None, "rule": "mean over all matrix samples > 0 (normalized scale)"}),
        "design": ({"control_columns": control_cols, "treated_columns": treated_cols,
                    "n_control": len(control_cols), "n_treated": len(treated_cols),
                    "mapping": "group_level; no per-sample GSM identity claimed"}
                   if column_groups else
                   {"control": control, "treated": treated,
                    "n_control": len(control), "n_treated": len(treated),
                    "mapping": "sample_level via contract"}),
        "direction": {
            "control": (control_cols if column_groups else control),
            "treated": (treated_cols if column_groups else treated),
            "log2FC": "mean_treated - mean_control",
            "positive_means": "higher in treated",
        },
        "n_genes_total": len(rows), "n_genes_filtered": filtered, "n_genes_tested": tested,
        "n_q_lt_0.05": len(sig),
        "n_up": sum(1 for r in sig if r["log2FC"] > 0),
        "n_down": sum(1 for r in sig if r["log2FC"] < 0),
        "top_gene": records[0]["gene"] if records else None,
        "inputs": {"matrix_sha256": sha256_file(args.matrix), "contract_sha256": sha256_file(args.contract),
                   "groups_sha256": sha256_file(args.groups)},
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    summary_path = args.out_prefix + ".summary.json"
    json.dump(summary, open(summary_path, "w"), indent=2)
    print(json.dumps({"results": csv_path, "summary": summary_path,
                      "n_tested": tested, "n_q_lt_0.05": len(sig)}))
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    r.add_argument("--matrix", required=True)
    r.add_argument("--contract", required=True)
    r.add_argument("--groups", required=True)
    r.add_argument("--out-prefix", required=True)
    r.add_argument("--min-mean", type=float, default=10.0)
    sub.add_parser("describe")
    args = ap.parse_args()
    if args.command == "describe":
        print(json.dumps({"name": "bulk-contrast", "version": VERSION,
                          "methods": {"raw": METHOD_RAW, "descriptive": METHOD_DESCRIPTIVE},
                          "note": "log2(CPM+1) + Welch is a log-ratio test, not a negative-binomial count model",
                          "scales": ["raw_counts", "normalized_sum_1e6", "observed_sum_1e6",
                                     "author_normalized_other"]}))
        return 0
    try:
        run(args)
    except SystemExit as exc:
        print(json.dumps({"error": str(exc)}))
        return 3
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
