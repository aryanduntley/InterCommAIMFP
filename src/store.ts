// Core logic — SQLite-backed operations for all CRUD
// Pure logic + IO operations via db.ts

import { randomUUID } from "node:crypto";
import type {
  Instance,
  InstanceRow,
  Message,
  MessageRow,
  MessageType,
  Role,
  CursorRow,
  Worktree,
  WorktreeRow,
  WorktreeStatus,
} from "./types.js";
import { instanceFromRow, messageFromRow, worktreeFromRow } from "./types.js";
import { STALE_THRESHOLD_MS } from "./config.js";
import { execute, queryOne, queryAll } from "./db.js";

// --- Pure helpers ---

export const nowMs = (): number => Date.now();

export const isStale = (lastActive: number, now: number = nowMs()): boolean =>
  now - lastActive > STALE_THRESHOLD_MS;

export const formatMessageForDisplay = (msg: Message): string =>
  `[${new Date(msg.ts).toLocaleTimeString()}] (${msg.type}) ${msg.fromId} → ${msg.toId}: ${msg.content} [msg_id: ${msg.id}]`;

export const formatInstanceForDisplay = (inst: Instance): string => {
  const status = inst.active && !isStale(inst.lastActive) ? "active" : "inactive";
  const seen = new Date(inst.lastActive).toLocaleTimeString();
  return `  ${inst.id} [${inst.role}] — ${status} (last active: ${seen}, session: ${inst.sessionId.slice(0, 8)})`;
};

export const findLowestAvailableWorkerName = (instances: readonly Instance[]): string => {
  const usedNumbers = instances
    .filter((i) => i.role === "worker" && i.active)
    .map((i) => {
      const match = i.id.match(/^worker-(\d+)$/);
      return match ? parseInt(match[1]!, 10) : -1;
    })
    .filter((n) => n >= 0);

  const usedSet = new Set(usedNumbers);
  let n = 1;
  while (usedSet.has(n)) n++;
  return `worker-${n}`;
};

// --- IO: Instance operations ---

export const registerInstance = (
  id: string,
  role: Role,
  sessionId: string,
  tmuxTarget: string = "",
): Instance => {
  const now = nowMs();
  execute(
    `INSERT OR REPLACE INTO instances (id, role, active, last_active, registered_at, session_id, tmux_target)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    id,
    role,
    now,
    now,
    sessionId,
    tmuxTarget,
  );
  return { id, role, active: true, lastActive: now, registeredAt: now, sessionId, tmuxTarget };
};

export const touchInstance = (id: string): void => {
  execute(`UPDATE instances SET last_active = ? WHERE id = ?`, nowMs(), id);
};

export const deactivateInstance = (id: string): void => {
  execute(`UPDATE instances SET active = 0 WHERE id = ?`, id);
};

export const deactivateAll = (): void => {
  execute(`UPDATE instances SET active = 0`);
};

// Hard-remove an instance row and its read cursor. deactivate only flips active=0
// (preserving the worker-N slot); reap fully frees the name. teardown reaps killed
// workers so a best-effort exit-cleanup that never ran cannot leave a stale
// active=1 row that drifts the next worker's auto-assigned number (note #31).
export const reapInstance = (id: string): void => {
  execute(`DELETE FROM instances WHERE id = ?`, id);
  execute(`DELETE FROM read_cursors WHERE instance_id = ?`, id);
};

export const getInstance = (id: string): Instance | undefined => {
  const row = queryOne<InstanceRow>(
    `SELECT * FROM instances WHERE id = ?`,
    id,
  );
  return row ? instanceFromRow(row) : undefined;
};

export const getAllInstances = (): readonly Instance[] =>
  queryAll<InstanceRow>(`SELECT * FROM instances ORDER BY registered_at`)
    .map(instanceFromRow);

export const getActiveMaster = (): Instance | undefined => {
  const now = nowMs();
  const row = queryOne<InstanceRow>(
    `SELECT * FROM instances WHERE role = 'master' AND active = 1 AND last_active > ?`,
    now - STALE_THRESHOLD_MS,
  );
  return row ? instanceFromRow(row) : undefined;
};

// --- IO: Registration ---

export const registerAs = (
  role: Role,
  sessionId: string,
  tmuxTarget: string = "",
): Instance => {
  if (role === "master") {
    deactivateAll();
    return registerInstance("master", "master", sessionId, tmuxTarget);
  }

  const allInstances = getAllInstances();
  const workerName = findLowestAvailableWorkerName(allInstances);
  return registerInstance(workerName, "worker", sessionId, tmuxTarget);
};

// --- IO: Message operations ---

export const insertMessage = (
  fromId: string,
  toId: string,
  type: MessageType,
  content: string,
): Message => {
  const id = randomUUID();
  const ts = nowMs();
  execute(
    `INSERT INTO messages (id, from_id, to_id, type, content, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    fromId,
    toId,
    type,
    content,
    ts,
  );
  return { id, fromId, toId, type, content, ts };
};

export const readNewMessages = (
  instanceId: string,
  readAll: boolean = false,
): readonly Message[] => {
  const cursor = readAll
    ? 0
    : (queryOne<CursorRow>(
        `SELECT * FROM read_cursors WHERE instance_id = ?`,
        instanceId,
      )?.last_read_seq ?? 0);

  const rows = queryAll<MessageRow & { seq: number }>(
    `SELECT rowid AS seq, * FROM messages
     WHERE (to_id = ? OR to_id = 'all')
       AND from_id != ?
       AND rowid > ?
     ORDER BY rowid`,
    instanceId,
    instanceId,
    cursor,
  );

  // Advance cursor to the highest rowid seen. rowid is monotonic per insert, so
  // same-millisecond messages can no longer slip past a `ts >` boundary.
  if (rows.length > 0) {
    const maxSeq = rows[rows.length - 1]!.seq;
    execute(
      `INSERT OR REPLACE INTO read_cursors (instance_id, last_read_seq) VALUES (?, ?)`,
      instanceId,
      maxSeq,
    );
  }

  touchInstance(instanceId);
  return rows.map(messageFromRow);
};

// --- Pure helpers: worktrees ---

export const formatWorktreeForDisplay = (wt: Worktree): string => {
  const seen = new Date(wt.updatedAt).toLocaleTimeString();
  const branch = wt.branch || "(detached — no branch yet)";
  return `  ${wt.workerId} [${wt.status}] — ${branch} @ ${wt.path} (base: ${wt.base}, updated: ${seen})`;
};

// --- IO: Worktree operations ---

// Record an isolated worktree for a worker. Idempotent on worker_id (re-spawn
// replaces the row). branch starts empty — the worker reports it back later
// (Phase 2), at which point the master fills it via setWorktreeStatus.
export const upsertWorktree = (
  workerId: string,
  path: string,
  base: string,
): Worktree => {
  const now = nowMs();
  execute(
    `INSERT INTO worktrees (worker_id, branch, path, base, status, created_at, updated_at)
     VALUES (?, '', ?, ?, 'active', ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET
       path = excluded.path,
       base = excluded.base,
       status = 'active',
       updated_at = excluded.updated_at`,
    workerId,
    path,
    base,
    now,
    now,
  );
  return {
    workerId,
    branch: "",
    path,
    base,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
};

export const getWorktree = (workerId: string): Worktree | undefined => {
  const row = queryOne<WorktreeRow>(
    `SELECT * FROM worktrees WHERE worker_id = ?`,
    workerId,
  );
  return row ? worktreeFromRow(row) : undefined;
};

export const getAllWorktrees = (): readonly Worktree[] =>
  queryAll<WorktreeRow>(`SELECT * FROM worktrees ORDER BY created_at`)
    .map(worktreeFromRow);

// Update lifecycle status, optionally also recording the branch the worker
// reported (its AIMFP aimfp-worker-N-NNN branch). branch is only overwritten
// when a non-empty value is supplied, so status-only updates preserve it.
export const setWorktreeStatus = (
  workerId: string,
  status: WorktreeStatus,
  branch?: string,
): void => {
  execute(
    `UPDATE worktrees
       SET status = ?,
           branch = CASE WHEN ? <> '' THEN ? ELSE branch END,
           updated_at = ?
     WHERE worker_id = ?`,
    status,
    branch ?? "",
    branch ?? "",
    nowMs(),
    workerId,
  );
};

export const markWorktreeRemoved = (workerId: string): void => {
  setWorktreeStatus(workerId, "removed");
};

export const clearOldMessages = (keep: number): number => {
  // Count total messages
  const countRow = queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM messages`);
  const total = countRow?.cnt ?? 0;
  if (total <= keep) return 0;

  const toDelete = total - keep;
  execute(
    `DELETE FROM messages WHERE id IN (
      SELECT id FROM messages ORDER BY ts ASC LIMIT ?
    )`,
    toDelete,
  );
  return toDelete;
};
