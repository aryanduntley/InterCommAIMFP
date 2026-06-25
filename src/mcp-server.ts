// MCP server — 19 tool handlers (register + communication + management +
// get_protocol + worktrees + orchestration: spawn/wake/scan/approve/teardown +
// assign + escalate). The coordination protocol is auto-injected via the
// `instructions` field at construction. Auto-init DB at server startup.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  MessageType,
  Role,
  WorktreeStatus,
  AimfpTarget,
  AimfpTargetType,
} from "./types.js";
import { WORKTREE_STATUSES } from "./types.js";
import { buildTaskContract, parseTaskContract } from "./task-contract.js";
import { worktreePath, worktreesDir, rootMismatchWarning, ENV_DB_ROOT } from "./config.js";
import { loadProtocol } from "./protocol.js";
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
  // Refresh last_active AND (when tmux-backed) re-resolve our OWN pane so the stored
  // tmux_target never goes stale — this keeps the master wakeable for worker
  // escalations (Phase 2.5b P1-b). currentPaneTarget() returns '' off-tmux, in which
  // case touchInstance leaves tmux_target untouched.
  store.touchInstance(state.identity.id, tmux.currentPaneTarget());
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

// AIMFP work-hierarchy tables a thin-pointer contract may target (mirrors AimfpTargetType).
const AIMFP_TARGET_TYPES = [
  "task",
  "milestone",
  "subtask",
  "sidequest",
  "item",
] as const;

// Prompt pushed to a worker when intercomm_assign wakes it — points it at the
// thin-pointer flow: read the contract, bootstrap AIMFP, continue the entity.
const ASSIGN_WAKE_PROMPT =
  "You have a new InterComm task. Call intercomm_read to get your task contract, " +
  "then run aimfp_run(is_new_session=true) in your worktree and continue the assigned " +
  "aimfp_target entity. Do NOT ask the user anything — report back to master via InterComm.";

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
    ...messages.map((m) =>
      m.type === "task"
        ? `${store.formatMessageForDisplay(m)}\n${formatTaskContract(m.content)}`
        : store.formatMessageForDisplay(m),
    ),
  ];
  return textResult(lines.join("\n"));
};

// Worker-side access to parseTaskContract: render a task message's contract as
// a validated summary (or a parse error) so the worker never has to reach into
// the server's source to parse it — it gets the result through intercomm_read.
const formatTaskContract = (content: string): string => {
  const parsed = parseTaskContract(content);
  if (!parsed.ok) {
    return `    ⚠ INVALID task contract: ${parsed.error} — send a question to master; do NOT act.`;
  }
  const c = parsed.contract;
  const t = c.aimfp_target;
  const ident = [
    t.id != null ? `id=${t.id}` : null,
    t.slug ? `slug=${t.slug}` : null,
  ].filter(Boolean).join(", ");
  return [
    `    ✓ task contract (role=${c.role}):`,
    `      aimfp_target: ${t.type} (${ident})`,
    `      role_instructions: ${c.role_instructions}`,
    `      reportBack: [${c.reportBack.join(", ")}]`,
  ].join("\n");
};

const handleStatus = (state: ServerState): CallToolResult => {
  const instances = store.getAllInstances();
  if (instances.length === 0) return textResult("No instances registered.");

  const myId = state.identity?.id ?? "(not registered)";
  const lines = [
    `You are: ${myId}`,
    "Instances:",
    ...instances.map((inst) =>
      store.formatInstanceForDisplay(inst, store.getWorktree(inst.id)),
    ),
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

// Master-side access to buildTaskContract: assemble a thin-pointer contract from
// structured args, record it as a `task` message, and (by default) wake the
// worker. This is how the master assigns work without hand-authoring the JSON or
// reaching into the server's source — the contract shape lives behind the tool.
const handleAssign = async (
  state: ServerState,
  args: {
    worker: string;
    role: string;
    role_instructions: string;
    target_type: AimfpTargetType;
    target_id?: number;
    target_slug?: string;
    report_back: string[];
    wake: boolean;
  },
): Promise<CallToolResult> => {
  const err = requireMaster(state);
  if (err) return err;

  const recipient = store.getInstance(args.worker);
  if (!recipient) return errorResult(`No instance registered with id "${args.worker}"`);

  const slug = args.target_slug?.trim();
  if (args.target_id == null && !slug) {
    return errorResult("Provide target_id and/or target_slug to point at an AIMFP entity.");
  }

  const target: AimfpTarget = {
    type: args.target_type,
    ...(args.target_id != null ? { id: args.target_id } : {}),
    ...(slug ? { slug } : {}),
  };
  const ident = [
    args.target_id != null ? `id=${args.target_id}` : null,
    slug ? `slug=${slug}` : null,
  ].filter(Boolean).join(", ");

  const content = buildTaskContract({
    role: args.role,
    role_instructions: args.role_instructions,
    aimfp_target: target,
    reportBack: args.report_back,
  });
  store.insertMessage(state.identity!.id, args.worker, "task", content);

  if (!args.wake) {
    return textResult(
      `Assigned ${args.target_type} (${ident}) to ${args.worker} — not woken; it reads the contract via intercomm_read.`,
    );
  }

  const res = await orchestrate.wakeWorker(args.worker, ASSIGN_WAKE_PROMPT);
  const wokeNote = res.resolved
    ? `woke it (${res.target})`
    : `could NOT wake it (no live pane: ${res.target || "—"}) — contract is persisted, wake manually`;
  return textResult(`Assigned ${args.target_type} (${ident}) to ${args.worker}; ${wokeNote}.`);
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
  // Nested-root guard: if the bus root was NOT explicitly pinned and differs from the
  // launch cwd, this project may be nested inside another git repo and the worktrees
  // could be of the wrong repo (Run-1 bug). Surface a warning before the master proceeds.
  const pinned = process.env[ENV_DB_ROOT]?.trim();
  const warning = pinned ? null : rootMismatchWarning(state.root, process.cwd());
  return textResult([
    ...(warning ? [warning, ""] : []),
    `Spawned ${reports.length} worker(s) — bus root: ${state.root}${args.worktrees ? `, worktrees under: ${worktreesDir(state.root)}` : ""}`,
    ...lines,
    "Workers self-register asynchronously — call intercomm_status to confirm the session<->id<->worktree mapping. Use intercomm_scan/intercomm_approve for any pane left on a dialog.",
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

// Worker -> master no-poll escalation (Phase 2.5b, Option B): the server persists
// the question to the bus AND does the tmux wake on the worker's behalf — the worker
// never touches tmux, so role enforcement stays intact. The DB write is the source of
// truth; the wake is best-effort, so a busy / off-tmux / stale master still recovers
// the escalation on its next intercomm_read. Returns a structured {persisted, woke, reason?}.
const handleEscalate = async (
  state: ServerState,
  args: { message: string; kind: "question" | "decision"; needs_user: boolean },
): Promise<CallToolResult> => {
  const err = requireIdentity(state);
  if (err) return err;
  if (state.identity!.role === "master") {
    return errorResult("intercomm_escalate is a worker->master tool; the master coordinates with the user directly.");
  }

  const fromId = state.identity!.id;
  // Persist FIRST (source of truth). kind + needs_user are encoded in the content so
  // the record is self-describing even if the wake is missed entirely (P1-a).
  const tag = `[escalation kind=${args.kind}${args.needs_user ? " needs_user" : ""}]`;
  store.insertMessage(fromId, "master", "question", `${tag} ${args.message}`);

  const report = (woke: boolean, reason?: string): CallToolResult =>
    textResult(
      `${woke ? "Escalation persisted and master woken." : "Escalation persisted (master not woken — it will see the question on its next intercomm_read)."}\n` +
      `{"persisted": true, "woke": ${woke}${reason ? `, "reason": "${reason}"` : ""}}`,
    );

  // Degradation (never fail): no live master, or a master that is not in tmux, falls
  // back to message-only. getActiveMaster already excludes stale (>30s) masters.
  const master = store.getActiveMaster();
  if (!master) return report(false, "no active (non-stale) master registered");
  if (!master.tmuxTarget) return report(false, "master not in tmux (message-only)");

  // Best-effort wake — wakeWorker verifies the pane still resolves (P1-d). A definitive
  // non-resolve downgrades the master to message-only by clearing its target (P1-b).
  const wake = await orchestrate.wakeWorker(
    "master",
    orchestrate.escalationWakeText(fromId, args.kind, args.needs_user, args.message),
  );
  if (!wake.woke) {
    if (!wake.resolved) store.setInstanceTmuxTarget("master", "");
    return report(false, wake.resolved ? "wake send failed" : "master pane no longer resolves (downgraded to message-only)");
  }
  return report(true);
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

  server.registerTool("intercomm_get_protocol", {
    description: "Re-read the full InterComm master/worker coordination protocol on demand. The same text is auto-injected as the server's MCP instructions on connect; use this to refresh it after a long session / context compaction. No registration required.",
  }, () => textResult(loadProtocol()));

  server.registerTool("intercomm_clear", {
    description: "Delete messages older than threshold. Master-only.",
    inputSchema: {
      keep: z.number().int().min(0).default(100).describe("Number of recent messages to retain (default: 100)"),
    },
  }, (args) => handleClear(state, args as { keep: number }));

  server.registerTool("intercomm_assign", {
    description: "Master-only. Assign work to a worker as a thin-pointer task contract: build {role, role_instructions, aimfp_target, reportBack} from these args, record it as a `task` message, and (by default) wake the worker. The worker reads it via intercomm_read, then runs aimfp_run in its worktree and continues the referenced AIMFP entity. Provide target_id and/or target_slug. InterComm never resolves the pointer — AIMFP does, worker-side.",
    inputSchema: {
      worker: z.string().describe("Worker id to assign (e.g. worker-1)"),
      role: z.string().default("worker").describe("Worker role label (default: worker)"),
      role_instructions: z.string().min(1).describe("Role guidance / hard boundaries for this worker (e.g. assigned files, a distinct AIMFP user identity so aimfp-{user}-{number} branches don't collide)"),
      target_type: z.enum(AIMFP_TARGET_TYPES).describe("AIMFP entity table the worker continues"),
      target_id: z.number().int().optional().describe("AIMFP entity integer id (provide this and/or target_slug)"),
      target_slug: z.string().optional().describe("AIMFP entity stable slug (provide this and/or target_id)"),
      report_back: z.array(z.string()).default(["branch", "commit"]).describe("Fields the worker must report on done (default: branch, commit)"),
      wake: z.boolean().default(true).describe("Wake the worker after recording the contract (default: true)"),
    },
  }, (args) => handleAssign(state, args as Parameters<typeof handleAssign>[1]));

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

  server.registerTool("intercomm_escalate", {
    description: "Worker->master no-poll escalation. Raise a question or decision to the master WITHOUT polling: the server persists it as a `question` on the bus AND wakes the master in its tmux pane on your behalf (you never touch tmux). The DB write is the source of truth and the wake is best-effort — a busy, off-tmux, or stale master still sees it on its next intercomm_read. Set needs_user when the master must confer with the human before answering. Returns {persisted, woke, reason?}.",
    inputSchema: {
      message: z.string().min(1).describe("Your question, or the decision/approval you need from the master"),
      kind: z.enum(["question", "decision"]).default("question").describe("question = you need info/an answer; decision = you need the master to choose or approve a course of action"),
      needs_user: z.boolean().default(false).describe("True if the master must confer with the human user before answering (e.g. scope or policy calls)"),
    },
  }, (args) => handleEscalate(state, args as { message: string; kind: "question" | "decision"; needs_user: boolean }));

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

  // The master/worker coordination protocol is delivered to every connected
  // instance automatically via the `instructions` field (the same mechanism
  // AIMFP uses for its rules) — no per-project CLAUDE.md embedding or paste.
  const server = new McpServer({
    name: "intercomm-aimfp",
    version: "0.4.0",
  }, {
    instructions: loadProtocol(),
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
