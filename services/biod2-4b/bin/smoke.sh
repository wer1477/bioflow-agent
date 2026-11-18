#!/usr/bin/env bash
# 7 个端点各打一次最小请求，确认服务端契约可用（不校验准确率，准确率见 tools/parity.py）。
set -euo pipefail

BASE_URL="${BIOD_BASE_URL:-http://127.0.0.1:8790}"

python3 - "$BASE_URL" <<'PY'
import json, sys, time, urllib.request

base = sys.argv[1]

def post(path, payload, timeout=60):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    started = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode())
    return body, round((time.time() - started) * 1000, 1)

cases = [
    ("/v1/decide", {"requestId": "smoke-tool", "kind": "tool",
                    "state": "帮我查一下这批样本的基因表达矩阵怎么做差异分析",
                    "role": "searcher",
                    "candidates": ["bio-seq", "bio-variant", "context7_query-docs", "lit-review"]}),
    ("/v1/decide", {"requestId": "smoke-kb", "kind": "kb",
                    "state": "单细胞数据怎么挑批次校正方法",
                    "candidates": ["Bioinformatics/anndata", "Bioinformatics/scanpy",
                                   "Bioinformatics/pydeseq2"]}),
    ("/v1/decide/context_retention",
     {"requestId": "smoke-context", "state": "整理 qPCR 结果",
      "groups": [{"seq": 1, "kind": "tool", "tool": "shell", "outcome": "ok",
                  "text": "运行 qPCR 分析脚本，输出 12 个样本的 Ct 值表"},
                 {"seq": 2, "kind": "assistant", "tool": "", "outcome": "ok",
                  "text": "结论：18S 内参稳定，目标基因在病例组上调 2.3 倍"}]}),
    ("/v1/decide/role_select",
     {"requestId": "smoke-role", "state": "这份稿子 Methods 太薄，帮我看看缺什么"}),
    ("/v1/decide/relay_select",
     {"requestId": "smoke-relay", "from": "reviewer", "to": "writer",
      "why": "Methods lacks assay details.",
      "body": "Please add storage duration, freeze-thaw count and tube type."}),
    ("/v1/score-pairs",
     {"requestId": "smoke-premise", "task": "premise_judge",
      "items": [{"id": "p1", "unit": "claim",
                 "left": "The knockout reduces tumor growth by 40%.",
                 "right": "Xenograft volumes were measured weekly for four weeks.",
                 "context": "results"}]}),
    ("/v1/score-pairs",
     {"requestId": "smoke-flag", "task": "overclaim_flag",
      "items": [{"id": "f1", "claim": "This proves the drug is curative in all patients.",
                 "evidence": "Response rate was 31% in a single-arm phase 2 study.",
                 "context": "discussion"}]}),
]

fails = 0
for path, payload in cases:
    tag = payload.get("requestId", path)
    try:
        body, ms = post(path, payload)
        ok = bool(body.get("ok"))
        keys = [k for k in body.keys() if k not in ("ok", "decisionId", "latencyMs", "modelVersion")]
        print(f"{tag:16s} {'OK ' if ok else 'FAIL'} {ms:8.1f}ms  fields={keys}")
        fails += 0 if ok else 1
    except Exception as exc:
        print(f"{tag:16s} ERROR {exc}")
        fails += 1

print("smoke:", "PASS" if fails == 0 else f"{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
PY
