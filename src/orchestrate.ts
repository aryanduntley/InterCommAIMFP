// Multi-agent lifecycle sequences — the glue that retires spawn/scan/kill-workers.sh.
//
// This module SEQUENCES IO: it composes the tmux/git wrappers (raw IO), the pure
// claude-tui dialog decisions, the config path helpers, and the store registry
// into the operations the master drives (spawn / wake / scan / approve / teardown).
// It owns no pure logic of its own beyond pacing — dialog detection/keystrokes
// live in claude-tui, path math in config, persistence in store. Functions return
// plain report data; mcp-server formats it into tool results.

import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { worktreePath } from "./config.js";
import { ensureDir } from "./fs-wrapper.js";
import { addWorktree, removeWorktree } from "./git-wrapper.js";
import * as tmux from "./tmux-wrapper.js";
import {
  detectPaneState,
  clearKeystrokes,
  isBlocking,
  isBooted,
  type PaneState,
} from "./claude-tui.js";
import * as store from "./store.js";

// --- Report / option contracts ---

export type SpawnOptions = {
  readonly root: string;          // shared DB root (exported as INTERCOMM_DB_ROOT)
  readonly count: number;
  readonly prefix: string;        // tmux session-name prefix (default "worker")
  readonly permMode: string;      // claude --permission-mode value
  readonly claudeCmd: string;     // claude binary
  readonly worktrees: boolean;    // one git worktree per worker
  readonly worktreeBase: string;  // ref each worktree checks out detached
  readonly bootstrap: string;     // setup command per worktree ('' = none)
  readonly readyTimeoutMs: number;// bounded dialog-clear window per session
  readonly wake: boolean;         // fire the register prompt after boot
};

export type SpawnReport = {
  readonly session: string;
  readonly state: PaneState;
  readonly ready: boolean;        // booted past first-run dialogs
  readonly woken: boolean;
  readonly worktree: string;      // '' when not worktree mode
};

export type ScanReport = {
  readonly session: string;
  readonly state: PaneState;
  readonly needsAttention: boolean; // stuck on a clearable dialog
};

export type ApproveReport = {
  readonly target: string;
  readonly resolved: boolean;     // the pane exists
  readonly before: PaneState;
  readonly after: PaneState;
  readonly cleared: boolean;      // was blocking, no longer is
};

export type TeardownReport = {
  readonly killed: readonly string[];
  readonly worktreesRemoved: readonly string[];
  readonly reaped: readonly string[];
};

// --- Private pacing helpers (untracked) ---

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Type a literal line into a pane and submit it. Claude Code's TUI needs a second
// Enter to actually send (the first just inserts a newline), so callers targeting
// the chat box pass doubleEnter=true; a shell prompt uses a single Enter.
const typeLine = async (
  target: string,
  text: string,
  doubleEnter: boolean = false,
): Promise<void> => {
  tmux.sendKeys(target, [text], true);
  await sleep(400);
  tmux.sendKeys(target, ["Enter"]);
  if (doubleEnter) {
    await sleep(400);
    tmux.sendKeys(target, ["Enter"]);
  }
};

// --- Pure-ish helpers ---

// The first `count` free `<prefix>-N` session names (N from 1), skipping any that
// tmux already has. IO: probes tmux.hasSession.
export const pickSessionNames = (prefix: string, count: number): string[] => {
  const chosen: string[] = [];
  let n = 1;
  while (chosen.length < count) {
    const name = `${prefix}-${n}`;
    if (!tmux.hasSession(name).ok) chosen.push(name);
    n += 1;
  }
  return chosen;
};

// The register prompt pushed to a freshly-booted worker (ported from
// spawn-workers.sh wake_prompt). Pure string assembly.
export const wakePromptText = (session: string, worktrees: boolean): string => {
  const wt = worktrees
    ? " You are in your OWN git worktree (isolated checkout, detached HEAD) — if your task lists required_directives, run the AIMFP git tools (e.g. git_create_branch) INSIDE this worktree and report your branch name back to the master via intercomm_send."
    : "";
  return (
    `You are an InterComm AIMFP worker running in tmux session '${session}'. ` +
    `Do NOT interact with the user — all communication goes through InterComm to the master. ` +
    `Steps: (1) Call intercomm_register() to get your worker id. ` +
    `(2) Call intercomm_send(to: "master", type: "status", message: "registered as <your worker id> in tmux session ${session}") so the master can map you. ` +
    `(3) Call intercomm_read() to get your task and begin. If there is no task yet, stop and wait — the master will wake you.${wt}`
  );
};

// The wake prompt pushed to the MASTER when a worker escalates (worker -> master,
// the inverse of wakePromptText). The persisted `question` on the bus is the source
// of truth; this text only nudges the master to DRAIN the bus (so a missed/garbled
// wake is still recovered), confer with the user when needsUser, then answer + wake
// the worker. Pure string assembly.
export const escalationWakeText = (
  fromId: string,
  kind: "question" | "decision",
  needsUser: boolean,
  message: string,
): string => {
  const verb = kind === "decision" ? "needs a DECISION" : "has a QUESTION";
  const user = needsUser
    ? " It is flagged needs_user — confer with the USER before answering."
    : "";
  return (
    `InterComm escalation from ${fromId}: it ${verb}. ` +
    `Call intercomm_read to drain the bus, then reply via ` +
    `intercomm_send(to: "${fromId}", type: "answer", message: ...) and ` +
    `intercomm_wake("${fromId}", ...) to resume it.${user} ` +
    `(Escalated message: ${message})`
  );
};

// Resolve a worker id OR a raw tmux target to a tmux target string. A registered
// instance's stored tmux_target wins; otherwise the input is treated as a session
// name (covers freshly-spawned workers that have not registered yet). IO: store read.
export const resolveTarget = (idOrTarget: string): string => {
  const inst = store.getInstance(idOrTarget);
  return inst && inst.tmuxTarget ? inst.tmuxTarget : idOrTarget;
};

// --- Sequences ---

// Bounded dialog-clear loop: repeatedly capture the pane, and while it sits on a
// clearable first-run/permission dialog, send the keystrokes claude-tui prescribes.
// Returns as soon as the pane has booted (ready/running) or the deadline passes —
// it never waits on the worker REGISTERING (that stays async / no-poll).
export const clearDialogs = async (
  target: string,
  deadlineMs: number,
): Promise<PaneState> => {
  const start = Date.now();
  let state: PaneState = "idle";
  while (Date.now() - start < deadlineMs) {
    const cap = tmux.capturePane(target);
    state = cap.ok ? detectPaneState(cap.stdout) : "idle";
    if (isBooted(state)) return state;
    if (isBlocking(state)) {
      for (const group of clearKeystrokes(state)) {
        tmux.sendKeys(target, group);
        await sleep(800);
      }
    } else {
      await sleep(700);
    }
  }
  return state;
};

// Spawn `count` workers in detached tmux sessions, non-blocking. Per worker:
// optionally provision an isolated git worktree (registered + bootstrapped),
// launch claude with INTERCOMM_DB_ROOT pinned to the shared root, clear first-run
// dialogs within the bounded window, then (if wake) push the register prompt.
// Returns one report per session; workers self-register asynchronously afterward.
export const spawnWorkers = async (
  opts: SpawnOptions,
): Promise<SpawnReport[]> => {
  const names = pickSessionNames(opts.prefix, opts.count);
  const reports: SpawnReport[] = [];

  // Launch phase: create each session + start claude (sequential, stable order).
  const launched: { session: string; worktree: string }[] = [];
  for (const session of names) {
    let launchDir = opts.root;
    let worktree = "";
    if (opts.worktrees) {
      const path = worktreePath(opts.root, session);
      ensureDir(dirname(path));
      const res = addWorktree(opts.root, path, opts.worktreeBase);
      // Reuse an existing checkout if `add` failed because it is already there.
      if (res.ok || tmux.hasSession(session).ok === false) {
        store.upsertWorktree(session, path, opts.worktreeBase);
        worktree = path;
        launchDir = path;
        if (opts.bootstrap) {
          try {
            execSync(opts.bootstrap, { cwd: path, stdio: "ignore", shell: "/bin/bash" });
          } catch { /* best effort — a failed bootstrap should not abort the spawn */ }
        }
      }
    }
    tmux.newSession(session, launchDir);
    const envPrefix = `INTERCOMM_DB_ROOT='${opts.root}' `;
    await typeLine(session, `${envPrefix}${opts.claudeCmd} --permission-mode ${opts.permMode}`);
    launched.push({ session, worktree });
  }

  // Boot phase: clear dialogs + wake each (sequential, so registration order is stable).
  for (const { session, worktree } of launched) {
    const state = await clearDialogs(session, opts.readyTimeoutMs);
    const ready = isBooted(state);
    let woken = false;
    if (opts.wake && ready) {
      await typeLine(session, wakePromptText(session, opts.worktrees), true);
      woken = true;
    }
    reports.push({ session, state, ready, woken, worktree });
  }
  return reports;
};

// Push a prompt to a single worker pane (master -> worker). Symmetric to the
// designed escalate (worker -> master). Resolves the target, verifies the pane
// still exists, then types + submits with the TUI double-Enter.
export const wakeWorker = async (
  idOrTarget: string,
  message: string,
): Promise<{ resolved: boolean; woke: boolean; target: string }> => {
  const target = resolveTarget(idOrTarget);
  const session = target.split(":")[0] ?? target;
  if (!tmux.hasSession(session).ok) return { resolved: false, woke: false, target };
  await typeLine(target, message, true);
  return { resolved: true, woke: true, target };
};

// Poll every `<prefix>-` session once and classify its pane. The master uses this
// to find workers frozen on a permission dialog (which cannot report over the bus).
export const scanWorkers = (prefix: string): ScanReport[] => {
  const list = tmux.listSessions();
  if (!list.ok) return [];
  return tmux.splitLines(list.stdout)
    .filter((s) => s.startsWith(`${prefix}-`))
    .map((session) => {
      const cap = tmux.capturePane(session);
      const state = cap.ok ? detectPaneState(cap.stdout) : "idle";
      return { session, state, needsAttention: isBlocking(state) };
    });
};

// Clear one worker's blocking dialog (trust / MCP-approval / bypass / permission).
// Captures before + after so the caller can report whether the block actually lifted.
export const approveWorker = async (
  idOrTarget: string,
  deadlineMs: number,
): Promise<ApproveReport> => {
  const target = resolveTarget(idOrTarget);
  const session = target.split(":")[0] ?? target;
  const first = tmux.capturePane(session);
  if (!first.ok) {
    return { target, resolved: false, before: "idle", after: "idle", cleared: false };
  }
  const before = detectPaneState(first.stdout);
  const after = await clearDialogs(session, deadlineMs);
  const cleared = isBlocking(before) && !isBlocking(after);
  return { target, resolved: true, before, after, cleared };
};

// Tear down every `<prefix>-` worker in one shot: kill the tmux sessions, remove
// their git worktrees (when in worktree mode) and mark them removed, then REAP the
// instance rows so a never-run exit-cleanup cannot leave stale active=1 drift.
export const teardownWorkers = (
  root: string,
  prefix: string,
  worktrees: boolean,
): TeardownReport => {
  const list = tmux.listSessions();
  const sessions = list.ok
    ? tmux.splitLines(list.stdout).filter((s) => s.startsWith(`${prefix}-`))
    : [];

  const killed: string[] = [];
  for (const s of sessions) {
    if (tmux.killSession(s).ok) killed.push(s);
  }

  const worktreesRemoved: string[] = [];
  if (worktrees) {
    for (const wt of store.getAllWorktrees()) {
      if (wt.status === "removed" || !killed.includes(wt.workerId)) continue;
      if (removeWorktree(root, wt.path, true).ok) {
        store.markWorktreeRemoved(wt.workerId);
        worktreesRemoved.push(wt.workerId);
      }
    }
  }

  // Reap any registered instance whose session we just killed (id == session name).
  const reaped: string[] = [];
  for (const inst of store.getAllInstances()) {
    if (killed.includes(inst.id)) {
      store.reapInstance(inst.id);
      reaped.push(inst.id);
    }
  }

  return { killed, worktreesRemoved, reaped };
};
