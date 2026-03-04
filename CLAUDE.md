# InterComm AIFP — Development Guidelines

## Project Purpose

InterComm AIFP is a local-only intercommunication system that enables multiple Claude Code instances to coordinate in real time while working on the same project. Instances negotiate identity automatically: one becomes master, others become workers. All state is stored in a single SQLite database — no servers, no HTTP, no sockets.

## Architecture

```
InterCommAIFP/              # Distributable folder
  dist/                     # Compiled JS
  src/                      # TypeScript source
  system-prompt.md          # Instructions for user's Claude system prompt
  package.json
  README.md

.intercomm-aifp/            # Runtime data (created by master in project dir)
  intercomm.db              # SQLite (WAL mode) — all state + messages
```

## SQLite Schema

Three tables: `instances`, `messages`, `read_cursors`. See `src/db.ts` for the full schema.

- **instances**: id, role, active flag, last_active timestamp, registered_at timestamp
- **messages**: id, from_id, to_id, type, content, timestamp
- **read_cursors**: instance_id, last_read_ts (for incremental message reads)

## Code Style — Mandatory Constraints

### Functional Procedural (FP) Only

- **No classes. No `class` keyword. No `new` (except for built-in errors).** No OOP patterns.
- All code is composed of **pure functions** and **thin IO wrappers**.
- Data flows through functions via arguments and return values — never via `this` or instance state.
- Use **plain objects** and **type aliases/interfaces** for data shapes — they are not OOP, they are data contracts.

### Pure vs IO Separation

- **Pure functions** take inputs, return outputs, cause no side effects. The bulk of logic lives here.
- **IO functions** (database reads/writes, filesystem, console output) are thin wrappers isolated to specific modules (`db.ts`, `fs-wrapper.ts`, `cli.ts`). They call pure functions for all logic.
- Name IO functions with a verb prefix that signals side effects: `initDb`, `execute`, `queryAll`, `ensureDir`.

### DRY — Ruthlessly

- If a pattern appears twice, extract it into a function.
- Single source of truth for paths, constants, message formatting, DB operations.
- No copy-paste with slight variations — parameterize instead.

### Function Design

- Functions do **one thing**.
- Prefer **data in, data out** — pass values, return values.
- Avoid mutable state. Use `const`, spread operators, and `map`/`filter`/`reduce` over mutation.
- When mutation is unavoidable (e.g., server state ref), isolate it to the smallest possible scope.

### Dependencies

- **Minimize external dependencies.** The standard library is preferred.
- Runtime deps: `@modelcontextprotocol/sdk`, `zod` (MCP server), `better-sqlite3` (database).
- Dev deps: `typescript`, `@types/node`, `@types/better-sqlite3`.

### Error Handling

- Return error states as data (union types, result objects) rather than throwing, where practical.
- Throwing is acceptable at the CLI boundary for fatal errors (bad args, missing config).
- Never silently swallow errors.

## File Organization

```
src/
  types.ts          # Type definitions — Instance, Message, MessageType, etc.
  config.ts         # Pure functions for paths and constants
  db.ts             # SQLite wrapper: initDb(), query(), execute(), getDb()
  fs-wrapper.ts     # Thin IO wrapper — ensureDir only
  store.ts          # Core logic — SQLite-backed CRUD, identity negotiation
  cli.ts            # CLI entry point — debug-only interface
  mcp-server.ts     # MCP server — 10 tool handlers, auto-init
  mcp-entry.ts      # MCP STDIO entry point (shebang, no console.log)
```

- Each file has a single responsibility.
- Imports flow downward: `cli → store → db → config/types`.
- MCP flow: `mcp-entry → mcp-server → store → db → config/types`.
- No circular dependencies.

## MCP Tools (10 total)

### Bootstrap Tools (called in order at startup)
| Tool | Description |
|---|---|
| `intercomm_init` | Create `.intercomm-aifp/` and DB if not exists |
| `intercomm_request_identity` | Announce need for a name, get temp request ID |
| `intercomm_poll` | Check for messages of a specific type |
| `intercomm_assume_master` | Claim master role (only if no active master) |
| `intercomm_assign_identity` | Master assigns worker-N name to pending instance |

### Communication Tools
| Tool | Description |
|---|---|
| `intercomm_send` | Send direct message to a specific peer |
| `intercomm_broadcast` | Send message to all peers |
| `intercomm_read` | Read all new messages, update cursor |

### Management Tools
| Tool | Description |
|---|---|
| `intercomm_status` | Show all instances and their state |
| `intercomm_clear` | Delete old messages (master-only) |

## Startup Flow

See `system-prompt.md` for the full startup sequence that instances follow.

## Stale Instance Detection

- Every tool call updates `last_active` for the calling instance.
- Stale threshold: **30 seconds**.
- `intercomm_assume_master` refuses if an active master exists (last_active < 30s).
- New master sets ALL other instances to `active = 0`.
- Best-effort: `process.on("exit"/"SIGINT")` sets `active = 0`.

## Message Types

- `identity-request` — new instance needs a name
- `identity-response` — master assigns a name
- `task` — master assigns work
- `status` — instance reports progress
- `question` — instance asks for input
- `answer` — response to a question
- `announce` — broadcast information
- `done` — instance signals task completion

## What NOT To Do

- Do not add HTTP, WebSocket, or network-based servers.
- Do not introduce OOP patterns — no classes, no inheritance, no `this` (except the two MCP SDK instantiations in `mcp-server.ts`).
- Do not add heavy dependencies (no Express, no Commander.js, no ORMs).
- Do not over-engineer — this is a coordination tool, not a chat platform.
- Do not add features beyond what's needed for project coordination between Claude Code instances.
