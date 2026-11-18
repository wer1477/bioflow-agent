#!/usr/bin/env python3
"""biod2 上线后的观测汇总（24h 窗口用）。

读取 backend 内建的决策审计日志（`WORKSPACE_ROOT/.runtime/`），按决策点汇总调用量、
成功率、回落原因、延迟分位，并给出是否触发回退条件的结论。

    python3 tools/observe.py --hours 24

日志文件（agent-client/backend 内建，不由本服务写入）：
  biod-decisions.jsonl        tool / kb / groups(context)
  biod-plan-audit.jsonl       r1.plan-audit
  biod-manuscript-audit.jsonl w1.claim-evidence-audit
  biod-issue-audit.jsonl      v1.issue-triage
  biod-hypothesis-screen.jsonl s2 假设筛选
role_select / relay_select 只写后端结构化日志（`/tmp/bioflow-backend.log`），本脚本按
`POST /v1/decide/role_select|relay_select` 计数。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import statistics
import subprocess
import sys

DEFAULT_RUNTIME = "/path/to/bioflow/agent-client/workspace/.runtime"
DEFAULT_BACKEND_LOG = "/tmp/bioflow-backend.log"

# 回退触发条件（与 services/biod2-4b/README.md 一致）
MAX_FAIL_SHARE = 0.20          # 任一决策点失败/回落占比
MAX_TOOL_P95_MS = 2000.0       # tool 决策 p95 超过 agent 侧超时预算
MAX_NO_TOOL_SHARE = 0.60       # tool 全部弃权的比例（业务上等于 biod 没用了）


def parse_ts(value: str):
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def read_jsonl(path, since):
    rows = []
    if not os.path.isfile(path):
        return rows
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = parse_ts(row.get("ts", ""))
            if since and ts and ts < since:
                continue
            rows.append(row)
    return rows


def summarize(rows):
    ok = sum(1 for r in rows if r.get("ok") is True)
    fail = len(rows) - ok
    lat = [r["latencyMs"] for r in rows if isinstance(r.get("latencyMs"), (int, float))]
    lat.sort()
    def pct(p):
        return round(lat[min(len(lat) - 1, int(len(lat) * p))], 1) if lat else None
    reasons = {}
    for r in rows:
        if r.get("ok") is not True:
            reason = r.get("reason") or (r.get("error") or {}).get("code") or "unknown"
            reasons[reason] = reasons.get(reason, 0) + 1
    no_tool = sum(1 for r in rows if r.get("kind") == "tool"
                  and (r.get("chosen") or []) in (["NO_TOOL"], "NO_TOOL"))
    kb_empty = sum(1 for r in rows if r.get("kind") == "kb" and not (r.get("chosen") or []))
    return {
        "calls": len(rows),
        "ok": ok,
        "fail": fail,
        "fail_share": round(fail / len(rows), 4) if rows else 0.0,
        "p50_ms": pct(0.50),
        "p95_ms": pct(0.95),
        "fail_reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])[:5]),
        "no_tool": no_tool,
        "kb_empty": kb_empty,
    }


def count_pattern(path, pattern):
    if not os.path.isfile(path):
        return 0
    try:
        out = subprocess.run(["grep", "-c", pattern, path], capture_output=True, text=True, timeout=30)
        return int((out.stdout or "0").strip() or 0)
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", default=DEFAULT_RUNTIME)
    ap.add_argument("--backend-log", default=DEFAULT_BACKEND_LOG)
    ap.add_argument("--hours", type=float, default=24.0)
    args = ap.parse_args()

    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=args.hours)
    print(f"window: last {args.hours}h (since {since.isoformat(timespec='seconds')})\n")

    groups = [
        ("tool_select", "biod-decisions.jsonl", {"kind": "tool"}),
        ("kb_select", "biod-decisions.jsonl", {"kind": "kb"}),
        ("context_retention", "biod-decisions.jsonl", {"kind": "groups"}),
        ("r1.plan-audit", "biod-plan-audit.jsonl", None),
        ("w1.claim-evidence-audit", "biod-manuscript-audit.jsonl", None),
        ("v1.issue-triage", "biod-issue-audit.jsonl", None),
        ("s2.hypothesis-screen", "biod-hypothesis-screen.jsonl", None),
    ]

    report = {}
    for point, filename, flt in groups:
        rows = read_jsonl(os.path.join(args.runtime, filename), since)
        if flt:
            rows = [r for r in rows if all(r.get(k) == v for k, v in flt.items())]
        report[point] = summarize(rows)

    for point, pattern in (("role_select", "POST /v1/decide/role_select"),
                           ("relay_select", "POST /v1/decide/relay_select")):
        n = count_pattern(args.backend_log, pattern)
        report[point] = {"calls_total_log_lifetime": n,
                         "note": "后端日志是全量累积，不分窗口；仅作是否接通的佐证"}

    for point, stats in report.items():
        print(f"{point:26s} {json.dumps(stats, ensure_ascii=False)}")

    triggers = []
    for point in ("tool_select", "kb_select", "context_retention", "r1.plan-audit",
                  "w1.claim-evidence-audit", "v1.issue-triage", "s2.hypothesis-screen"):
        stats = report[point]
        if stats["calls"] >= 10 and stats["fail_share"] > MAX_FAIL_SHARE:
            triggers.append(f"{point}: fail_share {stats['fail_share']:.0%} > {MAX_FAIL_SHARE:.0%}")
    tool = report["tool_select"]
    if tool.get("p95_ms") and tool["p95_ms"] > MAX_TOOL_P95_MS:
        triggers.append(f"tool_select: p95 {tool['p95_ms']}ms > {MAX_TOOL_P95_MS}ms")
    if tool.get("calls") and tool["no_tool"] / tool["calls"] > MAX_NO_TOOL_SHARE:
        triggers.append(f"tool_select: NO_TOOL 率 {tool['no_tool'] / tool['calls']:.0%} > {MAX_NO_TOOL_SHARE:.0%}")

    print()
    if triggers:
        print("ROLLBACK TRIGGERS:")
        for t in triggers:
            print(f"  - {t}")
        print("\n回退动作：清空 BIOFLOW_BIOD_CKPT 或 biod.json enabled=false，再重启 backend。")
        return 2
    print("no rollback trigger fired")
    return 0


if __name__ == "__main__":
    sys.exit(main())
