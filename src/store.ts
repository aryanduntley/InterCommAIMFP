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
} from "./types.js";
import { instanceFromRow, messageFromRow } from "./types.js";
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

export const registerInstance = (id: string, role: Role, sessionId: string): Instance => {
  const now = nowMs();
  execute(
    `INSERT OR REPLACE INTO instances (id, role, active, last_active, registered_at, session_id)
     VALUES (?, ?, 1, ?, ?, ?)`,
    id,
    role,
    now,
    now,
    sessionId,
  );
  return { id, role, active: true, lastActive: now, registeredAt: now, sessionId };
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
): Instance => {
  if (role === "master") {
    deactivateAll();
    return registerInstance("master", "master", sessionId);
  }

  const allInstances = getAllInstances();
  const workerName = findLowestAvailableWorkerName(allInstances);
  return registerInstance(workerName, "worker", sessionId);
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
      )?.last_read_ts ?? 0);

  const rows = queryAll<MessageRow>(
    `SELECT * FROM messages
     WHERE (to_id = ? OR to_id = 'all')
       AND from_id != ?
       AND ts > ?
     ORDER BY ts`,
    instanceId,
    instanceId,
    cursor,
  );

  // Update cursor to latest message timestamp
  if (rows.length > 0) {
    const maxTs = rows[rows.length - 1]!.ts;
    execute(
      `INSERT OR REPLACE INTO read_cursors (instance_id, last_read_ts) VALUES (?, ?)`,
      instanceId,
      maxTs,
    );
  }

  touchInstance(instanceId);
  return rows.map(messageFromRow);
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
