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
import { execute, queryOne, queryAll, getDb } from "./db.js";

// --- Pure helpers ---

export const nowMs = (): number => Date.now();

export const isStale = (lastActive: number, now: number = nowMs()): boolean =>
  now - lastActive > STALE_THRESHOLD_MS;

export const formatMessageForDisplay = (msg: Message): string =>
  `[${new Date(msg.ts).toLocaleTimeString()}] (${msg.type}) ${msg.fromId} → ${msg.toId}: ${msg.content}`;

export const formatInstanceForDisplay = (inst: Instance): string => {
  const status = inst.active && !isStale(inst.lastActive) ? "active" : "inactive";
  const seen = new Date(inst.lastActive).toLocaleTimeString();
  return `  ${inst.id} [${inst.role}] — ${status} (last active: ${seen})`;
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

export const registerInstance = (id: string, role: Role): Instance => {
  const now = nowMs();
  execute(
    `INSERT OR REPLACE INTO instances (id, role, active, last_active, registered_at)
     VALUES (?, ?, 1, ?, ?)`,
    id,
    role,
    now,
    now,
  );
  return { id, role, active: true, lastActive: now, registeredAt: now };
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

export const pollByType = (
  instanceId: string,
  type: MessageType,
): readonly Message[] => {
  const cursor = queryOne<CursorRow>(
    `SELECT * FROM read_cursors WHERE instance_id = ?`,
    instanceId,
  )?.last_read_ts ?? 0;

  const rows = queryAll<MessageRow>(
    `SELECT * FROM messages
     WHERE (to_id = ? OR to_id = 'all')
       AND type = ?
       AND ts > ?
     ORDER BY ts`,
    instanceId,
    type,
    cursor,
  );

  // Don't update cursor — poll is a peek for a specific type
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

// --- IO: Identity negotiation ---

export const createIdentityRequest = (): Message => {
  // Use a temp ID until master assigns one
  const tempId = `pending-${randomUUID().slice(0, 8)}`;
  const msg = insertMessage(tempId, "all", "identity-request", tempId);
  return msg;
};

export const assignIdentity = (requestId: string): { assignedId: string; message: Message } | { error: string } => {
  // Find the identity-request message
  const requestRow = queryOne<MessageRow>(
    `SELECT * FROM messages WHERE id = ? AND type = 'identity-request'`,
    requestId,
  );
  if (!requestRow) return { error: `No identity-request found with id "${requestId}"` };

  const pendingId = requestRow.from_id;

  // Find the lowest available worker name
  const allInstances = getAllInstances();
  const assignedId = findLowestAvailableWorkerName(allInstances);

  // Register the new worker
  registerInstance(assignedId, "worker");

  // Send identity-response back, addressed to the pending ID
  const response = insertMessage("master", pendingId, "identity-response", assignedId);

  return { assignedId, message: response };
};

export const assumeMaster = (): { success: true; instance: Instance } | { success: false; error: string } => {
  const existing = getActiveMaster();
  if (existing) {
    return { success: false, error: `Active master "${existing.id}" already exists (last active: ${new Date(existing.lastActive).toLocaleTimeString()})` };
  }

  // Set all instances inactive, then register self as master
  deactivateAll();
  const instance = registerInstance("master", "master");
  return { success: true, instance };
};

// --- IO: Identity polling (for pending instances) ---

export const pollIdentityResponse = (requestId: string): Message | undefined => {
  const row = queryOne<MessageRow>(
    `SELECT m.* FROM messages m
     WHERE m.type = 'identity-response'
       AND m.to_id = (SELECT from_id FROM messages WHERE id = ?)`,
    requestId,
  );
  return row ? messageFromRow(row) : undefined;
};
