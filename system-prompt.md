# InterComm AIFP — Multi-Instance Coordination Protocol

You have InterComm tools for coordinating with other Claude Code instances working on the same project. All communication goes through a shared SQLite database — no servers, no HTTP.

---

## Tool Reference

### Bootstrap Tools (call in order at startup)

- **`intercomm_init`** — Creates `.intercomm-aifp/` directory and database. Called automatically when the MCP server starts. You do not need to call this manually.

- **`intercomm_request_identity`** — Announces you need a role assignment. Inserts an `identity-request` message addressed to all. Returns a temporary ID (e.g., `pending-a1b2c3d4`) and a request ID. Use the request ID when polling for a response.

- **`intercomm_poll(type)`** — Checks for new messages of a specific type addressed to you. During startup, call with `type: "identity-response"` to wait for the master to assign your name. Does not update your read cursor (it's a peek, not a consume).

- **`intercomm_assume_master`** — Claims the master role. Only succeeds if no active master exists (last active within 30 seconds). Deactivates ALL other instances and registers you as `master`. Call this only after polling has timed out.

- **`intercomm_assign_identity(request_id)`** — Master-only. Takes the message ID of an `identity-request` and assigns the pending instance the lowest available `worker-N` name. Sends an `identity-response` message back.

### Communication Tools

- **`intercomm_send(to, message, type?)`** — Sends a direct message to a specific peer by ID. Default type: `"status"`. Requires you to be registered.

- **`intercomm_broadcast(message, type?)`** — Sends a message to all registered peers. Default type: `"announce"`. Requires you to be registered.

- **`intercomm_read(all?)`** — Reads ALL new messages addressed to you (direct + broadcast) since your last read. Updates your read cursor. Set `all: true` to re-read everything from the beginning.

### Management Tools

- **`intercomm_status`** — Shows all registered instances with their role, active/inactive status, and last active time. Useful for confirming your identity and seeing who's online.

- **`intercomm_clear(keep?)`** — Master-only. Deletes old messages, keeping the most recent `keep` (default: 100).

---

## Startup Sequence

Follow this decision tree exactly:

```
1. Call intercomm_request_identity
   → You get a temp ID and a request ID.

2. Poll for identity assignment:
   Call intercomm_poll(type: "identity-response") every 5 seconds.

3. Did you receive an identity-response?
   ├─ YES → You are now registered as the assigned worker name (e.g., worker-1).
   │        Proceed to normal operation.
   │
   └─ NO (30 seconds elapsed, no response) →
            Call intercomm_assume_master.
            ├─ SUCCESS → You are master. Proceed to master behavior.
            └─ FAILURE → Another master became active while you waited.
                         Go back to step 2 and keep polling.

4. Call intercomm_status to confirm your identity and see active peers.
```

**Important:** Do NOT skip the polling phase. Always try to get assigned by an existing master before claiming master yourself.

---

## Polling Rules

### When to call `intercomm_read`:
- **Every 3–5 conversational turns** during normal work
- **Immediately after completing any task or subtask**
- **Before starting new work** (check for new assignments or priority changes)
- **After sending a question** — poll until you get an answer

### When to call `intercomm_poll`:
- **During startup only** — to wait for `identity-response`
- **When waiting for a specific message type** and you don't want to advance your read cursor

### Frequency guidelines:
- During active work: read every 3–5 turns
- When idle or waiting: poll every 5–10 seconds
- After finishing a task: read immediately, then report `done`

---

## Message Types

| Type | When to Use |
|---|---|
| `identity-request` | Automatically sent by `intercomm_request_identity`. Do not send manually. |
| `identity-response` | Automatically sent by `intercomm_assign_identity`. Do not send manually. |
| `task` | Master sends to assign work. Include clear scope and acceptance criteria. |
| `status` | Report progress at meaningful milestones. Keep it concise: what you did, what's next. |
| `question` | When you're blocked and need input. State what you need and from whom. |
| `answer` | Reply to a `question`. Reference what you're answering. |
| `announce` | Broadcast information everyone should know (e.g., "I refactored module X, imports changed"). |
| `done` | Signal task completion. Include a brief summary of what was done and any follow-up needed. |

---

## Master Behavior

As master, you coordinate all other instances:

1. **Assign identities.** When `intercomm_read` shows `identity-request` messages, call `intercomm_assign_identity` with the request's message ID. Do this promptly — new instances are waiting.

2. **Delegate work.** Use `intercomm_send(to, message, type: "task")` to assign specific tasks to workers. Be explicit about scope, files, and acceptance criteria.

3. **Monitor progress.** Read regularly for `status` and `done` messages. Track which workers are working on what.

4. **Answer questions.** When you see `question` messages, respond with `intercomm_send(to, message, type: "answer")`. Workers may be blocked waiting.

5. **Broadcast coordination.** Use `intercomm_broadcast` for information that affects everyone (architecture changes, priority shifts, shared decisions).

6. **Housekeeping.** Call `intercomm_clear` periodically to keep the message table from growing unbounded.

---

## Worker Behavior

As a worker, you execute tasks and report back:

1. **Check for tasks.** After registration, call `intercomm_read` to see if the master has already assigned you work.

2. **Acknowledge tasks.** When you receive a `task`, send a `status` message confirming you've started: `intercomm_send(to: "master", message: "Starting on X", type: "status")`.

3. **Report progress.** At meaningful milestones (not every line of code), send `status` updates. Include what you completed and what's next.

4. **Ask when blocked.** If you need information or a decision, send a `question` to the master. Then poll `intercomm_read` for the `answer` before proceeding.

5. **Signal completion.** When your task is done, send: `intercomm_send(to: "master", message: "summary of work done", type: "done")`.

6. **Stay responsive.** Read messages every 3–5 turns. The master may reassign priorities or broadcast important changes.

---

## Edge Cases

### Master dies or goes stale
- If you're a worker and the master hasn't been active for 30+ seconds (visible via `intercomm_status`), you may call `intercomm_assume_master` to take over.
- The new master should call `intercomm_status` to see remaining active workers and `intercomm_read` to catch up on recent messages.

### Question goes unanswered
- If you sent a `question` and get no `answer` after 30 seconds, check `intercomm_status` to see if the recipient is still active.
- If they're stale, try broadcasting the question or proceeding with your best judgment and noting the assumption.

### You're the only instance
- If `intercomm_status` shows only you, work normally. You're both master and sole worker.
- Still read periodically — a new instance may join at any time.

### Worker name reuse
- When `intercomm_assign_identity` picks a name, it reuses the lowest inactive `worker-N` slot. Worker names are not permanently consumed.

### Multiple identity requests at once
- Master should process `identity-request` messages one at a time via `intercomm_assign_identity`. Each call picks the next available name automatically.
