// MCP server — 16 tool handlers (register + communication + management +
// worktrees + orchestration: spawn/wake/scan/approve/teardown).
// Auto-init DB at server startup

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MessageType, Role, WorktreeStatus } from "./types.js";
import { WORKTREE_STATUSES } from "./types.js";
import { worktreePath } from "./config.js";
import { initDb, closeDb } from "./db.js";
import { ensureDir } from "./fs-wrapper.js";
import { addWorktree, removeWorktree } from "./git-wrapper.js";
import * as tmux from "./tmux-wrapper.js";
import * as orchestrate from "./orchestrate.js";
import * as store from "./store.js";

// --- Server state (mutable ref, set during bootstrap) ---

type ServerState = {
  identity: { id: string; role: string } | null;
  root: string;
  sessionId: string;
};

const createState = (root: string): ServerState => ({
  identity: null,
  root,
  sessionId: randomUUID(),
});

// --- Result helpers ---

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
});

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${text}` }],
  isError: true,
});

const requireIdentity = (state: ServerState): CallToolResult | null => {
  if (!state.identity) return errorResult("Not registered. Call intercomm_register first.");
  store.touchInstance(state.identity.id);
  return null;
};

const requireMaster = (state: ServerState): CallToolResult | null => {
  const err = requireIdentity(state);
  if (err) return err;
  if (state.identity!.role !== "master") return errorResult("Master-only action.");
  return null;
};

// --- Message type enum for zod ---

const SEND_TYPES = [
  "task",
  "status",
  "question",
  "answer",
  "announce",
  "done",
] as const;

// claude --permission-mode values (the orchestration tools launch workers with one).
const PERM_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

// --- Handlers ---

const handleRegister = (
  state: ServerState,
  args: { role: Role },
): CallToolResult => {
  initDb(state.root);

  if (state.identity) {
    return errorResult(`Already registered as "${state.identity.id}" (${state.identity.role}). Restart to re-register.`);
  }

  const instance = store.registerAs(args.role, state.sessionId, tmux.currentPaneTarget());
  state.identity = { id: instance.id, role: instance.role };

  return textResult(
    `Registered as "${instance.id}" (${instance.role}). Session: ${state.sessionId.slice(0, 8)}`,
  );
};

const handleSend = (
  state: ServerState,
  args: { to: string; message: string; type: MessageType },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  const recipient = store.getInstance(args.to);
  if (!recipient) return errorResult(`No instance registered with id "${args.to}"`);

  store.insertMessage(state.identity!.id, args.to, args.type, args.message);
  return textResult(`Sent (${args.type}) to ${args.to}`);
};

const handleBroadcast = (
  state: ServerState,
  args: { message: string; type: MessageType },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  store.insertMessage(state.identity!.id, "all", args.type, args.message);
  return textResult(`Broadcast (${args.type}) to all`);
};

const handleRead = (
  state: ServerState,
  args: { all: boolean },
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  const messages = store.readNewMessages(state.identity!.id, args.all);
  if (messages.length === 0) return textResult("No new messages.");

  const lines = [
    `--- ${messages.length} message(s) ---`,
    ...messages.map(store.formatMessageForDisplay),
  ];
  return textResult(lines.join("\n"));
};

const handleStatus = (state: ServerState): CallToolResult => {
  const instances = store.getAllInstances();
  if (instances.length === 0) return textResult("No instances registered.");

  const myId = state.identity?.id ?? "(not registered)";
  const lines = [
    `You are: ${myId}`,
    "Instances:",
    ...instances.map(store.formatInstanceForDisplay),
  ];
  return textResult(lines.join("\n"));
};

const handleSignoff = (
  state: ServerState,
): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  const id = state.identity!.id;
  store.deactivateInstance(id);
  state.identity = null;
  return textResult(`Signed off "${id}". Instance deactivated.`);
};

const handleClear = (
  state: ServerState,
  args: { keep: number },
): CallToolResult => {
  const err = requireMaster(state);
  if (err) return err;

  const deleted = store.clearOldMessages(args.keep);
  return textResult(`Cleared ${deleted} old messages (kept last ${args.keep}).`);
};

// --- Worktree handlers (multi-agent parallelization addon) ---
//
// InterComm's git footprint is ONLY worktree add/remove (filesystem isolation).
// Branch creation + merges are AIMFP directives run by the agents — never here.

const handleWorktreeAdd = (
  state: ServerState,
  args: { worker_id: string; base: string; path?: string },
): CallToolResult => {
  const err = requireMaster(state);
  if (err) return err;

  const base = args.base?.trim() || "main";
  const path = args.path?.trim() || worktreePath(state.root, args.worker_id);

  ensureDir(dirname(path));
  const res = addWorktree(state.root, path, base);
  if (!res.ok) return errorResult(`git worktree add failed: ${res.error}`);

  store.upsertWorktree(args.worker_id, path, base);
  return textResult(
    `Worktree for ${args.worker_id} created at ${path} (detached from ${base}). ` +
      `The worker should run AIMFP git_create_branch inside it to make its branch.`,
  );
};

const handleWorktreeList = (state: ServerState): CallToolResult => {
  const err = requireIdentity(state);
  if (err) return err;

  const worktrees = store.getAllWorktrees();
  if (worktrees.length === 0) return textResult("No worktrees registered.");

  const lines = [
    `--- ${worktrees.length} worktree(s) ---`,
    ...worktrees.map(store.formatWorktreeForDisplay),
  ];
  return textResult(lines.join("\n"));
};

const handleWorktreeSetStatus = (
  state: ServerState,
  args: { worker_id: string; status: WorktreeStatus; branch?: string },
): CallToolResult => {
  const err = requireMaster(state);
  if (err) return err;

  if (!store.getWorktree(args.worker_id)) {
    return errorResult(`No worktree registered for "${args.worker_id}"`);
  }

  store.setWorktreeStatus(args.worker_id, args.status, args.branch?.trim());
  const branchNote = args.branch?.trim() ? `, branch=${args.branch.trim()}` : "";
  return textResult(`Worktree ${args.worker_id} → ${args.status}${branchNote}`);
};

const handleWorktreeRemove = (
  state: ServerState,
  args: { worker_id: string; force: boolean },
): CallToolResult => {
  const err = requireMaster(state);
  if (err) return err;

  const wt = store.getWorktree(args.worker_id);
  if (!wt) return errorResult(`No worktree registered for "${args.worker_id}"`);

  const res = removeWorktree(state.root, wt.path, args.force);
  if (!res.ok) {
    return errorResult(
      `git worktree remove failed: ${res.error} (retry with force=true if it has changes)`,
    );
  }

  store.markWorktreeRemoved(args.worker_id);
  return textResult(`Worktree ${args.worker_id} removed (${wt.path}).`);
};

// --- Orchestration handlers (the tool-driven multi-agent lifecycle) ---
//
// Thin: each parses args, calls an orchestrate sequence, and formats the report.
// All master-only. They retire spawn/scan/kill-workers.sh as runtime dependencies.

const handleSpawn = async (
  state: ServerState,
  args: {
    count: number; prefix: string; perm_mode: string; claude_cmd: string;
    worktrees: boolean; worktree_base: string; bootstrap?: string;
    ready_timeout: number; wake: boolean;
  },
): Promise<CallToolResult> => {
  const err = requireMaster(state);
  if (err) return err;
  if (args.count < 1) return errorResult("count must be >= 1");

  const reports = await orchestrate.spawnWorkers({
    root: state.root,
    count: args.count,
    prefix: args.prefix,
    permMode: args.perm_mode,
    claudeCmd: args.claude_cmd,
    worktrees: args.worktrees,
    worktreeBase: args.worktree_base,
    bootstrap: args.bootstrap?.trim() ?? "",
    readyTimeoutMs: args.ready_timeout * 1000,
    wake: args.wake,
  });

  const lines = reports.map((r) =>
    `session=${r.session} state=${r.state} ready=${r.ready ? "yes" : "no"} woken=${r.woken ? "yes" : "no"} worktree=${r.worktree || "-"}`,
  );
  return textResult([
    `Spawned ${reports.length} worker(s):`,
    ...lines,
    "Workers self-register asynchronously — call intercomm_status to confirm the session<->id mapping. Use intercomm_scan/intercomm_approve for any pane left on a dialog.",
  ].join("\n"));
};

const handleWake = async (
  state: ServerState,
  args: { worker: string; message: string },
): Promise<CallToolResult> => {
  const err = requireMaster(state);
  if (err) return err;

  const res = await orchestrate.wakeWorker(args.worker, args.message);
  if (!res.resolved) {
    return errorResult(`No live tmux pane for "${args.worker}" (resolved target: ${res.target || "—"}).`);
  }
  return textResult(`Woke ${args.worker} (${res.target}).`);
};

const handleScan = (
  state: ServerState,
  args: { prefix: string },
): CallToolResult => {
  const err = requireMaster(state);
  if (err) return err;

  const reports = orchestrate.scanWorkers(args.prefix);
  if (reports.length === 0) return textResult(`No worker sessions found (prefix: ${args.prefix}-).`);

  const lines = reports.map((r) =>
    `session=${r.session} state=${r.state}${r.needsAttention ? "  <- needs intercomm_approve" : ""}`,
  );
  const blocked = reports.filter((r) => r.needsAttention).length;
  return textResult([
    `--- ${reports.length} worker pane(s) ---`,
    ...lines,
    `${blocked} of ${reports.length} need attention.`,
  ].join("\n"));
};

const handleApprove = async (
  state: ServerState,
  args: { worker: string; timeout: number },
): Promise<CallToolResult> => {
  const err = requireMaster(state);
  if (err) return err;

  const r = await orchestrate.approveWorker(args.worker, args.timeout * 1000);
  if (!r.resolved) {
    return errorResult(`No live tmux pane for "${args.worker}" (target: ${r.target || "—"}).`);
  }
  const note = r.cleared
    ? " (cleared)"
    : r.before === "ready" || r.before === "running" || r.before === "idle"
      ? " (nothing to clear)"
      : " (still blocked — retry, or inspect the pane)";
  return textResult(`Approve ${args.worker}: ${r.before} -> ${r.after}${note}`);
};

const handleTeardown = (
  state: ServerState,
  args: { prefix: string; worktrees: boolean },
): CallToolResult => {
  const err = requireMaster(state);
  if (err) return err;

  const r = orchestrate.teardownWorkers(state.root, args.prefix, args.worktrees);
  return textResult([
    `Torn down ${r.killed.length} session(s): ${r.killed.join(", ") || "(none)"}`,
    `Worktrees removed: ${r.worktreesRemoved.join(", ") || "(none)"}`,
    `Instance rows reaped: ${r.reaped.join(", ") || "(none)"}`,
  ].join("\n"));
};

// --- Tool registration ---

const registerTools = (server: McpServer, state: ServerState): void => {
  server.registerTool("intercomm_register", {
    description: "Register this instance as master or worker. Initializes DB if needed. Master deactivates all existing instances. Worker auto-assigns lowest available worker-N name. Default role: worker.",
    inputSchema: {
      role: z.enum(["master", "worker"]).default("worker").describe("Role to register as (default: worker)"),
    },
  }, (args) => handleRegister(state, args as { role: Role }));

  server.registerTool("intercomm_send", {
    description: "Send a direct message to a specific peer.",
    inputSchema: {
      to: z.string().describe("Recipient peer id"),
      message: z.string().describe("Message content"),
      type: z.enum(SEND_TYPES).default("status").describe("Message type"),
    },
  }, (args) => handleSend(state, args as { to: string; message: string; type: MessageType }));

  server.registerTool("intercomm_broadcast", {
    description: "Broadcast a message to all registered peers.",
    inputSchema: {
      message: z.string().describe("Message content"),
      type: z.enum(SEND_TYPES).default("announce").describe("Message type"),
    },
  }, (args) => handleBroadcast(state, args as { message: string; type: MessageType }));

  server.registerTool("intercomm_read", {
    description: "Read ALL new messages since last check (any type). Updates read cursor.",
    inputSchema: {
      all: z.boolean().default(false).describe("Re-read all messages from the beginning"),
    },
  }, (args) => handleRead(state, args as { all: boolean }));

  server.registerTool("intercomm_status", {
    description: "Show all instances: id, role, active, last_active.",
  }, () => handleStatus(state));

  server.registerTool("intercomm_signoff", {
    description: "Cleanly deactivate this instance and sign off. Use before shutting down.",
  }, () => handleSignoff(state));

  server.registerTool("intercomm_clear", {
    description: "Delete messages older than threshold. Master-only.",
    inputSchema: {
      keep: z.number().int().min(0).default(100).describe("Number of recent messages to retain (default: 100)"),
    },
  }, (args) => handleClear(state, args as { keep: number }));

  // --- Worktree / orchestration tools (multi-agent addon) ---

  server.registerTool("intercomm_worktree_add", {
    description: "Master-only. Create an isolated git worktree (detached HEAD) for a worker and register it. InterComm only isolates files — the worker runs AIMFP git_create_branch inside the worktree to make its branch.",
    inputSchema: {
      worker_id: z.string().describe("Worker id this worktree belongs to (e.g. worker-1)"),
      base: z.string().default("main").describe("Git ref to check out detached (default: main)"),
      path: z.string().optional().describe("Worktree path (default: sibling .intercomm-worktrees/<worker_id>)"),
    },
  }, (args) => handleWorktreeAdd(state, args as { worker_id: string; base: string; path?: string }));

  server.registerTool("intercomm_worktree_list", {
    description: "List all registered worktrees and their lifecycle status (the master's merge-queue view).",
  }, () => handleWorktreeList(state));

  server.registerTool("intercomm_worktree_set_status", {
    description: "Master-only. Update a worktree's lifecycle status, optionally recording the branch the worker reported back.",
    inputSchema: {
      worker_id: z.string().describe("Worker id whose worktree to update"),
      status: z.enum(WORKTREE_STATUSES).describe("New lifecycle status"),
      branch: z.string().optional().describe("Branch the worker reported (e.g. aimfp-worker-1-001); leave empty to keep current"),
    },
  }, (args) => handleWorktreeSetStatus(state, args as { worker_id: string; status: WorktreeStatus; branch?: string }));

  server.registerTool("intercomm_worktree_remove", {
    description: "Master-only. Remove a worker's git worktree and mark it removed in the registry.",
    inputSchema: {
      worker_id: z.string().describe("Worker id whose worktree to remove"),
      force: z.boolean().default(false).describe("Pass --force to git worktree remove (drops uncommitted changes)"),
    },
  }, (args) => handleWorktreeRemove(state, args as { worker_id: string; force: boolean }));

  // --- Orchestration tools (tool-driven lifecycle; retire the shell scripts) ---

  server.registerTool("intercomm_spawn", {
    description: "Master-only. Spawn N Claude Code workers in detached tmux sessions (retires spawn-workers.sh). Non-blocking: creates sessions, launches claude with INTERCOMM_DB_ROOT pinned to the shared DB, optionally one git worktree per worker, auto-clears first-run dialogs, and wakes each to self-register. Returns session ids; workers register asynchronously (does NOT wait on registration).",
    inputSchema: {
      count: z.number().int().min(1).describe("Number of workers to spawn"),
      prefix: z.string().default("worker").describe("tmux session-name prefix (default: worker)"),
      perm_mode: z.enum(PERM_MODES).default("acceptEdits").describe("claude --permission-mode (default: acceptEdits)"),
      claude_cmd: z.string().default("claude").describe("Claude binary to launch (default: claude)"),
      worktrees: z.boolean().default(false).describe("Launch each worker in its own isolated git worktree (branch-per-agent)"),
      worktree_base: z.string().default("main").describe("Git ref each worktree checks out detached (default: main)"),
      bootstrap: z.string().optional().describe("Setup command run inside each new worktree (e.g. 'npm install')"),
      ready_timeout: z.number().int().min(1).default(20).describe("Per-session seconds to clear boot dialogs before giving up (default: 20)"),
      wake: z.boolean().default(true).describe("Push the register prompt after each worker boots (default: true)"),
    },
  }, (args) => handleSpawn(state, args as Parameters<typeof handleSpawn>[1]));

  server.registerTool("intercomm_wake", {
    description: "Master-only. Push a prompt into a worker's tmux pane (retires manual `tmux send-keys`). Accepts a worker id (resolved via its stored tmux_target) or a raw tmux target. The no-poll way to hand a worker its next task.",
    inputSchema: {
      worker: z.string().describe("Worker id (e.g. worker-1) or raw tmux target (session:window.pane)"),
      message: z.string().describe("Prompt text to type and submit in the worker's Claude TUI"),
    },
  }, (args) => handleWake(state, args as { worker: string; message: string }));

  server.registerTool("intercomm_scan", {
    description: "Master-only. Report each worker pane's state (retires scan-workers.sh): trust/mcp_approval/bypass/blocked/ready/running/idle. Surfaces workers frozen on a permission dialog (which cannot report over the bus).",
    inputSchema: {
      prefix: z.string().default("worker").describe("tmux session-name prefix to scan (default: worker)"),
    },
  }, (args) => handleScan(state, args as { prefix: string }));

  server.registerTool("intercomm_approve", {
    description: "Master-only. Clear a worker's blocking dialog (retires manual `tmux send-keys '1' Enter`): trust, MCP-approval, bypass warning, or a tool permission prompt. Reports the before/after pane state.",
    inputSchema: {
      worker: z.string().describe("Worker id or raw tmux target to approve"),
      timeout: z.number().int().min(1).default(5).describe("Seconds to keep clearing dialogs (default: 5)"),
    },
  }, (args) => handleApprove(state, args as { worker: string; timeout: number }));

  server.registerTool("intercomm_teardown", {
    description: "Master-only. Tear down all workers in one shot (retires kill-workers.sh + the raw SQL reap): kill the tmux sessions, remove their git worktrees (worktree mode), and REAP the instance rows so a stale active=1 cannot drift the next worker's number.",
    inputSchema: {
      prefix: z.string().default("worker").describe("tmux session-name prefix to tear down (default: worker)"),
      worktrees: z.boolean().default(false).describe("Also git worktree remove --force each worker's worktree"),
    },
  }, (args) => handleTeardown(state, args as { prefix: string; worktrees: boolean }));
};

// --- Factory (the only place with `new`) ---

export const createAndRunServer = async (root: string): Promise<void> => {
  const state = createState(root);

  // Auto-init DB at startup
  initDb(root);

  const server = new McpServer({
    name: "intercomm-aimfp",
    version: "0.4.0",
  });

  registerTools(server, state);

  // Cleanup on exit
  const cleanup = (): void => {
    if (state.identity) {
      try {
        store.deactivateInstance(state.identity.id);
      } catch { /* best effort */ }
    }
    closeDb();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
