#!/usr/bin/env bash
#
# kill-workers.sh — Kill InterComm worker tmux sessions.
#
# Killing a session terminates its Claude Code process; the worker's MCP server
# exits and (best-effort) deactivates itself in the InterComm DB on exit. To also
# tidy the message table afterward, the master can call intercomm_clear.
#
# Usage:
#   scripts/kill-workers.sh [--prefix worker]
#
# Kills every tmux session whose name starts with "<prefix>-" (default: worker-).

set -euo pipefail

PREFIX="worker"
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'; exit 0 ;;
    *) echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v tmux >/dev/null 2>&1 || { echo "Error: tmux not found" >&2; exit 1; }

mapfile -t SESSIONS < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E "^${PREFIX}-" || true)

if [ "${#SESSIONS[@]}" -eq 0 ]; then
  echo "No worker sessions found (prefix: ${PREFIX}-)."
  exit 0
fi

for s in "${SESSIONS[@]}"; do
  tmux kill-session -t "$s" && echo "killed: $s"
done

echo "Killed ${#SESSIONS[@]} worker session(s)."
