#!/usr/bin/env python3
"""Replay the frozen legacy test split through the biod2 sidecar and compare it
with the offline evaluation of the same checkpoint.

Why: paper1 evaluated the 4B checkpoint by encoding dataset rows offline
(`encode_sample`). The bioflow agent talks to the HTTP sidecar instead, where the
same rows are rendered from request payloads. This tool proves the two paths
produce the same decisions before the sidecar is wired into the agent.

For each task we build the payload the agent would send, POST it to the running
service, and report:
  * agreement        -- per-example equality with the offline prediction file
  * service accuracy -- decision quality recomputed from the service responses
  * offline accuracy -- identical function applied to the offline predictions
  * delta            -- service - offline (must stay within 0.5 pp)
  * errors           -- transport failures / "prompt exceeds max_len"

Exit code 0 only when every task agrees >= 99% and |delta| <= 0.5 pp.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter

DEFAULT_REPO = "/path/to/Biod"
DEFAULT_RUN = "artifacts/runs/paper1-4B-s20261104"
TASKS = (
    "tool_select",
    "kb_select",
    "context_retention",
    "role_select",
    "relay_select",
    "premise_judge",
    "overclaim_flag",
)


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


class Client:
    def __init__(self, base_url: str, timeout: float = 120.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout

    def post(self, path: str, payload: dict) -> dict:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.base + path, data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def get(self, path: str) -> dict:
        with urllib.request.urlopen(self.base + path, timeout=30) as resp:
            return json.loads(resp.read().decode())


def gold(gold_label, key):
    if isinstance(gold_label, dict):
        return gold_label.get(key)
    return gold_label


def argmax(scores):
    if not scores:
        return None
    best = max(scores, key=lambda kv: kv[1])
    return best[0]


def run_task(client, task, rows, catalog, tool_ids, kb_ids):
    """Return (predictions, errors) where predictions mirror rows one-to-one."""
    preds, errors = [], []
    for row in rows:
        rid = row["id"]
        try:
            if task == "tool_select":
                body = client.post("/v1/decide", {
                    "requestId": rid, "kind": "tool",
                    "state": row.get("state_text", ""),
                    "role": row.get("role", ""),
                    "candidates": row.get("candidateIds") or tool_ids,
                    "policy": {"tau": 0.0},   # 0.0 = 纯 argmax，与离线评测口径一致
                })
                probs = {s["id"]: s["p"] for s in body.get("scores", [])}
                preds.append({"task": task, "id": rid,
                              "chosen_id": (body.get("chosen") or [None])[0],
                              "confidence": body.get("confidence"),
                              "no_tool_prob": body.get("noToolProb"),
                              "probs": probs})
            elif task == "kb_select":
                body = client.post("/v1/decide", {
                    "requestId": rid, "kind": "kb",
                    "state": row.get("state_text", ""),
                    "role": row.get("role", ""),
                    "candidates": row.get("candidateIds") or kb_ids,
                    "policy": {"tau": 0.0, "topK": 3},
                })
                scores = {s["id"]: s["p"] for s in body.get("scores", [])}
                preds.append({"task": task, "id": rid,
                              "selected": body.get("chosen") or [], "scores": scores})
            elif task == "context_retention":
                body = client.post("/v1/decide/context_retention", {
                    "requestId": rid,
                    "state": row.get("state_text", ""),
                    "groups": row.get("groups", []),
                })
                preds.append({"task": task, "id": rid, "labels": body.get("labels", [])})
            elif task == "role_select":
                body = client.post("/v1/decide/role_select", {
                    "requestId": rid, "state": row.get("state_text", "")})
                preds.append({"task": task, "id": rid, "role": body.get("role"),
                              "confidence": body.get("confidence")})
            elif task == "relay_select":
                body = client.post("/v1/decide/relay_select", {
                    "requestId": rid, "from": row.get("from", ""), "to": row.get("to", ""),
                    "why": row.get("why", ""), "body": row.get("body", "")})
                preds.append({"task": task, "id": rid, "verdict": body.get("verdict"),
                              "confidence": body.get("confidence")})
            elif task in ("premise_judge", "overclaim_flag"):
                item = {"id": rid, "context": row.get("context", "")}
                if task == "premise_judge":
                    item.update({"unit": row.get("unit", "claim"),
                                 "left": row.get("left", ""), "right": row.get("right", "")})
                else:
                    item.update({"claim": row.get("claim", ""), "evidence": row.get("evidence", "")})
                body = client.post("/v1/score-pairs", {"requestId": rid, "task": task, "items": [item]})
                first = (body.get("items") or [{}])[0]
                if task == "premise_judge":
                    preds.append({"task": task, "id": rid, "relation": first.get("label")})
                else:
                    preds.append({"task": task, "id": rid, "flags": first.get("flags") or []})
            else:  # pragma: no cover
                raise ValueError(f"unknown task {task}")
        except Exception as exc:  # noqa: BLE001 - per-row failure must be recorded, not fatal
            errors.append({"task": task, "id": rid, "error": f"{type(exc).__name__}: {exc}"})
            preds.append({"task": task, "id": rid, "error": str(exc)})
    return preds, errors


def compare(task, rows, service, offline):
    """Per-task agreement + accuracy on gold, for both prediction sources."""
    off_by_id = {r["id"]: r for r in offline if r["task"] == task}
    agree = total = 0
    ctx_agree = ctx_total = 0
    mismatches = []

    def hit(pred_row):
        return None

    svc_gold, off_gold = [], []
    for row in rows:
        rid = row["id"]
        s = next((p for p in service if p["id"] == rid), None)
        o = off_by_id.get(rid)
        if s is None or o is None or "error" in s:
            continue
        total += 1
        label = row.get("label")

        if task == "tool_select":
            s_choice, o_choice = s.get("chosen_id"), o.get("chosen_id")
            same = s_choice == o_choice
            g = gold(label, "id")
            svc_gold.append(s_choice == g)
            off_gold.append(o_choice == g)
        elif task == "kb_select":
            s_top = argmax(list((s.get("scores") or {}).items()))
            o_top = argmax(list((o.get("scores") or {}).items()))
            same = s_top == o_top
            g = gold(label, "selected") or []
            svc_gold.append(s_top in g if g else None)
            off_gold.append(o_top in g if g else None)
            if g:
                pass
        elif task == "context_retention":
            s_lab = {x["seq"]: x["label"] for x in s.get("labels", [])}
            o_lab = {x["seq"]: x["label"] for x in o.get("labels", [])}
            for seq in set(s_lab) | set(o_lab):
                ctx_total += 1
                if s_lab.get(seq) == o_lab.get(seq):
                    ctx_agree += 1
            same = True  # row 级一致率由 group 级汇总，不单独计
            for item in (label or []):
                seq = item["seq"]
                svc_gold.append(s_lab.get(seq) == item["label"])
                off_gold.append(o_lab.get(seq) == item["label"])
        elif task == "role_select":
            same = s.get("role") == o.get("role")
            g = gold(label, "role")
            svc_gold.append(s.get("role") == g)
            off_gold.append(o.get("role") == g)
        elif task == "relay_select":
            same = s.get("verdict") == o.get("verdict")
            g = gold(label, "verdict")
            svc_gold.append(s.get("verdict") == g)
            off_gold.append(o.get("verdict") == g)
        elif task == "premise_judge":
            same = s.get("relation") == o.get("relation")
            g = gold(label, "relation")
            svc_gold.append(s.get("relation") == g)
            off_gold.append(o.get("relation") == g)
        elif task == "overclaim_flag":
            s_flags = sorted(s.get("flags") or [])
            o_flags = sorted(o.get("flags") or [])
            same = s_flags == o_flags
            g = sorted(gold(label, "flags") or [])
            svc_gold.append(s_flags == g)
            off_gold.append(o_flags == g)
        else:  # pragma: no cover
            same = False

        agree += 1 if same else 0
        if not same and len(mismatches) < 3:
            mismatches.append({"id": rid, "service": s, "offline": {
                k: v for k, v in o.items() if k in ("chosen_id", "role", "verdict",
                                                    "relation", "flags", "labels", "scores")
            }})

    svc_pairs = [x for x in svc_gold if x is not None]
    off_pairs = [x for x in off_gold if x is not None]
    if task == "context_retention":
        agreement = round(ctx_agree / ctx_total, 6) if ctx_total else None
    else:
        agreement = round(agree / total, 6) if total else None
    return {
        "rows": total,
        "agreement": agreement,
        "agreement_unit": "group" if task == "context_retention" else "row",
        "service_accuracy": round(sum(svc_pairs) / len(svc_pairs), 6) if svc_pairs else None,
        "offline_accuracy": round(sum(off_pairs) / len(off_pairs), 6) if off_pairs else None,
        "delta_pp": round((sum(svc_pairs) / len(svc_pairs) - sum(off_pairs) / len(off_pairs)) * 100, 3)
        if svc_pairs and off_pairs else None,
        "mismatch_samples": mismatches,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8790")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--run", default=DEFAULT_RUN)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "parity-report.json"))
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 行/任务（调试用）")
    args = ap.parse_args()

    client = Client(args.base_url)
    health = client.get("/v1/health")
    if not health.get("ok"):
        print(f"service not ready: {health}", file=sys.stderr)
        return 2

    snap = json.load(open(os.path.join(args.repo, "Datasets/v2/catalog_snapshot.json"), encoding="utf-8"))
    tool_ids = [t["id"] if isinstance(t, dict) else t for t in snap["tools"]]
    kb_ids = [k["id"] if isinstance(k, dict) else k for k in snap["knowledge"]]

    test_dir = os.path.join(args.repo, "Datasets/paper1/legacy-test")
    off_path = os.path.join(args.repo, args.run, "../models/paper1-4B-s20261104/legacy_7task_predictions.jsonl")
    off_path = os.path.normpath(os.path.join(args.repo, "artifacts/eval/paper1/models/paper1-4B-s20261104/"
                                                       "legacy_7task_predictions.jsonl"))
    offline = read_jsonl(off_path)

    started = time.time()
    report = {
        "schema": "bioflow.biod2-parity/v1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "base_url": args.base_url,
        "run": args.run,
        "health": {k: health.get(k) for k in ("modelVersion", "ckptPath", "ckptSha256",
                                              "ckptFiles", "ckptBytes", "loadedAt")},
        "tasks": {},
        "errors": [],
        "ok": True,
    }

    for task in TASKS:
        rows = read_jsonl(os.path.join(test_dir, f"{task}_test.jsonl"))
        if args.limit:
            rows = rows[: args.limit]
        t0 = time.time()
        service, errors = run_task(client, task, rows, snap, tool_ids, kb_ids)
        stats = compare(task, rows, service, offline)
        stats["errors"] = len(errors)
        stats["elapsed_s"] = round(time.time() - t0, 1)
        report["tasks"][task] = stats
        report["errors"].extend(errors)
        print(f"{task:18s} rows={stats['rows']:4d} agree={stats['agreement']} "
              f"svc={stats['service_accuracy']} off={stats['offline_accuracy']} "
              f"delta={stats['delta_pp']}pp err={len(errors)} ({stats['elapsed_s']}s)")

    for task, stats in report["tasks"].items():
        if stats["agreement"] is None or stats["agreement"] < 0.99:
            report["ok"] = False
        if stats["delta_pp"] is not None and abs(stats["delta_pp"]) > 0.5:
            report["ok"] = False
    if report["errors"]:
        report["ok"] = False

    report["elapsed_s"] = round(time.time() - started, 1)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    print(f"\nparity: {'PASS' if report['ok'] else 'FAIL'}  ({report['elapsed_s']}s) -> {args.out}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
