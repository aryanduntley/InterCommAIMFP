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
