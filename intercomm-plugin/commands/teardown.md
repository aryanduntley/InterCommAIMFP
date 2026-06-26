---
description: Master-only. Tear down all spawned workers (kill tmux sessions, remove worktrees, reap rows).
argument-hint: [--worktrees]
---

Call the `intercomm_teardown` MCP tool to tear down all workers in one shot: it kills the tmux sessions, removes their git worktrees (pass `worktrees: true` if you spawned with `--worktrees`), and reaps the instance rows so a stale registration cannot drift the next worker's number. You must be registered as master.
