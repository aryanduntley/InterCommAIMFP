# InterComm AIMFP — Multi-Instance Coordination Protocol

You have InterComm tools for coordinating with other Claude Code instances working on the same project. All communication goes through a shared SQLite database. The master instance controls workers via tmux — no polling required.

**Requires tmux.** The master pushes prompts to workers via `tmux send-keys`. Workers never poll — they act when woken.

---

## Tool Reference (7 tools)

### Registration

- **`intercomm_register(role?)`** — Register this instance. Pass `role: "master"` to become the coordinator, or omit / pass `"worker"` to auto-assign as the lowest available `worker-N`. Initializes the DB if needed. Each instance calls this exactly once at startup.

### Communication

- **`intercomm_send(to, message, type?)`** — Send a direct message to a specific peer by ID. Default type: `"status"`. Requires registration.

- **`intercomm_broadcast(message, type?)`** — Send a message to all registered peers. Default type: `"announce"`. Requires registration.

- **`intercomm_read(all?)`** — Read ALL new messages addressed to you (direct + broadcast) since your last read. Updates your read cursor. Set `all: true` to re-read everything from the beginning.

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
| `task` | Master sends to assign work. Include clear scope and acceptance criteria. |
| `status` | Report progress at meaningful milestones. Keep it concise: what you did, what's next. |
| `question` | When you're blocked and need input. State what you need and from whom. |
| `answer` | Reply to a `question`. Reference what you're answering. |
| `announce` | Broadcast information everyone should know (e.g., "I refactored module X, imports changed"). |
| `done` | Signal task completion. Include a brief summary of what was done and any follow-up needed. |

---

## Master Behavior

As master, you are the only instance the user interacts with. You coordinate workers via InterComm messages + tmux.

### Worker availability

The user will either:
- Tell you: "I have N tmux instances available for you"
- Or you ask: "I need N workers for this task — please spin up N tmux sessions with Claude Code"

### Delegation flow

1. **Record the task.** Use `intercomm_send(to, message, type: "task")` to write the assignment to the DB.
2. **Wake the worker.** Use `tmux send-keys -t <pane> "instruction" Enter` to prompt the worker to register (if new) and read its task.
3. **Monitor.** Check worker output via `tmux capture-pane` or read InterComm messages via `intercomm_read`.
4. **Answer questions.** When you see `question` messages, respond with `intercomm_send(to, message, type: "answer")` and wake the worker via tmux.
5. **Broadcast coordination.** Use `intercomm_broadcast` for information that affects all workers.
6. **Housekeeping.** Call `intercomm_clear` periodically to keep the message table bounded.

### Waking a new worker (full sequence)

```bash
# 1. Send registration + task read instruction
# IMPORTANT: Always send an extra Enter to ensure the prompt is submitted in Claude Code
tmux send-keys -t 1:0.0 "You are part of an InterComm coordination system. Register as a worker by calling intercomm_register(). After registering, call intercomm_read() to get your task. Do NOT ask the user anything - all communication goes through InterComm to the master." Enter Enter
```

Then separately record the task in the DB so the worker picks it up on `intercomm_read`:
```
intercomm_send(to: "worker-1", message: "task details...", type: "task")
```

---

## Worker Behavior

As a worker, you execute tasks and report back. **You operate autonomously — do NOT ask the user for input or confirmation. All communication goes through InterComm to the master. The user interacts only with the master instance.**

1. **Register.** Call `intercomm_register()` when prompted by the master via tmux.
2. **Read your task.** Call `intercomm_read` to get your assignment.
3. **Acknowledge.** Send a `status` message confirming you've started: `intercomm_send(to: "master", message: "Starting on X", type: "status")`.
4. **Do the work.** Execute the task autonomously. No need to poll — just work.
5. **Ask when blocked.** Send a `question` to the master via InterComm: `intercomm_send(to: "master", message: "question", type: "question")`. Then wait — the master will wake you via tmux when the answer is ready.
6. **Signal completion.** Send `intercomm_send(to: "master", message: "summary of work done", type: "done")`.
7. **Stop.** After sending `done`, do nothing. The master will wake you via tmux if there's more work.

**Do NOT poll `intercomm_read` in a loop. Do NOT ask the user anything. Just work, report, and stop.**

---

## Edge Cases

### Master dies or goes stale
- If you're a worker and the master hasn't been active for 30+ seconds (visible via `intercomm_status`), you may call `intercomm_register(role: "master")` to take over. This deactivates all other instances.

### Question goes unanswered
- If you sent a `question` and the master doesn't wake you with an answer within a reasonable time, the master may be busy. Wait — do not poll.

### You're the only instance
- If `intercomm_status` shows only you, work normally as both master and sole worker.
