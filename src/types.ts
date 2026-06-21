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
  readonly lastReadTs: number;
};

// Row types matching SQLite schema (snake_case columns)
export type InstanceRow = {
  id: string;
  role: string;
  active: number;
  last_active: number;
  registered_at: number;
  session_id: string;
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
  last_read_ts: number;
};

// Conversion helpers (pure)
export const instanceFromRow = (row: InstanceRow): Instance => ({
  id: row.id,
  role: row.role as Role,
  active: row.active === 1,
  lastActive: row.last_active,
  registeredAt: row.registered_at,
  sessionId: row.session_id,
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
