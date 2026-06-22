#!/usr/bin/env bash
#
# spawn-workers.sh — Spawn N Claude Code worker instances in detached tmux
# sessions for InterComm AIMFP.
#
# The master (or the user) runs this once. Each worker:
#   1. boots Claude Code in the project directory (so it loads .mcp.json + CLAUDE.md),
#   2. is auto-woken with a prompt to register via InterComm and read its task,
#   3. reports its tmux-session <-> worker-N mapping back to the master so the
#      master knows which tmux pane corresponds to which InterComm identity.
#
# Workers never poll. After registering they sit idle until the master wakes them
# again via `tmux send-keys`.
#
# Usage:
#   scripts/spawn-workers.sh <count> [options]
#
# Options:
#   --project <dir>      Directory to launch workers in            (default: $PWD)
#   --prefix <name>      tmux session-name prefix                  (default: worker)
#   --perm-mode <mode>   claude --permission-mode value            (default: acceptEdits)
#                        One of: acceptEdits|auto|bypassPermissions|default|dontAsk|plan
#   --bypass             Shortcut for --perm-mode bypassPermissions (fully hands-off)
#   --claude <cmd>       Claude binary to launch                   (default: claude)
#   --ready-timeout <s>  Seconds to wait for each worker to boot   (default: 30)
#   --no-wake            Create + launch only; skip the auto register prompt
#   --worktrees          Launch each worker in its OWN git worktree (branch-per-agent).
#                        Requires --project to be inside a git repo.
#   --worktree-base <r>  Git ref each worktree checks out detached  (default: main)
#   --bootstrap <cmd>    Setup command run inside each new worktree (ctx-style
#                        "worktree bootstrap", e.g. 'npm install')  (default: none)
#   -h, --help           Show this help
#
# Worktrees mode (--worktrees):
#   * Each worker gets git worktree add --detach <repo>/../.intercomm-worktrees/<name>
#     so the branch-per-agent model works (one working tree per agent).
#   * INTERCOMM_DB_ROOT is exported into every worker so they all share ONE
#     intercomm.db at the repo root instead of fragmenting per worktree.
#   * The worker itself makes its branch by running AIMFP git_create_branch inside
#     its worktree — this script only creates the isolated checkout.
#   * Tear down with scripts/kill-workers.sh --worktrees (also runs git worktree remove).
#
# Notes:
#   * Register THIS instance as master (intercomm_register role=master) BEFORE
#     running this script, so workers can message "master" on startup.
#   * Default mode acceptEdits auto-accepts file edits but still prompts for Bash
#     and other tools. A blocked worker is frozen and cannot report over InterComm,
#     so poll panes with scripts/scan-workers.sh and approve via:
#       tmux send-keys -t <session> "1" Enter
#   * Tear down with scripts/kill-workers.sh.

set -euo pipefail

# --- Defaults ---
PROJECT="$PWD"
PREFIX="worker"
PERM_MODE="acceptEdits"
CLAUDE_CMD="claude"
READY_TIMEOUT=30
WAKE=1
WORKTREES=0
WT_BASE="main"
BOOTSTRAP=""

die() { echo "Error: $*" >&2; exit 1; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'; }

# --- Parse args ---
COUNT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="${2:?}"; shift 2 ;;
    --prefix)       PREFIX="${2:?}"; shift 2 ;;
    --perm-mode)    PERM_MODE="${2:?}"; shift 2 ;;
    --bypass)       PERM_MODE="bypassPermissions"; shift ;;
    --claude)       CLAUDE_CMD="${2:?}"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="${2:?}"; shift 2 ;;
    --no-wake)      WAKE=0; shift ;;
    --worktrees)    WORKTREES=1; shift ;;
    --worktree-base) WT_BASE="${2:?}"; shift 2 ;;
    --bootstrap)    BOOTSTRAP="${2:?}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    -*)             die "unknown option: $1" ;;
    *)              [ -z "$COUNT" ] && COUNT="$1" || die "unexpected argument: $1"; shift ;;
  esac
done

# --- Validate ---
[ -n "$COUNT" ] || { usage; die "missing <count>"; }
[[ "$COUNT" =~ ^[1-9][0-9]*$ ]] || die "<count> must be a positive integer (got: $COUNT)"
command -v tmux >/dev/null 2>&1 || die "tmux is not installed or not on PATH"
command -v "$CLAUDE_CMD" >/dev/null 2>&1 || die "claude command '$CLAUDE_CMD' not found on PATH"
[ -d "$PROJECT" ] || die "project directory does not exist: $PROJECT"
PROJECT="$(cd "$PROJECT" && pwd)"  # absolutize

# --- Worktree mode setup: resolve the shared repo root + worktree location ---
SHARED_ROOT=""
WORKTREE_DIR=""
ENV_PREFIX=""
if [ "$WORKTREES" -eq 1 ]; then
  command -v git >/dev/null 2>&1 || die "git is required for --worktrees"
  git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1 \
    || die "--worktrees requires the project to be inside a git repo: $PROJECT"
  # Parent of the COMMON git dir is the main repo root — identical from any worktree.
  common="$(git -C "$PROJECT" rev-parse --git-common-dir)"
  case "$common" in /*) ;; *) common="$PROJECT/$common" ;; esac
  SHARED_ROOT="$(cd "$(dirname "$common")" && pwd)"
  WORKTREE_DIR="$(cd "$(dirname "$SHARED_ROOT")" && pwd)/.intercomm-worktrees"
  ENV_PREFIX="INTERCOMM_DB_ROOT='$SHARED_ROOT' "
  mkdir -p "$WORKTREE_DIR"
  echo "Worktrees mode: shared root=$SHARED_ROOT, worktree dir=$WORKTREE_DIR, base=$WT_BASE" >&2
fi

# --- Pick N free session names ---
pick_names() {
  local want="$1" n=1 chosen=()
  while [ "${#chosen[@]}" -lt "$want" ]; do
    local name="${PREFIX}-${n}"
    if ! tmux has-session -t "=$name" 2>/dev/null; then
      chosen+=("$name")
    fi
    n=$((n + 1))
  done
  printf '%s\n' "${chosen[@]}"
}

# --- Wait until a session's Claude TUI is ready (handles the trust dialog) ---
wait_ready() {
  local s="$1" deadline=$(( SECONDS + READY_TIMEOUT )) cap
  while [ "$SECONDS" -lt "$deadline" ]; do
    cap="$(tmux capture-pane -t "$s" -p 2>/dev/null || true)"
    # First-run trust dialog (only when launched in an untrusted dir) — accept it.
    if printf '%s' "$cap" | grep -qiE "trust the files|do you trust"; then
      tmux send-keys -t "$s" "1" Enter
      sleep 1
      continue
    fi
    # First-run "new MCP servers found" approval (each fresh checkout/worktree is new
    # to Claude) — the servers are pre-checked, so Enter confirms them.
    if printf '%s' "$cap" | grep -qiE "new MCP servers found|Select any you wish to enable"; then
      tmux send-keys -t "$s" Enter
      sleep 1
      continue
    fi
    # Bypass-permissions warning (only with --bypass / bypassPermissions). The DEFAULT
    # selection is "1. No, exit", so a bare Enter would KILL the worker — select option
    # 2 ("Yes, I accept") explicitly, then confirm.
    if printf '%s' "$cap" | grep -qiE "Yes, I accept"; then
      tmux send-keys -t "$s" "2"
      sleep 1
      tmux send-keys -t "$s" Enter
      sleep 1
      continue
    fi
    # Ready markers across permission modes.
    if printf '%s' "$cap" | grep -qiE "for shortcuts|shift\+tab to cycle|accept edits on|bypass permissions on|plan mode on|auto mode on"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# --- Send a prompt to a worker and submit it (double-Enter for Claude Code) ---
send_prompt() {
  local s="$1" text="$2"
  tmux send-keys -t "$s" -l "$text"
  sleep 1
  tmux send-keys -t "$s" Enter
  sleep 1
  tmux send-keys -t "$s" Enter
}

wake_prompt() {
  local s="$1"
  local wt_note=""
  if [ "$WORKTREES" -eq 1 ]; then
    wt_note=" You are in your OWN git worktree (isolated checkout, detached HEAD) — if your task lists required_directives, run the AIMFP git tools (e.g. git_create_branch) INSIDE this worktree and report your branch name back to the master via intercomm_send."
  fi
  printf '%s' \
"You are an InterComm AIMFP worker running in tmux session '$s'. Do NOT interact with the user — all communication goes through InterComm to the master. Steps: (1) Call intercomm_register() to get your worker id. (2) Call intercomm_send(to: \"master\", type: \"status\", message: \"registered as <your worker id> in tmux session $s\") so the master can map you. (3) Call intercomm_read() to get your task and begin. If there is no task yet, stop and wait — the master will wake you.${wt_note}"
}

# --- Main ---
echo "Spawning $COUNT worker(s) in $PROJECT (mode: $PERM_MODE)..." >&2
mapfile -t NAMES < <(pick_names "$COUNT")

# Track each worker's launch dir so the report line can show the worktree path.
declare -A LAUNCH_DIR=()

for s in "${NAMES[@]}"; do
  launch_dir="$PROJECT"
  if [ "$WORKTREES" -eq 1 ]; then
    wt="$WORKTREE_DIR/$s"
    if [ -e "$wt" ]; then
      echo "Warning: worktree path already exists, reusing: $wt" >&2
    else
      git -C "$SHARED_ROOT" worktree add --detach "$wt" "$WT_BASE" >&2 \
        || die "git worktree add failed for $s (base: $WT_BASE)"
    fi
    if [ -n "$BOOTSTRAP" ]; then
      echo "Bootstrapping $s: $BOOTSTRAP" >&2
      ( cd "$wt" && eval "$BOOTSTRAP" ) >&2 \
        || echo "Warning: bootstrap failed for $s (continuing)" >&2
    fi
    launch_dir="$wt"
  fi
  LAUNCH_DIR["$s"]="$launch_dir"
  tmux new-session -d -s "$s" -x 220 -y 50 -c "$launch_dir"
  # ENV_PREFIX pins every worker to the one shared intercomm.db (empty unless --worktrees).
  tmux send-keys -t "$s" "${ENV_PREFIX}$CLAUDE_CMD --permission-mode $PERM_MODE" Enter
done

# Boot + wake each (sequentially, so registration order is stable).
for s in "${NAMES[@]}"; do
  if wait_ready "$s"; then
    ready="yes"
    [ "$WAKE" -eq 1 ] && send_prompt "$s" "$(wake_prompt "$s")"
  else
    ready="no"
    echo "Warning: $s did not signal ready within ${READY_TIMEOUT}s (left running, not woken)" >&2
  fi
  # Machine-readable line for the master to parse.
  echo "session=$s target=$s mode=$PERM_MODE ready=$ready woken=$([ "$WAKE" -eq 1 ] && [ "$ready" = yes ] && echo yes || echo no) worktree=${LAUNCH_DIR[$s]}"
done

echo >&2
echo "Done. ${#NAMES[@]} session(s): ${NAMES[*]}" >&2
if [ "$WAKE" -eq 1 ]; then
  echo "Workers will report their InterComm id via 'status' messages — call intercomm_read or intercomm_status to confirm the session<->id mapping." >&2
else
  echo "Launched without waking. Wake each with: tmux send-keys -t <session> \"<instruction>\" Enter Enter" >&2
fi
