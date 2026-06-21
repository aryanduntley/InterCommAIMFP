// SQLite wrapper — thin IO layer over better-sqlite3

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { basePath, dbFile, resolveDbRoot, ENV_DB_ROOT } from "./config.js";
import { ensureDir } from "./fs-wrapper.js";
import { gitCommonDir } from "./git-wrapper.js";
import { WORKTREE_STATUSES } from "./types.js";

let db: DatabaseType | null = null;

// Build the CHECK clause from the single source of truth in types.ts so the
// schema can never drift from the WorktreeStatus union.
const WORKTREE_STATUS_CHECK = WORKTREE_STATUSES.map((s) => `'${s}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('master', 'worker')),
  active INTEGER NOT NULL DEFAULT 1,
  last_active INTEGER NOT NULL,
  registered_at INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN (
    'task', 'status', 'question', 'answer', 'announce', 'done'
  )),
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS read_cursors (
  instance_id TEXT NOT NULL,
  last_read_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id)
);

CREATE TABLE IF NOT EXISTS worktrees (
  worker_id   TEXT PRIMARY KEY,
  branch      TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL,
  base        TEXT NOT NULL DEFAULT 'main',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK(status IN (${WORKTREE_STATUS_CHECK})),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

// Migration for existing DBs that lack session_id column
const migrateSchema = (database: DatabaseType): void => {
  const columns = database.prepare("PRAGMA table_info(instances)").all() as { name: string }[];
  const hasSessionId = columns.some((col) => col.name === "session_id");
  if (!hasSessionId) {
    database.exec("ALTER TABLE instances ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  }
};

export const initDb = (root: string): DatabaseType => {
  if (db) return db;

  ensureDir(basePath(root));
  const path = dbFile(root);
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
};

export const getDb = (): DatabaseType => {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
};

export const closeDb = (): void => {
  if (db) {
    db.close();
    db = null;
  }
};

export const execute = (sql: string, ...params: unknown[]): void => {
  getDb().prepare(sql).run(...params);
};

export const queryOne = <T>(sql: string, ...params: unknown[]): T | undefined =>
  getDb().prepare(sql).get(...params) as T | undefined;

export const queryAll = <T>(sql: string, ...params: unknown[]): T[] =>
  getDb().prepare(sql).all(...params) as T[];

// IO composition: gather the env override + git common dir, then defer to the
// pure resolveDbRoot. Both entry points (mcp-entry, cli) call this so every
// instance — including workers launched inside isolated worktrees — attaches to
// the one shared intercomm.db at the repo root.
export const resolveRoot = (cwd: string): string =>
  resolveDbRoot({
    cwd,
    envRoot: process.env[ENV_DB_ROOT],
    gitCommonDir: gitCommonDir(cwd),
  });
