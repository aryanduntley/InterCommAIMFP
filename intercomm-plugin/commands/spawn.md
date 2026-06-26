---
description: Master-only. Spawn N Claude Code workers in tmux (optionally one git worktree each).
argument-hint: <count> [--worktrees]
---

Call the `intercomm_spawn` MCP tool to provision workers. You must be registered as master first (`intercomm_register(role: "master")`).

- Pass `count` = the number of workers from the argument.
- Set `worktrees: true` if the user passed "--worktrees" (branch-per-agent isolation; required for parallel AIMFP runs so each worker tracks on its own branch).

`intercomm_spawn` is non-blocking: it creates detached tmux sessions, launches Claude with the shared bus pinned, clears first-run dialogs, and wakes each worker to self-register. After spawning, call `intercomm_status` to confirm the session↔worker-id mapping, then `intercomm_scan` to surface any pane stuck on a permission dialog (clear it with `intercomm_approve`). Hand each worker its task with `intercomm_assign`.
