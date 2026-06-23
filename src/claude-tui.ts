// Pure logic for reading and clearing Claude Code's terminal (TUI) dialogs.
//
// Ported from scripts/spawn-workers.sh (wait_ready) and scripts/scan-workers.sh.
// NO IO here — these functions take a captured pane string and return a state, or
// the keystrokes that would clear it. tmux-wrapper.ts carries the keystrokes; the
// spawn/scan/approve tools compose the two. Keeping detection pure makes the
// dialog matrix unit-testable without a live tmux or Claude process.

// A worker pane is classified into exactly one of these states. Priority order
// (see detectPaneState) matters: blocking dialogs are matched before ready/
// running so a pane stuck on a prompt is never misread as "running".
//   trust        — first-run "do you trust the files in this folder" dialog
//   mcp_approval — first-run "new MCP servers found" enable prompt
//   bypass       — bypassPermissions "Yes, I accept" warning (default is "No")
//   blocked      — mid-task tool permission prompt ("Do you want to proceed?")
//   ready        — TUI booted and idle-ready (shows the shortcut / mode hints)
//   running      — actively working (spinner / token counter / "esc to interrupt")
//   idle         — nothing matched (still booting, or an unknown screen)
export type PaneState =
  | "trust"
  | "mcp_approval"
  | "bypass"
  | "blocked"
  | "ready"
  | "running"
  | "idle";

// One tmux send-keys call's worth of key-name args, e.g. ["1", "Enter"].
export type KeyGroup = readonly string[];

const TRUST_RE = /trust the files|do you trust/i;
const MCP_RE = /new MCP servers found|Select any you wish to enable/i;
const BYPASS_RE = /Yes, I accept/i;
const BLOCKED_RE = /do you want to proceed/i;
const READY_RE =
  /for shortcuts|shift\+tab to cycle|accept edits on|bypass permissions on|plan mode on|auto mode on/i;
const RUNNING_RE = /esc to interrupt|tokens|Brewed|Thinking|Working|Running/i;

// Classify a captured pane. Blocking dialogs first (so a stuck pane is never
// reported "running"), then ready before running, then idle as the fallback.
export const detectPaneState = (capture: string): PaneState => {
  if (BLOCKED_RE.test(capture)) return "blocked";
  if (TRUST_RE.test(capture)) return "trust";
  if (MCP_RE.test(capture)) return "mcp_approval";
  if (BYPASS_RE.test(capture)) return "bypass";
  if (READY_RE.test(capture)) return "ready";
  if (RUNNING_RE.test(capture)) return "running";
  return "idle";
};

// The keystroke groups that clear a blocking dialog, in order. Each group is one
// send-keys call; callers pause between groups (the bypass warning needs the "2"
// selection to register before Enter confirms). Non-blocking states return [].
//   trust / blocked -> option 1 (Yes / accept) + Enter
//   mcp_approval    -> bare Enter (servers are pre-checked)
//   bypass          -> "2" (Yes, I accept), then Enter  [default is "1. No, exit"]
export const clearKeystrokes = (state: PaneState): readonly KeyGroup[] => {
  switch (state) {
    case "trust":
    case "blocked":
      return [["1", "Enter"]];
    case "mcp_approval":
      return [["Enter"]];
    case "bypass":
      return [["2"], ["Enter"]];
    default:
      return [];
  }
};

// True once a pane has booted past first-run dialogs and is usable (ready or
// actively running). spawn's bounded clear-loop uses this to know it can stop.
export const isBooted = (state: PaneState): boolean =>
  state === "ready" || state === "running";

// True when the pane is stuck on a dialog that a keystroke can clear.
export const isBlocking = (state: PaneState): boolean =>
  clearKeystrokes(state).length > 0;
