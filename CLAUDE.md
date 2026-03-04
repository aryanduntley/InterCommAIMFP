# InterComm AIFP — Development Guidelines

## Project Purpose

InterComm AIFP is a local-only intercommunication system that enables multiple Claude Code instances to coordinate in real time while working on the same project. The master instance controls workers via tmux — pushing prompts directly instead of workers polling. All state is stored in a single SQLite database — no servers, no HTTP, no sockets.

**Requires tmux.** Workers run in tmux sessions. The master wakes them via `tmux send-keys`.

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

- **instances**: id, role, active flag, last_active timestamp, registered_at timestamp, session_id
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
  store.ts          # Core logic — SQLite-backed CRUD, registration
  cli.ts            # CLI entry point — debug-only interface
  mcp-server.ts     # MCP server — 7 tool handlers, auto-init
  mcp-entry.ts      # MCP STDIO entry point (shebang, no console.log)
```

- Each file has a single responsibility.
- Imports flow downward: `cli → store → db → config/types`.
- MCP flow: `mcp-entry → mcp-server → store → db → config/types`.
- No circular dependencies.

## MCP Tools (7 total)

### Registration
| Tool | Description |
|---|---|
| `intercomm_register` | Register as master or worker. Initializes DB. Workers auto-assign lowest available worker-N name. |

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
| `intercomm_signoff` | Cleanly deactivate this instance before shutting down |
| `intercomm_clear` | Delete old messages (master-only) |

## InterComm Protocol

### Role Enforcement

**Critical: If this instance is registered as a worker, it MUST NOT attempt any master-role actions.** Specifically, workers must:
- **Never** interact with the user directly — all communication goes through InterComm to the master
- **Never** delegate tasks to other workers
- **Never** use `tmux send-keys` to control other instances
- **Never** use `intercomm_clear` (master-only)
- **Never** call `intercomm_register(role: "master")` unless the master has been stale for 30+ seconds
- **Only** do their assigned task, report progress, ask questions via InterComm, and signal completion

Workers are subordinates. They execute, report, and stop. The master is the sole coordinator.

### Startup Sequence

One step: call `intercomm_register(role)`.

- The user tells one instance to be master: `intercomm_register(role: "master")`.
- All other instances call `intercomm_register()` (defaults to worker) and receive an auto-assigned `worker-N` name.
- After registering, call `intercomm_status` to confirm identity and see active peers.

### tmux-Push Model (No Polling)

Workers do **not** poll for messages. The master pushes prompts directly via tmux:

1. Master writes a task to the DB: `intercomm_send(to: "worker-1", message: "...", type: "task")`
2. Master wakes the worker: `tmux send-keys -t <pane> "Read your task: call intercomm_read()" Enter Enter` (extra Enter ensures prompt submission in Claude Code)
3. Worker reads, executes, sends `done` back via InterComm
4. Worker stops and waits — master will wake it again if needed

This eliminates wasted tool calls from polling loops.

### Master Behavior

As master, you are the only instance the user interacts with:

1. **Negotiate workers.** The user tells you how many tmux sessions are available, or you ask the user to spin up N sessions for a task.
2. **Delegate work.** Write the task to the DB via `intercomm_send`, then wake the worker via `tmux send-keys`.
3. **Monitor progress.** Check worker output via `tmux capture-pane -t <pane> -p | tail -20` or read InterComm messages via `intercomm_read`.
4. **Answer questions.** When you see `question` messages, respond via `intercomm_send` and wake the worker via tmux.
5. **Broadcast coordination.** Use `intercomm_broadcast` for information that affects all workers.
6. **Housekeeping.** Call `intercomm_clear` periodically to keep the message table bounded.

### Worker Behavior

As a worker, you execute tasks and report back. **You operate autonomously — do NOT ask the user for input or confirmation. All communication goes through InterComm to the master. The user interacts only with the master instance.**

1. **Register.** Call `intercomm_register()` when prompted by master via tmux.
2. **Read your task.** Call `intercomm_read` to get your assignment.
3. **Acknowledge.** Send a `status` message confirming you've started.
4. **Do the work.** Execute the task autonomously.
5. **Ask when blocked.** Send a `question` to master via InterComm. Then wait — master will wake you via tmux with the answer.
6. **Signal completion.** Send `done` with a summary of work.
7. **Stop.** After sending `done`, do nothing. Master will wake you if there's more work.

**Do NOT poll. Do NOT ask the user. Work, report, stop.**

### Edge Cases

- **Master dies or goes stale:** If master hasn't been active for 30+ seconds (check `intercomm_status`), a worker may call `intercomm_register(role: "master")` to take over.
- **Question goes unanswered:** Wait for master to wake you. Do not poll.
- **You're the only instance:** Work normally as both master and sole worker.

## Stale Instance Detection

- Every tool call updates `last_active` for the calling instance.
- Stale threshold: **30 seconds**.
- Registering as master sets ALL other instances to `active = 0`.
- Best-effort: `process.on("exit"/"SIGINT")` sets `active = 0`.

## Message Types

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
- Workers must not assume master responsibilities — see Role Enforcement above.
