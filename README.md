# InterComm AIFP

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
│  All instances share: .intercomm-aifp/intercomm.db  │
└─────────────────────────────────────────────────────┘
```

1. The user talks to the **master** instance only.
2. The user either tells the master "I have N tmux sessions available" or the master asks "please spin up N tmux sessions for this task."
3. The master writes tasks to the shared DB via `intercomm_send`, then **wakes** workers via `tmux send-keys`.
4. Workers register, read their task, do the work, and report `done` via InterComm.
5. Workers do **not** poll. They sit idle until the master pushes a prompt via tmux.

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

## Usage

### 1. Start tmux sessions

Open a terminal and create tmux sessions for your workers:

```bash
# Create worker sessions (each will run Claude Code)
tmux new-session -d -s worker1
tmux new-session -d -s worker2

# Start Claude Code in each
tmux send-keys -t worker1 "cd /path/to/your/project && claude" Enter
tmux send-keys -t worker2 "cd /path/to/your/project && claude" Enter
```

### 2. Tell the master

In your main Claude Code instance (the master):

> "I have 2 tmux worker sessions available: worker1 and worker2"

The master will register itself, send tasks to workers via the DB, and wake them via `tmux send-keys`.

### 3. Let it run

The master handles everything: task delegation, monitoring progress (via `tmux capture-pane` and `intercomm_read`), answering worker questions, and collecting results.

### Tips

- **Extra Enter for prompt submission:** When waking workers via `tmux send-keys`, send an extra `Enter` to ensure the prompt is actually submitted in Claude Code: `tmux send-keys -t <pane> "message" Enter Enter`
- **Permission prompts:** Workers may hit tool permission prompts (e.g., "Do you want to proceed?") that block execution. The master can approve these remotely via `tmux send-keys -t <pane> Enter`, but this requires monitoring. See [Known Limitations](#known-limitations) below.

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

All state is stored in `.intercomm-aifp/intercomm.db` (SQLite, WAL mode) created in the project root. Three tables: `instances`, `messages`, `read_cursors`.

## Stale Detection

Every tool call updates the instance's `last_active` timestamp. An instance is considered stale after **30 seconds** of inactivity. If the master goes stale, a worker can claim master via `intercomm_register(role: "master")`.

## Known Limitations

### Worker Permission Prompts

Claude Code requires user approval for certain tool calls (e.g., running bash commands, writing files). When workers hit these permission prompts, they block until approved. The master can approve remotely via `tmux send-keys`, but this is fragile — the master must monitor worker panes and send the right keystrokes.

**Potential solutions for future consideration:**
- Run workers with `claude --dangerously-skip-permissions` to bypass all prompts (use with caution)
- Configure per-project allowlists in `.claude/settings.json` to pre-approve common operations
- Add a master-side monitoring loop that detects blocked workers and auto-approves

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
