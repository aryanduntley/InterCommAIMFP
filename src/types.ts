// Data contracts for InterComm AIMFP

export type Role = "master" | "worker";

export type MessageType =
  | "task"
  | "status"
  | "question"
  | "answer"
  | "announce"
  | "done";

export type Instance = {
  readonly id: string;
  readonly role: Role;
  readonly active: boolean;
  readonly lastActive: number;
  readonly registeredAt: number;
  readonly sessionId: string;
  readonly tmuxTarget: string;
};

export type Message = {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly type: MessageType;
  readonly content: string;
  readonly ts: number;
};

export type ReadCursor = {
  readonly instanceId: string;
  readonly lastReadSeq: number;
};

// Row types matching SQLite schema (snake_case columns)
export type InstanceRow = {
  id: string;
  role: string;
  active: number;
  last_active: number;
  registered_at: number;
  session_id: string;
  tmux_target: string;
};

export type MessageRow = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  content: string;
  ts: number;
};

export type CursorRow = {
  instance_id: string;
  last_read_seq: number;
};

// Conversion helpers (pure)
export const instanceFromRow = (row: InstanceRow): Instance => ({
  id: row.id,
  role: row.role as Role,
  active: row.active === 1,
  lastActive: row.last_active,
  registeredAt: row.registered_at,
  sessionId: row.session_id,
  tmuxTarget: row.tmux_target,
});

export const messageFromRow = (row: MessageRow): Message => ({
  id: row.id,
  fromId: row.from_id,
  toId: row.to_id,
  type: row.type as MessageType,
  content: row.content,
  ts: row.ts,
});

export type ParsedArgs = {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
};

// --- Task contract (Phase 2: directive-driven tasking, thin-pointer model) ---
//
// The JSON payload a master sends a worker inside messages.content (type
// "task"). InterComm stays AIMFP-agnostic: it only carries this contract as
// opaque message content — it never resolves the pointer and never reads
// project.db. On wake, the worker runs aimfp_run(is_new_session=true) in its
// own clone and continues the referenced AIMFP entity the normal way (its own
// git_create_branch on aimfp-{user}-{number}, its own tracking + validation).
//
//   role              — the worker's role label (e.g. "worker")
//   role_instructions — free-form role guidance / enforcement for the worker
//   aimfp_target      — pointer to the AIMFP work entity the worker continues
//   reportBack        — field names the worker sends back on completion (e.g.
//                       "branch", "commit") so the master can export a changeset

// The AIMFP work-hierarchy tables a contract can point at.
export type AimfpTargetType =
  | "task"
  | "milestone"
  | "subtask"
  | "sidequest"
  | "item";

// Pointer to an AIMFP work entity. `type` names the table; identity is an
// integer `id` and/or a stable `slug` — at least one must be present. InterComm
// carries this opaquely; AIMFP resolves it on the worker side via aimfp_run.
export type AimfpTarget = {
  readonly type: AimfpTargetType;
  readonly id?: number;
  readonly slug?: string;
};

export type TaskContract = {
  readonly role: string;
  readonly role_instructions: string;
  readonly aimfp_target: AimfpTarget;
  readonly reportBack: readonly string[];
};

// Result of parseTaskContract — a never-throws discriminated union so a worker
// can reject a malformed task instead of acting on garbage.
export type ParsedTaskContract =
  | { readonly ok: true; readonly contract: TaskContract }
  | { readonly ok: false; readonly error: string };

// --- Worktree registry (multi-agent parallelization addon) ---
//
// Single source of truth for the worktree lifecycle. The status set is a
// superset informed by ctx's agent merge queue (queued / verifying / conflict)
// layered onto the original design states. InterComm only TRACKS these — it
// never merges; AIMFP git directives own the actual branch/merge semantics.
//
//   active    — worker is editing inside its worktree
//   done      — worker reported its task complete (ready to submit)
//   queued    — submitted to the master's merge queue, awaiting its turn
//   merging   — master is merging the branch (AIMFP git_merge_branch)
//   verifying — verification command running on the merged result (ctx gate)
//   merged    — applied + verified; target branch advanced
//   conflict  — could not apply cleanly on the latest target; back for revision
//   failed    — applied but verification failed (or an execution error)
//   removed   — worktree torn down
export const WORKTREE_STATUSES = [
  "active",
  "done",
  "queued",
  "merging",
  "verifying",
  "merged",
  "conflict",
  "failed",
  "removed",
] as const;

export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export type Worktree = {
  readonly workerId: string;
  readonly branch: string;
  readonly path: string;
  readonly base: string;
  readonly status: WorktreeStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type WorktreeRow = {
  worker_id: string;
  branch: string;
  path: string;
  base: string;
  status: string;
  created_at: number;
  updated_at: number;
};

export const worktreeFromRow = (row: WorktreeRow): Worktree => ({
  workerId: row.worker_id,
  branch: row.branch,
  path: row.path,
  base: row.base,
  status: row.status as WorktreeStatus,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
