#!/usr/bin/env bash
# Report disk pressure on the Bioflow host. Read-only: never deletes anything.
#
# Default channel is the local log plus syslog. Set BIOFLOW_DISK_ALERT_WEBHOOK to
# POST {"text": "..."} to a chat webhook. Thresholds and paths are env-overridable.
#
# Usage:
#   check-disk-usage.sh          # cron mode: only logs when a threshold is crossed
#   check-disk-usage.sh --test   # print current usage, never write

set -u

export PATH=/usr/local/bin:/usr/bin:/bin

warn_percent=${BIOFLOW_DISK_WARN_PERCENT:-80}
crit_percent=${BIOFLOW_DISK_CRIT_PERCENT:-90}
cache_warn_gib=${BIOFLOW_CACHE_WARN_GIB:-5}
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/bioagent"
log_file="$state_dir/disk-alert.log"
mode=${1:-}

alerts=()

percent_used() {
  df -P "$1" 2>/dev/null | awk 'NR==2 {gsub(/%/, "", $5); print $5}'
}

dir_gib() {
  du -s -B1 "$1" 2>/dev/null | awk '{printf "%.1f", $1 / 1024 / 1024 / 1024}'
}

check_mount() {
  local mount=$1 label=$2 used
  used=$(percent_used "$mount")
  if [ -z "$used" ]; then
    echo "skip ${label}: cannot stat ${mount}"
    return 0
  fi
  if [ "$mode" = "--test" ]; then
    echo "${label} (${mount}): ${used}% used"
  fi
  if [ "$used" -ge "$crit_percent" ]; then
    alerts+=("CRITICAL ${label} (${mount}) is ${used}% full (threshold ${crit_percent}%)")
  elif [ "$used" -ge "$warn_percent" ]; then
    alerts+=("WARNING ${label} (${mount}) is ${used}% full (threshold ${warn_percent}%)")
  fi
}

check_cache() {
  local size top
  size=$(dir_gib "$HOME/.cache")
  if [ -z "$size" ]; then
    return 0
  fi
  if [ "$mode" = "--test" ]; then
    echo "cache (\$HOME/.cache): ${size} GiB"
  fi
  if awk -v size="$size" -v limit="$cache_warn_gib" 'BEGIN { exit !(size >= limit) }'; then
    top=$(du -sh "$HOME/.cache"/* 2>/dev/null | sort -h | tail -5 | tr '\n' ' ')
    alerts+=("WARNING \$HOME/.cache is ${size} GiB (threshold ${cache_warn_gib} GiB): ${top}")
  fi
}

notify() {
  local priority=$1 message=$2 payload
  printf '%s [%s] %s\n' "$(date -Is)" "$priority" "$message" >> "$log_file"
  logger -t bioagent-disk -p "user.${priority,,}" "$message" 2>/dev/null || true
  if [ -n "${BIOFLOW_DISK_ALERT_WEBHOOK:-}" ] && command -v curl >/dev/null 2>&1; then
    payload=$(python3 -c 'import json, sys; print(json.dumps({"text": sys.argv[1]}))' "$message" 2>/dev/null) || payload=""
    if [ -n "$payload" ]; then
      curl -fsS --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$BIOFLOW_DISK_ALERT_WEBHOOK" >/dev/null 2>&1 || true
    fi
  fi
}

check_mount / "home"
check_mount /data "data"
check_cache

if [ "$mode" = "--test" ]; then
  if [ ${#alerts[@]} -eq 0 ]; then
    echo "all thresholds OK"
  else
    printf '%s\n' "${alerts[@]}"
  fi
  exit 0
fi

if [ ${#alerts[@]} -gt 0 ]; then
  mkdir -p "$state_dir"
  for alert in "${alerts[@]}"; do
    case "$alert" in
      CRITICAL*) notify critical "$alert" ;;
      *) notify warning "$alert" ;;
    esac
  done
fi
