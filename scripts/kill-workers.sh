#!/usr/bin/env bash
#
# kill-workers.sh — Kill InterComm worker tmux sessions.
#
# Killing a session terminates its Claude Code process; the worker's MCP server
# exits and (best-effort) deactivates itself in the InterComm DB on exit. To also
# tidy the message table afterward, the master can call intercomm_clear.
#
# Usage:
#   scripts/kill-workers.sh [--prefix worker] [--worktrees] [--project <dir>]
#
# Kills every tmux session whose name starts with "<prefix>-" (default: worker-).
#
# With --worktrees, also runs `git worktree remove --force` for each matching
# worktree under <repo>/../.intercomm-worktrees/ (the layout spawn-workers.sh
# --worktrees creates). --project locates the repo (default: $PWD).

set -euo pipefail

PREFIX="worker"
WORKTREES=0
PROJECT="$PWD"
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?}"; shift 2 ;;
    --worktrees) WORKTREES=1; shift ;;
    --project) PROJECT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'; exit 0 ;;
    *) echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v tmux >/dev/null 2>&1 || { echo "Error: tmux not found" >&2; exit 1; }

mapfile -t SESSIONS < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E "^${PREFIX}-" || true)

if [ "${#SESSIONS[@]}" -eq 0 ]; then
  echo "No worker sessions found (prefix: ${PREFIX}-)."
else
  for s in "${SESSIONS[@]}"; do
    tmux kill-session -t "$s" && echo "killed: $s"
  done
  echo "Killed ${#SESSIONS[@]} worker session(s)."
fi

# --- Remove git worktrees created by spawn-workers.sh --worktrees ---
if [ "$WORKTREES" -eq 1 ]; then
  command -v git >/dev/null 2>&1 || { echo "Error: git not found" >&2; exit 1; }
  git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1 \
    || { echo "Error: --worktrees but $PROJECT is not in a git repo" >&2; exit 1; }
  common="$(git -C "$PROJECT" rev-parse --git-common-dir)"
  case "$common" in /*) ;; *) common="$PROJECT/$common" ;; esac
  SHARED_ROOT="$(cd "$(dirname "$common")" && pwd)"
  WORKTREE_DIR="$(cd "$(dirname "$SHARED_ROOT")" && pwd)/.intercomm-worktrees"
  removed=0
  for s in "${SESSIONS[@]}"; do
    wt="$WORKTREE_DIR/$s"
    if [ -d "$wt" ]; then
      git -C "$SHARED_ROOT" worktree remove --force "$wt" \
        && { echo "removed worktree: $wt"; removed=$((removed + 1)); } \
        || echo "Warning: could not remove worktree $wt" >&2
    fi
  done
  git -C "$SHARED_ROOT" worktree prune
  echo "Removed $removed worktree(s)."
fi
