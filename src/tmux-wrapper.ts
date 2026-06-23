// Thin IO wrappers around the tmux CLI.
//
// Every function shells out (side effect) and returns data — no logic. Mirrors
// git-wrapper.ts in shape: each call returns a TmuxResult discriminated union and
// never throws. The pure decisions about WHAT to send (which keys clear which
// dialog) live in claude-tui.ts; this module only carries them to tmux.

import { execFileSync } from "node:child_process";

export type TmuxResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: string };

const runTmux = (args: readonly string[]): TmuxResult => {
  try {
    const stdout = execFileSync("tmux", [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout };
  } catch (err) {
    const msg =
      err && typeof err === "object" && "stderr" in err && err.stderr
        ? String(err.stderr).trim()
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: msg };
  }
};

// `tmux new-session -d -s <name> -x <w> -y <h> -c <cwd>` — detached session,
// fixed geometry so capture-pane output is stable for dialog detection.
export const newSession = (
  name: string,
  cwd: string,
  width: number = 220,
  height: number = 50,
): TmuxResult =>
  runTmux([
    "new-session", "-d",
    "-s", name,
    "-x", String(width),
    "-y", String(height),
    "-c", cwd,
  ]);

// `tmux send-keys -t <target> [-l] <keys...>`. With literal=true the keys are
// sent as raw text (the `-l` flag, for prompt strings); otherwise each entry is
// a tmux key NAME (e.g. "Enter", "1"), so callers can mix characters and keys.
export const sendKeys = (
  target: string,
  keys: readonly string[],
  literal: boolean = false,
): TmuxResult =>
  runTmux(literal
    ? ["send-keys", "-t", target, "-l", ...keys]
    : ["send-keys", "-t", target, ...keys]);

// `tmux capture-pane -t <target> -p` — dump the pane's visible text.
export const capturePane = (target: string): TmuxResult =>
  runTmux(["capture-pane", "-t", target, "-p"]);

// `tmux has-session -t =<name>` — ok:true iff a session with exactly this name
// exists (the `=` forces an exact match, not a prefix match).
export const hasSession = (name: string): TmuxResult =>
  runTmux(["has-session", "-t", `=${name}`]);

// `tmux list-sessions -F '#{session_name}'` — ok carries newline-joined names
// ("" when the server has no sessions). Use splitLines to get an array.
export const listSessions = (): TmuxResult =>
  runTmux(["list-sessions", "-F", "#{session_name}"]);

// `tmux kill-session -t <name>`.
export const killSession = (name: string): TmuxResult =>
  runTmux(["kill-session", "-t", name]);

// `tmux display-message -p -t <target> <format>` — resolve a format string
// (e.g. '#S:#I.#P' -> 'worker-1:0.0') for the given pane/target.
export const displayMessage = (target: string, format: string): TmuxResult =>
  runTmux(["display-message", "-p", "-t", target, format]);

// Pure: split list-sessions stdout into trimmed, non-empty session names.
export const splitLines = (stdout: string): readonly string[] =>
  stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

// IO: resolve THIS process's own pane target ('<session>:<window>.<pane>') from
// $TMUX_PANE, so an instance can record where it lives at register time. Returns
// '' when not running inside tmux (or the lookup fails) — a non-tmux instance
// simply has no wakeable target.
export const currentPaneTarget = (): string => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return "";
  const res = displayMessage(pane, "#S:#I.#P");
  return res.ok ? res.stdout : "";
};
