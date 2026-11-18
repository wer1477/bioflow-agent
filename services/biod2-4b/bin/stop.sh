#!/usr/bin/env bash
# 停止由 start.sh --background 启动的 sidecar。
# 注意：由 backend supervisor 拉起的实例不归本脚本管（stop 会提示 pid 不匹配）。
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$SERVICE_DIR/.pid"

if [[ ! -f "$PIDFILE" ]]; then
  echo "no pidfile at $PIDFILE (nothing started by start.sh --background)"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "pid $PID not running; cleaning pidfile"
  rm -f "$PIDFILE"
  exit 0
fi

echo "stopping pid $PID ..."
kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 30); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  echo "still alive after 15s; sending SIGKILL"
  kill -KILL "$PID" 2>/dev/null || true
fi
rm -f "$PIDFILE"
echo "stopped"
