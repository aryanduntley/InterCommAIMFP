# InterComm AIMFP

Local-only coordination system for multiple Claude Code instances working on the same project. One instance is master, the rest are workers. The master delegates tasks and controls workers via tmux. All state lives in a single SQLite database — no servers, no HTTP, no sockets.

**Requires tmux** and the **AIMFP MCP server**. InterComm AIMFP is a hard AIMFP addon — the worker flow runs `aimfp_run` and `git_create_branch`, and the master integrates each branch via `export_state_changeset` / `apply_state_changeset`. Without the AIMFP MCP server connected (listed in the project's `.mcp.json`), instances can still coordinate and isolate files via worktrees, but there is **no AIMFP tracking and no semantic-changeset merge**. (InterComm's own code stays AIMFP-agnostic — it never reads AIMFP's DB.)

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
3. The master assigns work via `intercomm_assign` — a **thin-pointer task contract** that points the worker at an AIMFP work entity — and **wakes** the worker (via `intercomm_wake` / tmux send-keys).
4. Each worker registers, reads its contract, runs `aimfp_run` in its own git worktree, continues the assigned AIMFP entity on its own branch, then reports `done` (with `branch` + `commit`) via InterComm.
5. Workers do **not** poll. They sit idle until the master pushes a prompt via tmux.

InterComm stays **AIMFP-agnostic**: it isolates files (worktrees), carries the pointer contract, and tracks status — it never reads AIMFP's DB and never runs `git merge`. The master uses AIMFP's `export_state_changeset` / `apply_state_changeset` to integrate each worker's DB tracking (see [Integration](#integration)).

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

That's it — there is **no protocol to paste**. The master/worker coordination
protocol is delivered automatically via the MCP server's `instructions` field the
moment any instance connects (master or worker), the same way AIMFP injects its
rules. It travels with the server into every project, so your `CLAUDE.md` stays
yours (e.g. AIMFP-only) and is never touched. Any instance can re-read the full
protocol on demand with the `intercomm_get_protocol` tool — useful after a long
session compacts context. (`system-prompt.md` in this repo is the single in-repo
source for that injected text; edit it there and rebuild.)

## Install as a Claude Code plugin

InterComm AIMFP is also packaged as a **Claude Code plugin** (the same model as
AIMFP). Installing the plugin is the supported one-step distribution path — it
wires up the MCP server, the slash commands, the setup skill, and the hooks in
any project, and auto-updates the server. The manual `.mcp.json` install above is
the **development** path (running your local `dist/`); the plugin is the
**distribution** path. Use one or the other for a given project, not both, or you
will get a duplicate `intercomm` server.

Once the package is published to npm and this repo is pushed:

```bash
# add this repo as a plugin marketplace, then install
claude plugin marketplace add aryanduntley/intercommAIMFP
claude plugin install intercomm-aimfp
```

The plugin's `intercomm-plugin/.mcp.json` runs the server via
`npx -y -p intercomm-aimfp@latest intercomm-mcp`, so npm compiles the native
`better-sqlite3` binding for each machine on first run and `@latest` keeps the
server current — no bundled binaries. It ships:

- **MCP server** — all 19 coordination tools, with the protocol auto-injected via the server's `instructions` field.
- **Commands** — `/register`, `/spawn`, `/status`, `/teardown`.
- **Skill** — `intercomm-mode` (a tiny setup bootstrap; the real protocol lives in the injected instructions).
- **Hooks** — a `SessionStart` note on how to begin coordinating.

> **Requires the AIMFP MCP server.** InterComm AIMFP is a hard AIMFP addon. The
> plugin does not bundle AIMFP — install it separately (its own plugin or
> `python3 -m aimfp` in your `.mcp.json`). The master's startup preflight warns if
> the AIMFP tools are absent.

**Local development / testing (before publishing):**

```bash
# load the plugin straight from this working tree
claude --plugin-dir /path/to/intercommAIMFP
```

## Usage

The master spawns and controls workers itself through InterComm's MCP tools — no shell scripts and no manual tmux setup required. (The `scripts/*.sh` helpers remain as a dev-only fallback; see [Dev scripts](#dev-scripts).)

### 1. Register the master

In your main Claude Code instance, register as master (via the `intercomm_register(role: "master")` tool, or just tell it "you are the master"). This must happen **before** spawning workers, so workers can message `master` on startup.

### 2. Spawn workers automatically

From the master, run:

From the master, call the **`intercomm_spawn`** tool:

```
intercomm_spawn(count: 3)
```

This creates 3 detached tmux sessions (`worker-1`, `worker-2`, `worker-3`), launches Claude Code in each (with `INTERCOMM_DB_ROOT` pinned to the shared bus, so they load `.mcp.json` + `CLAUDE.md`), auto-clears the first-run trust / MCP-approval dialogs, and wakes each to register and read its task. It returns immediately with the session list — workers self-register asynchronously, so call `intercomm_status` to confirm the `session ↔ worker-N` mapping.

Useful parameters:

| Param | Effect |
|---|---|
| `worktrees: true` | Launch each worker in its own isolated git worktree (branch-per-agent) |
| `worktree_base` | Git ref each worktree checks out detached (default: `main`) |
| `bootstrap` | Setup command run inside each new worktree (e.g. `npm install`) |
| `perm_mode` | `claude --permission-mode` (default: `acceptEdits`; `bypassPermissions` for fully hands-off) |
| `prefix` | tmux session-name prefix (default: `worker`) |
| `ready_timeout` | Per-session seconds to clear boot dialogs (default: 20) |
| `wake: false` | Create + launch only; wake them yourself later via `intercomm_wake` |

### 3. Approve flagged permission prompts

In the default `acceptEdits` mode, workers auto-accept file edits but **pause on Bash and other tools**. A blocked worker is frozen and cannot report over InterComm, so the master polls for them with **`intercomm_scan`**:

```
intercomm_scan()
```

It reports each worker pane's state (`blocked`, `trust`, `bypass`, `ready`, `running`, `idle`). Clear any pane that needs attention with **`intercomm_approve`**, which selects the right option for whichever dialog it's on:

```
intercomm_approve(worker: "worker-1")
```

To skip approvals entirely, spawn with `perm_mode: "bypassPermissions"`.

### 4. Let it run, then tear down

The master delegates via **`intercomm_assign`** (which builds the thin-pointer task contract, records it, and wakes the worker), monitors with `intercomm_scan` / `intercomm_read`, and collects results. When done, **`intercomm_teardown`** kills the sessions, removes the worktrees, and reaps the registry in one call:

```
intercomm_assign(
  worker: "worker-1",
  role_instructions: "AIMFP user=alice; stay within src/auth/**; report branch+commit when done",
  target_type: "task", target_id: 42,
)
intercomm_teardown()                 # pass worktrees: true if you spawned with worktrees
```

## Task Contract (thin pointer)

The master does **not** ship prose instructions to a worker. It ships a small JSON **pointer** to an AIMFP work entity; the worker resolves it itself by running `aimfp_run` in its clone and continuing that entity the normal AIMFP way (its own `git_create_branch` on `aimfp-{user}-{number}`, its own tracking + validation). InterComm carries the contract as opaque message content — it never resolves the pointer and never reads `project.db`.

```json
{
  "kind": "task_contract",
  "v": 2,
  "role": "worker",
  "role_instructions": "Continue the assigned AIMFP entity. Stay within your assigned files.",
  "aimfp_target": { "type": "task", "id": 42, "slug": "task-implement-auth-9f3a1c20" },
  "reportBack": ["branch", "commit"]
}
```

| Field | Meaning |
|---|---|
| `role` / `role_instructions` | Worker role label + free-form guidance (assigned files, a **distinct AIMFP user identity** per worker so `aimfp-{user}-{number}` branches don't collide). |
| `aimfp_target` | The AIMFP entity to continue: `type` (task / milestone / subtask / sidequest / item) plus an integer `id` and/or a stable `slug` (at least one). |
| `reportBack` | Fields the worker returns on `done` — at minimum `branch` + `commit`, so the master can export a changeset from the branch. |

`intercomm_assign` builds this for you; `intercomm_read` shows the worker a validated summary (or an error if the contract is malformed). A worker that can't parse the contract sends a `question` and waits — it never acts on a bad contract.

## Integration

When a worker reports `done`, the master integrates its branch — **source and AIMFP DB state are merged by different mechanisms**:

1. **Text-merge the worker's source** into `main` (normal code review / conflict resolution). The binary `project.db` is **never** git-merged.
2. **Export the worker's DB tracking** as a semantic changeset: AIMFP `export_state_changeset(base_main_commit, branch)` — an integer-free diff keyed on stable semantic keys.
3. **Apply it onto main**: AIMFP `apply_state_changeset(changeset)` — a 3-way merge that auto-applies non-overlapping changes, mints canonical IDs, rewrites references, and reports conflicts for the master to resolve.
4. **Commit** merged source + updated `project.db` to main; move to the next branch.

InterComm only **tracks** the lifecycle (`intercomm_worktree_list` is the master's merge-queue view); the DB merge intelligence lives entirely in AIMFP.

> **Parallel git-worktree runs are supported and validated end-to-end** — 4 workers in isolated worktrees through the full `export_state_changeset` → `apply_state_changeset` merge chain, including concurrent shared-type conflict prediction + resolution. Each worker's AIMFP tracking is committed on its own branch (requires the worktree-aware AIMFP build). One residual AIMFP-side caveat: a worker should treat `<its worktree>/src` as the source dir even if `get_source_directory()` still returns the shared-checkout path — the worker pre-flight guard checks this.

### Dev scripts

`scripts/spawn-workers.sh`, `scan-workers.sh`, and `kill-workers.sh` predate the tools and remain for local development / debugging only — they are **not** a runtime dependency. The MCP tools above are the supported path when InterComm is dropped into any project as an MCP server. (Claude Code's TUI needs a double `Enter` to submit a prompt; the tools and scripts both handle that for you.)

## MCP Tools (19 total)

**Identity & messaging**

| Tool | Description |
|---|---|
| `intercomm_register` | Register as master or worker. Initializes DB. Workers auto-assign lowest available `worker-N` name. |
| `intercomm_send` | Send a direct message to a specific peer. |
| `intercomm_broadcast` | Broadcast a message to all peers. |
| `intercomm_read` | Read all new messages since last check. Updates read cursor. For `task` messages, also surfaces the parsed, validated thin-pointer contract. |
| `intercomm_escalate` | **Worker→master, no polling.** Persist a question/decision to the master AND wake it in its tmux pane (the server does the wake; the worker never touches tmux). Set `needs_user` when the master must ask the human. Returns `{persisted, woke, reason?}`. |
| `intercomm_assign` | Master-only. Assign work as a thin-pointer task contract (`{role, role_instructions, aimfp_target, reportBack}`): builds it, records the `task` message, and wakes the worker. |
| `intercomm_status` | Show all instances and their state. |
| `intercomm_signoff` | Cleanly deactivate this instance before shutting down. |
| `intercomm_clear` | Delete old messages (master-only). |
| `intercomm_get_protocol` | Re-read the full master/worker coordination protocol on demand (the same text auto-injected via the server's MCP `instructions` on connect). No registration required. |

**Orchestration (master-only) — the tool-driven lifecycle, no shell scripts**

| Tool | Description |
|---|---|
| `intercomm_spawn` | Spawn N workers in detached tmux sessions; launch claude (optionally one git worktree each), auto-clear boot dialogs, wake to self-register. Non-blocking. |
| `intercomm_wake` | Push a prompt into a worker's pane (resolves a worker id or raw tmux target). |
| `intercomm_scan` | Report each worker pane's state (blocked / trust / bypass / ready / running / idle). |
| `intercomm_approve` | Clear a worker's blocking dialog (trust / MCP-approval / bypass / permission prompt). |
| `intercomm_teardown` | Kill worker sessions, remove their worktrees, and reap the instance rows in one call. |

**Worktree registry (master-only) — branch-per-agent isolation**

| Tool | Description |
|---|---|
| `intercomm_worktree_add` | Create an isolated git worktree (detached) for a worker and register it. |
| `intercomm_worktree_list` | List registered worktrees and their lifecycle status (the merge-queue view). |
| `intercomm_worktree_set_status` | Update a worktree's status; record the branch a worker reported back. |
| `intercomm_worktree_remove` | Remove a worker's git worktree and mark it removed. |

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

All state is stored in `.intercomm-aimfp/intercomm.db` (SQLite, WAL mode) created in the project root. Four tables: `instances` (incl. `tmux_target` for wake/scan/approve), `messages`, `read_cursors` (monotonic `last_read_seq` cursor), and `worktrees` (the branch-per-agent registry).

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
- `intercomm_scan` polls every worker pane and reports which are blocked.
- The master clears the dialog with `intercomm_approve` (it reads the pane via `capture-pane` and selects the right option via `send-keys`).

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
