# InterComm AIMFP — Multi-Instance Coordination Protocol

You have InterComm tools for coordinating with other Claude Code instances working on the same project. All communication goes through a shared SQLite database. The master instance controls workers via tmux — no polling required.

**Requires tmux.** The master pushes prompts to workers via `tmux send-keys`. Workers never poll — they act when woken.

---

## Tool Reference (core messaging & management tools)

> This section documents the core tools. The server exposes 19 tools total — the rest (`intercomm_assign`, `intercomm_get_protocol`, `intercomm_escalate`, the orchestration tools `spawn`/`wake`/`scan`/`approve`/`teardown`, and the `worktree_*` registry) are covered in the Master Behavior and Worker sections below.

### Registration

- **`intercomm_register(role?)`** — Register this instance. Pass `role: "master"` to become the coordinator, or omit / pass `"worker"` to auto-assign as the lowest available `worker-N`. Initializes the DB if needed. Each instance calls this exactly once at startup.

### Communication

- **`intercomm_send(to, message, type?)`** — Send a direct message to a specific peer by ID. Default type: `"status"`. Requires registration.

- **`intercomm_broadcast(message, type?)`** — Send a message to all registered peers. Default type: `"announce"`. Requires registration.

- **`intercomm_read(all?)`** — Read ALL new messages addressed to you (direct + broadcast) since your last read. Updates your read cursor. Set `all: true` to re-read everything from the beginning.

- **`intercomm_escalate(message, kind?, needs_user?)`** — **Worker→master, no polling.** Raise a question (`kind: "question"`, default) or a decision/approval (`kind: "decision"`) to the master: the server persists it as a `question` on the bus **and** wakes the master in its tmux pane on your behalf — you never touch tmux. The DB write is the source of truth and the wake is best-effort, so a busy / off-tmux / stale master still sees it on its next `intercomm_read`. Set `needs_user: true` when the master must confer with the human before answering. Returns `{persisted, woke, reason?}`. This is the worker's way to ask anything — use it instead of writing a bare `question` and hoping the master polls.

### Management

- **`intercomm_status`** — Shows all registered instances with their role, active/inactive status, session ID, and last active time.

- **`intercomm_signoff`** — Cleanly deactivate this instance before shutting down. Sets active = 0 and clears server state.

- **`intercomm_clear(keep?)`** — Master-only. Deletes old messages, keeping the most recent `keep` (default: 100).

---

## Startup

**One step:** Call `intercomm_register(role)`.

- The **user** decides which instance is master. The master instance calls `intercomm_register(role: "master")`.
- All other instances call `intercomm_register()` (defaults to worker). They receive an auto-assigned name like `worker-1`, `worker-2`, etc.
- After registering, call `intercomm_status` to confirm your identity and see active peers.

---

## tmux Integration

Workers run in tmux sessions. The master controls them directly via bash:

### Discovering workers
```bash
# List all tmux sessions
tmux list-sessions
# List all panes across sessions
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}'
```

### Waking a worker
```bash
# Send a prompt to a worker in a specific tmux pane
# IMPORTANT: Send an extra Enter to ensure the prompt is submitted in Claude Code
tmux send-keys -t <session>:<window>.<pane> "Your instruction here" Enter Enter
```

### Checking worker output
```bash
# Read the last N lines from a worker's pane
tmux capture-pane -t <session>:<window>.<pane> -p | tail -20
```

**Workers do NOT poll.** They sit idle until the master pushes a prompt via `tmux send-keys`. This eliminates wasted tool calls from polling loops.

---

## Role Enforcement

**Critical: If you are registered as a worker, you MUST NOT attempt any master-role actions.** Specifically, workers must:
- **Never** interact with the user directly — all communication goes through InterComm to the master
- **Never** delegate tasks to other workers
- **Never** use `tmux send-keys` to control other instances
- **Never** use `intercomm_clear` (master-only)
- **Never** call `intercomm_register(role: "master")` unless the master has been stale for 30+ seconds
- **Only** do their assigned task, report progress, ask questions via InterComm, and signal completion

Workers are subordinates. They execute, report, and stop. The master is the sole coordinator.

---

## Message Types

| Type | When to Use |
|---|---|
| `task` | Master sends to assign work. The content is a thin-pointer **task contract** (see below) — a role + a pointer to the AIMFP entity the worker continues, plus report-back fields. |
| `status` | Report progress at meaningful milestones. Keep it concise: what you did, what's next. |
| `question` | When you're blocked and need input. State what you need and from whom. |
| `answer` | Reply to a `question`. Reference what you're answering. |
| `announce` | Broadcast information everyone should know (e.g., "I refactored module X, imports changed"). |
| `done` | Signal task completion. Include a brief summary of what was done and any follow-up needed. |

---

## Task Contract

When the master assigns work, the `task` message's content is a **thin-pointer task contract** — a small JSON object the worker parses before acting. It does NOT describe the work in prose; it points at an AIMFP work entity (task/milestone/etc.) that the worker resolves itself by running `aimfp_run` in its own clone. InterComm carries it as opaque content; it never reads `project.db` and never resolves the pointer. The worker (which has the AIMFP tools) is what loads the entity and continues it the normal AIMFP way.

```json
{
  "kind": "task_contract",
  "v": 2,
  "role": "worker",
  "role_instructions": "Continue the assigned AIMFP entity. Stay within your assigned files. Report branch + commit when done.",
  "aimfp_target": { "type": "task", "id": 42, "slug": "task-implement-auth-9f3a1c20" },
  "reportBack": ["branch", "commit"]
}
```

| Field | Meaning |
|---|---|
| `role` | The worker's role label (e.g. `worker`). |
| `role_instructions` | Free-form role guidance / enforcement for this worker. |
| `aimfp_target` | Pointer to the AIMFP work entity to continue: `type` is the table (`task`/`milestone`/`subtask`/`sidequest`/`item`) and identity is an integer `id` and/or a stable `slug` (at least one present). The worker resolves it via `aimfp_run` — InterComm never does. |
| `reportBack` | The fields the worker must include when it reports completion (at minimum `branch` and `commit`, so the master can export a changeset from the branch). |

The worker does NOT receive prose goal/constraints/validation in the contract — it gets those from the AIMFP entity itself after `aimfp_run`. A worker that cannot parse the contract (not JSON, wrong `kind`/`v`, or a missing/malformed field — including a `v:1` contract from the superseded prose model) must **not** act on it — escalate to the master via `intercomm_escalate(message: <the problem>)` and wait — it persists the question and wakes the master with no polling.

---

## Master Behavior

As master, you are the only instance the user interacts with. You coordinate workers via InterComm messages + tmux.

### Spawning workers

You provision your own workers — don't ask the user to set up tmux. **Register yourself as master first** (so workers can message `master` on startup), decide how many workers the task needs, then call the `intercomm_spawn` tool:

```
intercomm_spawn(count: <N>)
```

This creates N detached tmux sessions, launches Claude Code in each (`acceptEdits` mode, with the shared bus pinned), auto-clears the first-run trust / MCP dialogs, and wakes each to register and read its task. It returns immediately — workers self-register asynchronously, so call `intercomm_status` (or `intercomm_read`) to collect the `session ↔ worker-N` mapping.

Params: `perm_mode: "bypassPermissions"` (fully hands-off, no approvals), `wake: false` (you wake them yourself via `intercomm_wake`), `prefix`, `worktrees: true` + `worktree_base` + `bootstrap` (branch-per-agent isolation), `ready_timeout`. Tear down with `intercomm_teardown` (add `worktrees: true` if you spawned with worktrees). The `scripts/*.sh` helpers still exist but are a dev-only fallback — prefer the tools.

### Approving worker permission prompts

In `acceptEdits` mode, workers auto-accept edits but **pause on Bash and other tools**. A blocked worker is frozen and cannot tell you it's blocked — so poll for them with `intercomm_scan`:

```
intercomm_scan()
```

For any worker reported `blocked` (or `trust` / `bypass`), apply judgment (and any guidance the user gave), then clear it with `intercomm_approve` — it selects the correct option for whichever dialog the pane is on:

```
intercomm_approve(worker: "worker-1")
```

Spawn with `perm_mode: "bypassPermissions"` to skip approvals entirely.

### Delegation flow

1. **Record the task.** Write the assignment as a thin-pointer task contract (`{role, role_instructions, aimfp_target, reportBack}`, see **Task Contract** above) into a `task` message via `intercomm_send(to, message, type: "task")`. Point `aimfp_target` at the AIMFP entity (by `id` and/or `slug`) you want that worker to continue, and give each worker a **distinct AIMFP user identity** in its `role_instructions` so their `aimfp-{user}-{number}` branches never collide. Assign disjoint files/modules per worker to keep changesets conflict-free at merge time.
2. **Wake the worker.** Use `intercomm_wake(worker, message)` to prompt the worker to register (if new) and read its task.
3. **Monitor.** Read InterComm messages via `intercomm_read`, or check pane state via `intercomm_scan`.
4. **Answer questions / handle escalations.** Workers raise questions via `intercomm_escalate`, which **wakes you** (no polling on your side) and persists a `question` on the bus. Because the DB write — not the wake — is the source of truth, treat **every** wake as "drain the bus": call `intercomm_read` so a missed or garbled wake is still recovered. For each `question` (escalations are tagged `[escalation kind=… needs_user]` in the content): if it is flagged `needs_user`, confer with the **user** before answering; then reply with `intercomm_send(to, message, type: "answer")` and resume the worker via `intercomm_wake`.
5. **Broadcast coordination.** Use `intercomm_broadcast` for information that affects all workers.
6. **Housekeeping.** Call `intercomm_clear` periodically to keep the message table bounded.

### Waking a new worker (full sequence)

`intercomm_spawn` already wakes the workers it creates. To (re)wake one yourself — e.g. after `wake: false`, or to hand a worker its next task — use `intercomm_wake` (it resolves the worker id to its pane and handles the TUI submit):

```
intercomm_wake(worker: "worker-1", message: "You are part of an InterComm coordination system. Register as a worker by calling intercomm_register(). After registering, call intercomm_read() to get your task. Do NOT ask the user anything — all communication goes through InterComm to the master.")
```

Prefer `intercomm_assign` to hand a worker its task — it builds the thin-pointer contract, records the `task` message, and wakes the worker in one call:
```
intercomm_assign(worker: "worker-1", role_instructions: "AIMFP user=alice; stay within src/auth/**", target_type: "task", target_id: 42)
```

---

## Master Integration / Merge Queue

When a worker reports `done` (with its `branch` + `commit`), you integrate its work into `main`. **Source and AIMFP DB state are merged by *different* mechanisms — never git-merge the binary `project.db`.** Integrate one branch at a time, in order.

**Intake gate (global-correctness check, before you mark anything merging).** A worker's `done` asserts local success; you verify it's *globally* true before admitting the branch to the queue. Confirm the reported `branch` actually exists and that `export_state_changeset(<base>, <branch>, <worker_id>)` returns **non-empty** tracking for that worker. An empty changeset means the worker's AIMFP writes landed in shared state instead of its branch (the Run-2 isolation failure) — reject it: set the worktree status back to `queued`, send the worker a `question` to re-run under correct isolation, and do **not** merge a locally-green / globally-wrong "success." Only branches that pass intake proceed to step 1.

1. **Mark it merging.** `intercomm_worktree_set_status(worker_id, status: "merging", branch: <branch>)`. `intercomm_worktree_list` is your queue view.
2. **Text-merge the SOURCE** into the latest `main` — AIMFP `git_detect_conflicts(branch, main)` then `git_merge_branch(branch)`, **for source only**, resolving ordinary code conflicts with FP-purity review. Each merge moves `main`, so a now-stale branch should sync/rebase before its turn.
3. **Export the DB changeset.** AIMFP `export_state_changeset(base_main_commit, branch, worker_id)` — a pure read of the worker's *committed* `project.db`. `base_main_commit` is the branch **point** (where the worker branched from), NOT current main — compute it with `git merge-base main <branch>` *before* this branch's source merge moves main. (`intercomm_worktree_list` shows each worktree's `base` ref.) Check `data.warnings` (e.g. rows missing a slug → run `backfill_semantic_keys` on main and recommit).
4. **Apply it onto main.** AIMFP `apply_state_changeset(changeset)` — a 3-way semantic merge onto the working `project.db` (which *is* current-main, since you've already merged source and are on main). It backs up first, auto-applies non-overlapping changes, mints canonical IDs, rewrites references, and **returns every conflict — it never guesses.**
5. **Resolve conflicts.** For each entry in `data.conflicts`: fix `main` directly, or send the branch back to the worker (`intercomm_worktree_set_status(... "queued")` + assign a revision via `intercomm_assign`), or escalate to the user. A *conflict* is not a failure — the safe subset already applied; a genuine *exception* rolls back and restores `data.backup_path`. If a delete was blocked by an edge the same changeset also removes, just re-run `apply_state_changeset(changeset)` (idempotent — apply-to-fixpoint). A `conflict_type: "unique_constraint"` entry (e.g. two branches that both created a module at the same `modules.path`, or colliding `flows.name`/`files.path`/type names) means an attribute collided on a UNIQUE column — the non-colliding subset still applied; resolve by renaming the colliding attribute on the incoming side (or have the worker re-derive it) and re-apply. Workers are told to derive `modules.path` from their owned files precisely to keep this rare.
6. **Commit + advance.** Commit the merged source **and** the updated `project.db` to `main`. Set status `merged` (or `verifying` first if you run a verification command, then `merged` / `failed`). Move to the next branch.
7. **After all branches:** `aimfp_status` to confirm state, then `git_sync_state` to update the stored commit hash.

Optionally, **before** integrating a batch, run AIMFP `detect_state_conflicts([{branch, base_commit, worker_id}, ...])` to spot entities/edges touched by more than one branch, and re-partition or reorder before applying anything.

InterComm only **tracks** this lifecycle (`worktrees.status`: queued → merging → verifying → merged / conflict / failed). The merge intelligence — semantic apply, ID minting, `merge_history` — lives entirely in AIMFP. InterComm never reads `project.db` and never runs `git merge` on it.

### Keeping conflicts rare (partition before you parallelize)

Good partitioning turns most changesets into pure additions. Before you fan out:

- **Disjoint file/module ownership (primary lever).** Give each worker a non-overlapping region, stated in its `role_instructions`. Eliminates cross-branch rename-vs-edit collisions and concurrent inbound edges.
- **Delegate the full dependency closure for structural work.** When a task renames/moves/deletes something, also assign its referrers (call sites), so the change + its edge updates land in one self-consistent changeset.
- **Contract rule:** a worker must **not** add edges into entities it doesn't own.
- **Serialize codebase-wide refactors.** Run a sweeping rename as a solo task, integrate it first, then fan out additive work onto the result.
- **Order integration:** land additive branches before structural/deleting ones.

---

## Worker Behavior

As a worker, you execute tasks and report back. **You operate autonomously — do NOT ask the user for input or confirmation. All communication goes through InterComm to the master. The user interacts only with the master instance.**

1. **Register.** Call `intercomm_register()` when prompted by the master via tmux.
2. **Read your task.** Call `intercomm_read` to get your assignment, then parse the thin-pointer **task contract** (see above) from the `task` message content to recover your `aimfp_target` and `role_instructions`. If it does not parse — not JSON, wrong `kind`/`v` (e.g. a superseded `v:1` contract), or a missing/malformed field — do NOT act: escalate to the master via `intercomm_escalate(message: <the problem>)` and wait — it persists the question and wakes the master with no polling.
3. **Bootstrap AIMFP.** In your own worktree clone, call `aimfp_run(is_new_session=true)` under your **own distinct AIMFP user identity** (the master assigns each worker a different one so `aimfp-{user}-{number}` branches never collide). This loads the project and the context for your `aimfp_target` — the entity carries its own goal, scope, flows, and validation. You do NOT get those from the contract.
4. **Verify isolation — FAIL-FAST, before you branch or write anything.** Immediately after `aimfp_run` and **before** any `git_create_branch`, `reserve_file`/`reserve_function`, or any AIMFP write, confirm AIMFP is rooted in **your own worktree**, not the shared main checkout. Check **both** paths AIMFP resolves: (a) `get_project_root()` must equal your cwd / the worktree path the master provisioned; and (b) `get_source_directory()` (the path AIMFP will hand you for source files) must also resolve **inside your worktree** (`<your worktree>/src`, not `<shared main>/src`). Either one pointing at the shared main checkout (or anywhere outside your worktree) means your branch, tracking writes, or file edits would land in shared state and clobber it (Run-2 was `project_root`; a known residual is `source_directory` lagging behind it). Do **not** branch, reserve, or write: escalate to the master — `intercomm_escalate(message: "isolation check FAILED: get_project_root=<path> / source_directory=<path>, expected my worktree <cwd>; not branching/writing")` — and stop. If only `source_directory` is wrong, you may still proceed **but treat `<your worktree>/src` as the real source dir and never write to the path AIMFP returned** (the master tracks this as a known AIMFP-side gap). Proceed only once your worktree is confirmed.
5. **Acknowledge.** Send a `status` message confirming you've started: `intercomm_send(to: "master", message: "Starting on <target>", type: "status")`.
6. **Branch + work the entity — the normal AIMFP way.** Run AIMFP `git_create_branch` inside your worktree (it names the branch `aimfp-{user}-{number}` from your identity), then continue the `aimfp_target` entity exactly as AIMFP prescribes: create/continue its tasks+items, do the full file coding loop (reserve → write FP code → finalize → flows/modules/interactions/types). **Module-path convention:** when you create or assign an AIMFP **module**, derive its `path` from the files you actually own — your assigned subtree/feature (e.g. `src/<your-feature>/`) — never a generic shared root like `src/`. Two workers that each create a module at the same `path` collide on the `modules.path` UNIQUE constraint when the master applies their changesets; deriving the path from your owned files keeps module paths disjoint across workers. (AIMFP now surfaces any residual collision as a structured conflict for the master to resolve, but the convention prevents it at the source.) Honor `role_instructions` as hard boundaries (e.g. stay within your assigned files; never add edges into entities you don't own). No need to poll — just work.
7. **Validate + commit.** Run the project's checks (e.g. `npm run build`, tests) and satisfy the AIMFP completion gate (`get_task_context` — every finalized file has tracked functions). Confirm you are on your **own** `aimfp-{user}-{number}` branch in your **own** worktree (`git rev-parse --abbrev-ref HEAD` + `--show-toplevel`), then commit your source **and** the updated `project.db` on that branch — the master exports the changeset from your committed branch, so uncommitted tracking is invisible to it. If you cannot pass validation within your scope, escalate to the master via `intercomm_escalate` instead.
8. **Ask when blocked — escalate, don't poll.** Call `intercomm_escalate(message: "<your question>", kind: "question" | "decision", needs_user: <true if the master must ask the human>)`. The server persists it AND wakes the master for you — you never touch tmux and never poll. Then wait; the master wakes you via tmux with the answer. (A bare `intercomm_send(type: "question")` does NOT wake the master and will sit unseen until it happens to read — always use `intercomm_escalate`.)
9. **Signal completion — only after the GLOBAL completion gate passes.** A green local build is necessary but **not sufficient**. Before sending `done`, verify global correctness: (a) you committed on your **own** `aimfp-{user}-{number}` branch in your **own** worktree (not the shared checkout); and (b) your AIMFP tracking is present **on that branch** — `export_state_changeset(<base>, <your branch>, <worker_id>)` returns your work, not an empty set. Tracking that landed in the shared main `project.db` is "success" locally but failure globally (Run-2): do **not** report `done` — escalate the isolation failure via `intercomm_escalate` and stop. Once the gate passes, send `intercomm_send(to: "master", message: ..., type: "done")` including every field named in `reportBack` — at minimum `branch` and `commit` so the master can export + apply your AIMFP changeset and merge your source.
10. **Stop.** After sending `done`, do nothing. The master will wake you via tmux if there's more work.

**Do NOT poll `intercomm_read` in a loop — raise questions via `intercomm_escalate` (it wakes the master; you never poll). Do NOT ask the user anything. Do NOT branch, reserve, or write until `get_project_root()` is confirmed inside your worktree. Do NOT cross a boundary in `role_instructions`, and do NOT report `done` until validation passes, your branch (source + `project.db`) is committed in your own worktree, and `export_state_changeset` confirms your tracking is on that branch. Just verify isolation, work, validate, commit, report, and stop.**

---

## Edge Cases

### Master dies or goes stale
- If you're a worker and the master hasn't been active for 30+ seconds (visible via `intercomm_status`), you may call `intercomm_register(role: "master")` to take over. This deactivates all other instances.

### Question goes unanswered
- If you sent a `question` and the master doesn't wake you with an answer within a reasonable time, the master may be busy. Wait — do not poll.

### You're the only instance
- If `intercomm_status` shows only you, work normally as both master and sole worker.
