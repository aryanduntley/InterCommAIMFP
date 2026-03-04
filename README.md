# InterComm AIFP

Local-only intercommunication system that enables multiple Claude Code instances to coordinate in real time while working on the same project. Instances negotiate identity automatically — one becomes master, others become workers. All state lives in a single SQLite database. No servers, no HTTP, no sockets.

## Install

1. Copy the `InterCommAIFP/` folder somewhere permanent on your machine.

2. Install dependencies and build:
   ```bash
   cd /path/to/InterCommAIFP
   npm install
   npm run build
   ```

3. Add the MCP server to your project's `.mcp.json` (create it in your project root if it doesn't exist):
   ```json
   {
     "mcpServers": {
       "intercomm": {
         "command": "node",
         "args": ["/absolute/path/to/InterCommAIFP/dist/mcp-entry.js"]
       }
     }
   }
   ```
   Replace `/absolute/path/to/InterCommAIFP` with the actual path on your machine.

4. Add the contents of `system-prompt.md` to each Claude Code instance's system prompt (paste it into your Claude settings or CLAUDE.md).

5. Open multiple Claude Code terminals in the same project. Each instance auto-discovers the MCP tools and negotiates its role.

## How It Works

### Startup Flow

1. The first instance calls `intercomm_request_identity` and gets a temporary ID.
2. It polls for an `identity-response`. No master exists, so none arrives.
3. After 30 seconds with no response, it calls `intercomm_assume_master` and becomes master.
4. Subsequent instances call `intercomm_request_identity`. The master sees `identity-request` messages via `intercomm_read` and calls `intercomm_assign_identity` to assign them `worker-1`, `worker-2`, etc.

### Stale Detection

Every tool call updates the instance's `last_active` timestamp. An instance is considered stale after **30 seconds** of inactivity. If the master goes stale, a new instance can claim master via `intercomm_assume_master`, which deactivates all existing instances first.

### Storage

All state is stored in `.intercomm-aifp/intercomm.db` (SQLite, WAL mode) created in the project root. Three tables: `instances`, `messages`, `read_cursors`.

## MCP Tools

### Bootstrap (called in order at startup)

| Tool | Params | Description |
|---|---|---|
| `intercomm_init` | — | Create `.intercomm-aifp/` directory and DB. Called automatically at server start. |
| `intercomm_request_identity` | — | Announce you need a role. Inserts an `identity-request` message. Returns a temp request ID. |
| `intercomm_poll` | `type` (string) | Check for new messages of a specific type. Used to wait for `identity-response` during startup. |
| `intercomm_assume_master` | — | Claim master role. Fails if an active master exists (last active < 30s). Deactivates all other instances. |
| `intercomm_assign_identity` | `request_id` (string) | Master-only. Assigns lowest available `worker-N` name to a pending instance. Sends `identity-response` back. |

### Communication

| Tool | Params | Description |
|---|---|---|
| `intercomm_send` | `to` (string), `message` (string), `type` (string, default: `"status"`) | Send a direct message to a specific peer. |
| `intercomm_broadcast` | `message` (string), `type` (string, default: `"announce"`) | Send a message to all registered peers. |
| `intercomm_read` | `all` (boolean, default: `false`) | Read all new messages since last check. Set `all: true` to re-read from the beginning. Updates read cursor. |

### Management

| Tool | Params | Description |
|---|---|---|
| `intercomm_status` | — | Show all instances: id, role, active/inactive, last active time. |
| `intercomm_clear` | `keep` (number, default: `100`) | Master-only. Delete old messages, keeping the most recent `keep` messages. |

## Message Types

| Type | Purpose |
|---|---|
| `identity-request` | New instance announces it needs a name |
| `identity-response` | Master assigns a worker name |
| `task` | Master assigns work to a worker |
| `status` | Instance reports progress |
| `question` | Instance asks for input |
| `answer` | Response to a question |
| `announce` | Broadcast information to all |
| `done` | Instance signals task completion |

## System Prompt Addon

Copy the contents of [`system-prompt.md`](system-prompt.md) into your Claude Code system prompt or `CLAUDE.md`. This gives each instance the full protocol for startup, communication, and role-specific behavior.

## CLI Reference (Debug)

The CLI is for debugging only — normal usage is through MCP tools.

```
intercomm init                                        Initialize DB
intercomm status                                      Show all instances
intercomm assume-master                               Become master
intercomm send --from <id> <to> <message> [--type t]  Send a direct message
intercomm broadcast --from <id> <message> [--type t]  Broadcast to all
intercomm read --id <id> [--all]                      Read new messages
intercomm clear [--keep <n>]                           Clear old messages (default: keep 100)
```

Message types for `--type`: `task`, `status`, `question`, `answer`, `announce`, `done`
