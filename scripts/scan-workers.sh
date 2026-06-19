#!/usr/bin/env bash
#
# scan-workers.sh — Report InterComm worker tmux sessions and flag any that are
# BLOCKED on a Claude Code permission dialog.
#
# A worker waiting on a permission prompt is frozen — it cannot tell the master
# over InterComm that it is blocked. The master must poll panes to find these.
# This script does that poll in one shot.
#
# Usage:
#   scripts/scan-workers.sh [--prefix worker]
#
# For each matching session it prints one status line:
#   session=<name> state=<blocked|trust|running|idle>
# and, for blocked/trust sessions, the relevant pane excerpt plus the exact
# command to approve it, e.g.:
#   tmux send-keys -t <name> "1" Enter     # 1=Yes  3=No

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

blocked_total=0
for s in "${SESSIONS[@]}"; do
  cap="$(tmux capture-pane -t "$s" -p 2>/dev/null || true)"

  if printf '%s' "$cap" | grep -qi "do you want to proceed"; then
    echo "session=$s state=blocked"
    # Show the tool + command + options block (from the tool header to the hint line).
    printf '%s\n' "$cap" | grep -niE "command|do you want to proceed|❯|^ *[0-9]+\.|Esc to cancel" | sed 's/^/    /'
    echo "    -> approve: tmux send-keys -t $s \"1\" Enter   (1=Yes, 3=No)"
    blocked_total=$((blocked_total + 1))
  elif printf '%s' "$cap" | grep -qiE "trust the files|do you trust"; then
    echo "session=$s state=trust"
    echo "    -> accept: tmux send-keys -t $s \"1\" Enter"
    blocked_total=$((blocked_total + 1))
  elif printf '%s' "$cap" | grep -qiE "esc to interrupt|tokens|Brewed|Thinking|Working|Running"; then
    echo "session=$s state=running"
  else
    echo "session=$s state=idle"
  fi
done

echo
echo "$blocked_total of ${#SESSIONS[@]} worker(s) need attention." >&2
