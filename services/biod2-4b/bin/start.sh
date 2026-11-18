#!/usr/bin/env bash
# biod2 paper1-4B 决策 sidecar —— 手动启动入口。
#
# 正常运行时由 bioflow agent backend 自己拉起（config/biod.json: autoStart=true,
# runtime.entry=biod.multitask.serve）。本脚本用于独立验收、调试与运维，
# 与 backend 的 supervisor 互斥：同一端口只允许一个实例。
#
#   ./bin/start.sh                # 前台运行（Ctrl-C 停止）
#   ./bin/start.sh --background   # 后台运行，pid 写 .pid，日志写 logs/
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEIGHTS="${BIOD_WEIGHTS:-$SERVICE_DIR/weights}"
HOST="${BIOD_HOST:-127.0.0.1}"
PORT="${BIOD_PORT:-8790}"
BIOD_REPO="${BIOFLOW_BIOD_REPO:-/path/to/Biod}"
PY="${BIOFLOW_BIOD_PYTHON:-$BIOD_REPO/.venv/bin/python}"

[ -d "$WEIGHTS" ] || { echo "weights dir missing: $WEIGHTS" >&2; exit 1; }
[ -x "$PY" ] || { echo "python missing: $PY" >&2; exit 1; }

LOG_DIR="$SERVICE_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/serve-$(date +%Y%m%d-%H%M%S).log"

# serve 通过 cwd 解析 base_model 与 Datasets/v2/catalog_snapshot.json
cd "$BIOD_REPO"
export HF_HOME="${HF_HOME:-$BIOD_REPO/.hf_cache}"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export PYTHONUNBUFFERED=1

CMD=("$PY" -m biod.multitask.serve \
  --host "$HOST" --port "$PORT" \
  --ckpt "$WEIGHTS" \
  --device cuda --dtype bfloat16)

if [[ "${1:-}" == "--background" ]]; then
  nohup "${CMD[@]}" >"$LOG" 2>&1 &
  echo $! >"$SERVICE_DIR/.pid"
  echo "started pid $(cat "$SERVICE_DIR/.pid") on ${HOST}:${PORT}"
  echo "log: $LOG"
else
  echo "serving ${WEIGHTS} on ${HOST}:${PORT} (log: $LOG)"
  "${CMD[@]}" 2>&1 | tee "$LOG"
fi
