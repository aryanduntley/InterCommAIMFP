# InterComm AIMFP

Local-only coordination system for multiple Claude Code instances working on the same project. One instance is master, the rest are workers. The master delegates tasks and controls workers via tmux. All state lives in a single SQLite database — no servers, no HTTP, no sockets.

**Requires tmux.**

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  User ↔ Master (Claude Code)                        │
│    │                                                │
│    ├── tmux send-keys ──→ Worker-1 (tmux session)   │
│    ├── tmux send-keys ──→ Worker-2 (tmux session)   │
│    └── tmux send-keys ──→ Worker-N (tmux session)   │
│                                                     │
│  All instances share: .intercomm-aimfp/intercomm.db  │
└─────────────────────────────────────────────────────┘
```

1. The user talks to the **master** instance only.
2. The user either tells the master "I have N tmux sessions available" or the master asks "please spin up N tmux sessions for this task."
3. The master writes tasks to the shared DB via `intercomm_send`, then **wakes** workers via `tmux send-keys`.
4. Workers register, read their task, do the work, and report `done` via InterComm.
5. Workers do **not** poll. They sit idle until the master pushes a prompt via tmux.

## Install

1. Copy the `intercommAIMFP/` folder somewhere permanent on your machine.

2. Install dependencies and build:
   ```bash
   cd /path/to/intercommAIMFP
   npm install
   npm run build
   ```

3. Add the MCP server to your project's `.mcp.json` (create it in your project root if it doesn't exist):
   ```json
   {
     "mcpServers": {
       "intercomm": {
         "command": "node",
         "args": ["/absolute/path/to/intercommAIMFP/dist/mcp-entry.js"]
       }
     }
   }
   ```
   Replace `/absolute/path/to/intercommAIMFP` with the actual path on your machine.

4. Add the contents of `system-prompt.md` to each Claude Code instance's system prompt (paste it into your Claude settings or CLAUDE.md).

## Usage

The master spawns and controls workers itself — no manual tmux setup required. The helper scripts live in `scripts/`.

### 1. Register the master

In your main Claude Code instance, register as master (via the `intercomm_register(role: "master")` tool, or just tell it "you are the master"). This must happen **before** spawning workers, so workers can message `master` on startup.

### 2. Spawn workers automatically

From the master, run:

```bash
scripts/spawn-workers.sh 3
```

This creates 3 detached tmux sessions (`worker-1`, `worker-2`, `worker-3`), launches Claude Code in each (in the project dir, so they load `.mcp.json` + `CLAUDE.md`), waits for each to boot, and auto-wakes them to register and read their task. Each worker reports its `tmux-session ↔ worker-N` mapping back to the master, so the master knows which pane is which.

Useful options:

| Option | Effect |
|---|---|
| `--bypass` | Launch workers in `bypassPermissions` mode (fully hands-off; no approval needed) |
| `--perm-mode <mode>` | Set `claude --permission-mode` explicitly (default: `acceptEdits`) |
| `--no-wake` | Create + launch only; master wakes them itself later |
| `--prefix <name>` | tmux session-name prefix (default: `worker`) |
| `--project <dir>` | Project dir to launch in (default: current dir) |
| `--ready-timeout <s>` | Boot wait per worker (default: 30) |

### 3. Approve flagged permission prompts

In the default `acceptEdits` mode, workers auto-accept file edits but **pause on Bash and other tools**. A blocked worker is frozen and cannot report over InterComm, so the master polls for them:

```bash
scripts/scan-workers.sh
```

For any worker reported as `blocked`, the scan prints the pending command and how to answer it. Approve (or deny) by sending the option number:

```bash
tmux send-keys -t worker-1 "1" Enter    # 1 = Yes, 3 = No
```

(Verified: the master can read a worker's permission dialog via `tmux capture-pane` and select an option via `tmux send-keys`.) To skip approvals entirely, spawn with `--bypass`.

### 4. Let it run, then tear down

The master delegates via `intercomm_send(type: "task")`, wakes workers via `tmux send-keys`, monitors with `tmux capture-pane` / `intercomm_read` / `scan-workers.sh`, and collects results. When done:

```bash
scripts/kill-workers.sh
```

### Tips

- **Extra Enter for prompt submission:** When waking workers manually via `tmux send-keys`, send an extra `Enter` so the prompt actually submits in Claude Code: `tmux send-keys -t <pane> "message" Enter Enter`. (The spawn script already does this.)
- **Manual alternative:** You can still create sessions by hand (`tmux new-session -d -s worker-1 -c /path/to/project; tmux send-keys -t worker-1 "claude --permission-mode acceptEdits" Enter`) if you prefer.

## MCP Tools (7 total)

| Tool | Description |
|---|---|
| `intercomm_register` | Register as master or worker. Initializes DB. Workers auto-assign lowest available `worker-N` name. |
| `intercomm_send` | Send a direct message to a specific peer. |
| `intercomm_broadcast` | Broadcast a message to all peers. |
| `intercomm_read` | Read all new messages since last check. Updates read cursor. |
| `intercomm_status` | Show all instances and their state. |
| `intercomm_signoff` | Cleanly deactivate this instance before shutting down. |
| `intercomm_clear` | Delete old messages (master-only). |

## Message Types

| Type | Purpose |
|---|---|
| `task` | Master assigns work to a worker |
| `status` | Instance reports progress |
| `question` | Instance asks for input |
| `answer` | Response to a question |
| `announce` | Broadcast information to all |
| `done` | Instance signals task completion |

## Storage

All state is stored in `.intercomm-aimfp/intercomm.db` (SQLite, WAL mode) created in the project root. Three tables: `instances`, `messages`, `read_cursors`.

## Stale Detection

Every tool call updates the instance's `last_active` timestamp. An instance is considered stale after **30 seconds** of inactivity. If the master goes stale, a worker can claim master via `intercomm_register(role: "master")`.

## Troubleshooting

### MCP server fails to start after a Node.js upgrade

`better-sqlite3` is a native (C++) addon compiled against a specific Node.js ABI. If you upgrade Node.js (via `nvm`, a system update, etc.), the prebuilt binary no longer loads and the MCP server exits immediately on startup — so every tool call fails. The give-away error (visible by running the entry point directly) looks like:

```
The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 131. This version of Node.js requires
NODE_MODULE_VERSION 137.
```

**Fix:** rebuild the native module against your current Node.js:

```bash
cd /path/to/intercommAIMFP
npm rebuild better-sqlite3   # or: npm install
```

To diagnose MCP startup failures in general, run the entry point manually and watch stderr:

```bash
node dist/mcp-entry.js   # prints "InterComm AIMFP MCP server error: ..." on failure
```

## Known Limitations

### Worker Permission Prompts

Claude Code requires approval for certain tool calls (e.g., running bash commands). When a worker hits a permission prompt it **blocks** until answered, and while blocked it cannot report over InterComm — so the master must detect blocked workers by polling their panes.

This is handled, not eliminated:
- Workers are spawned in `acceptEdits` mode by default (file edits auto-approved; Bash/other still prompt).
- `scripts/scan-workers.sh` polls every worker pane and reports which are blocked, with the pending command.
- The master approves via `tmux send-keys -t <session> "1" Enter` (verified: the dialog is readable via `capture-pane` and selectable via `send-keys`).

**Reduce or remove the prompts further:**
- Spawn with `--bypass` (`bypassPermissions`) for fully hands-off workers (use with caution — workers run anything unprompted).
- Pre-approve common operations in `.claude/settings.local.json` (`permissions.allow`), e.g. `Bash(npm run:*)`. The InterComm MCP tools are already allowlisted in this repo.

### tmux Prompt Submission

Claude Code's input requires an extra `Enter` keystroke to submit prompts sent via `tmux send-keys`. Always use `Enter Enter` (double Enter) when waking workers.

## CLI (Debug)

The CLI is for debugging only — normal usage is through MCP tools.

```
intercomm status                                      Show all instances
intercomm send --from <id> <to> <message> [--type t]  Send a direct message
intercomm broadcast --from <id> <message> [--type t]  Broadcast to all
intercomm read --id <id> [--all]                      Read new messages
intercomm clear [--keep <n>]                          Clear old messages (default: keep 100)
```
