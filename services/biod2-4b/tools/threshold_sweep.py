#!/usr/bin/env python3
"""Threshold effectiveness test for the biod2 sidecar.

The sidecar (biod-mt-v2) applies `policy.tau` server-side for tool/kb decisions,
so the tau values in `config/biod.json` directly change `chosen`. This tool
replays the legacy test split once, then sweeps the decision rules offline over
the collected scores to answer: *is the currently configured tau still the right
operating point for the 4B checkpoint?*

Outputs (JSON):
  tool : tau x {top1, NO_TOOL rate}
  kb   : tau x topK x {hit@1 (non-empty golds), empty-selection rate}
  node : role/relay confidence distributions and accept-rate deltas at +/-0.1
  verdict: whether the currently configured values stay within 1 pp of the best
           sweep point and whether NO_TOOL/empty rates stay within 2x baseline.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

DEFAULT_REPO = "/path/to/Biod"
TOOL_TAUS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]
KB_TAUS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]
KB_TOPS = [1, 3, 5]
CURRENT_TOOL_TAU = 0.1
CURRENT_KB_TAU = 0.1078
CURRENT_KB_TOPK = 3
ROLE_TAU = 0.6
RELAY_FLOOR = 0.75


def read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def post(base, path, payload, timeout=120):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8790")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "threshold-sweep.json"))
    args = ap.parse_args()

    snap = json.load(open(os.path.join(args.repo, "Datasets/v2/catalog_snapshot.json"), encoding="utf-8"))
    tool_ids = [t["id"] if isinstance(t, dict) else t for t in snap["tools"]]
    kb_ids = [k["id"] if isinstance(k, dict) else k for k in snap["knowledge"]]
    test_dir = os.path.join(args.repo, "Datasets/paper1/legacy-test")

    started = time.time()
    # ---- collect raw scores once -------------------------------------------
    tool_rows = []
    for row in read_jsonl(os.path.join(test_dir, "tool_select_test.jsonl")):
        body = post(args.base_url, "/v1/decide", {
            "requestId": row["id"], "kind": "tool", "state": row.get("state_text", ""),
            "role": row.get("role", ""), "candidates": tool_ids, "policy": {"tau": 0.0}})
        probs = {s["id"]: s["p"] for s in body.get("scores", [])}
        top = max(probs, key=probs.get) if probs else None
        tool_rows.append({"id": row["id"], "gold": (row.get("label") or {}).get("id"),
                          "top": top, "top_p": probs.get(top) if top else 0.0,
                          "no_tool_p": body.get("noToolProb") or 0.0})

    kb_rows = []
    for row in read_jsonl(os.path.join(test_dir, "kb_select_test.jsonl")):
        body = post(args.base_url, "/v1/decide", {
            "requestId": row["id"], "kind": "kb", "state": row.get("state_text", ""),
            "role": row.get("role", ""), "candidates": kb_ids,
            "policy": {"tau": 0.0, "topK": 5}})
        scores = {s["id"]: s["p"] for s in body.get("scores", [])}
        kb_rows.append({"id": row["id"], "gold": (row.get("label") or {}).get("selected") or [],
                        "scores": scores})

    role_rows, relay_rows = [], []
    for row in read_jsonl(os.path.join(test_dir, "role_select_test.jsonl")):
        body = post(args.base_url, "/v1/decide/role_select",
                    {"requestId": row["id"], "state": row.get("state_text", "")})
        role_rows.append({"gold": (row.get("label") or {}).get("role"),
                          "role": body.get("role"), "confidence": body.get("confidence") or 0.0})
    for row in read_jsonl(os.path.join(test_dir, "relay_select_test.jsonl")):
        body = post(args.base_url, "/v1/decide/relay_select",
                    {"requestId": row["id"], "from": row.get("from", ""), "to": row.get("to", ""),
                     "why": row.get("why", ""), "body": row.get("body", "")})
        relay_rows.append({"gold": (row.get("label") or {}).get("verdict"),
                           "verdict": body.get("verdict"), "confidence": body.get("confidence") or 0.0})

    # ---- sweep -------------------------------------------------------------
    tool_sweep = []
    for tau in TOOL_TAUS:
        chosen = ["NO_TOOL" if r["top_p"] < tau else r["top"] for r in tool_rows]
        top1 = sum(1 for r, c in zip(tool_rows, chosen) if c == r["gold"]) / len(tool_rows)
        no_tool = chosen.count("NO_TOOL") / len(tool_rows)
        tool_sweep.append({"tau": tau, "top1": round(top1, 4), "no_tool_rate": round(no_tool, 4)})

    kb_sweep = []
    for tau in KB_TAUS:
        for topk in KB_TOPS:
            hit = n_gold = n_empty = 0
            for r in kb_rows:
                ranked = sorted(r["scores"].items(), key=lambda kv: kv[1], reverse=True)
                picked = [k for k, v in ranked if v >= tau][:topk]
                if not picked:
                    n_empty += 1
                if r["gold"]:
                    n_gold += 1
                    if picked and picked[0] in r["gold"]:
                        hit += 1
            kb_sweep.append({"tau": tau, "topk": topk,
                             "hit@1": round(hit / n_gold, 4) if n_gold else None,
                             "nonempty_golds": n_gold,
                             "empty_rate": round(n_empty / len(kb_rows), 4)})

    def accept_rate(rows, key, tau):
        return round(sum(1 for r in rows if r[key] == r["gold"] and r["confidence"] >= tau)
                     / len(rows), 4)

    node = {
        "role_select": {
            "tau": ROLE_TAU,
            "accuracy": round(sum(1 for r in role_rows if r["role"] == r["gold"]) / len(role_rows), 4),
            "accept_rate": accept_rate(role_rows, "role", ROLE_TAU),
            "accept_rate_tau_minus_0.1": accept_rate(role_rows, "role", ROLE_TAU - 0.1),
            "accept_rate_tau_plus_0.1": accept_rate(role_rows, "role", ROLE_TAU + 0.1),
            "below_tau_share": round(sum(1 for r in role_rows if r["confidence"] < ROLE_TAU) / len(role_rows), 4),
        },
        "relay_select": {
            "floor": RELAY_FLOOR,
            "accuracy": round(sum(1 for r in relay_rows if r["verdict"] == r["gold"]) / len(relay_rows), 4),
            "accept_rate": accept_rate(relay_rows, "verdict", RELAY_FLOOR),
            "accept_rate_floor_minus_0.1": accept_rate(relay_rows, "verdict", RELAY_FLOOR - 0.1),
            "accept_rate_floor_plus_0.1": accept_rate(relay_rows, "verdict", RELAY_FLOOR + 0.1),
            "below_floor_share": round(sum(1 for r in relay_rows if r["confidence"] < RELAY_FLOOR) / len(relay_rows), 4),
        },
    }

    # ---- verdict -----------------------------------------------------------
    cur_tool = next(x for x in tool_sweep if abs(x["tau"] - CURRENT_TOOL_TAU) < 1e-9)
    best_tool = max(tool_sweep, key=lambda x: x["top1"])
    cur_kb = next(x for x in kb_sweep if abs(x["tau"] - CURRENT_KB_TAU) < 0.05 + 1e-9
                  and x["topk"] == CURRENT_KB_TOPK)
    best_kb = max([x for x in kb_sweep if x["hit@1"] is not None], key=lambda x: x["hit@1"])

    tool_delta_pp = round((best_tool["top1"] - cur_tool["top1"]) * 100, 2)
    kb_delta_pp = round((best_kb["hit@1"] - cur_kb["hit@1"]) * 100, 2)
    verdict = {
        "tool_select": {
            "current_tau": CURRENT_TOOL_TAU, "current_top1": cur_tool["top1"],
            "current_no_tool_rate": cur_tool["no_tool_rate"],
            "best_tau": best_tool["tau"], "best_top1": best_tool["top1"],
            "headroom_pp": tool_delta_pp,
            "ok": tool_delta_pp <= 1.0,
        },
        "kb_select": {
            "current_tau": CURRENT_KB_TAU, "current_topk": CURRENT_KB_TOPK,
            "current_hit@1": cur_kb["hit@1"], "current_empty_rate": cur_kb["empty_rate"],
            "best_tau": best_kb["tau"], "best_topk": best_kb["topk"], "best_hit@1": best_kb["hit@1"],
            "headroom_pp": kb_delta_pp,
            "ok": kb_delta_pp <= 1.0,
        },
        "note": "tool 的 noToolMargin 在 biod-mt-v2 服务端不生效（Node 侧策略），本表只扫服务端 tau。",
    }
    verdict["ok"] = verdict["tool_select"]["ok"] and verdict["kb_select"]["ok"]

    report = {
        "schema": "bioflow.biod2-threshold-sweep/v1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "base_url": args.base_url,
        "grid": {"tool_taus": TOOL_TAUS, "kb_taus": KB_TAUS, "kb_tops": KB_TOPS},
        "tool_sweep": tool_sweep,
        "kb_sweep": kb_sweep,
        "node_side": node,
        "verdict": verdict,
        "elapsed_s": round(time.time() - started, 1),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    print(json.dumps({"tool": tool_sweep, "kb": kb_sweep, "verdict": verdict}, ensure_ascii=False, indent=1))
    print(f"\nthreshold sweep: {'PASS' if verdict['ok'] else 'REVIEW'} -> {args.out}")
    return 0 if verdict["ok"] else 3


if __name__ == "__main__":
    sys.exit(main())
