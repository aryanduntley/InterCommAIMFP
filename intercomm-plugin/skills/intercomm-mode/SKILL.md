---
name: intercomm-mode
description: >
  InterComm AIMFP multi-instance coordination bootstrap. Loads when the InterComm
  MCP server is connected. Its only job: register this instance's role and (for a
  master) verify the AIMFP dependency. All behavioral rules live in the InterComm
  coordination protocol, delivered automatically via the MCP server's instructions
  field — never duplicated here.
user-invocable: false
---

# InterComm AIMFP — Coordination Bootstrap (setup only)

This skill is intentionally tiny. InterComm's master/worker behavior is defined by
the **coordination protocol**, which the InterComm MCP server auto-injects into
every connected instance via its `instructions` field (re-readable on demand with
the `intercomm_get_protocol` tool). That protocol is the single source of truth;
this file deliberately does **not** restate it, to avoid duplicating that content
into every session.

When the InterComm MCP server is connected:

1. **Register your role.** The user decides who is master. The master instance
   calls `intercomm_register(role: "master")`; every other instance calls
   `intercomm_register()` (defaults to worker, auto-assigning the lowest
   `worker-N`). Workers are normally spawned and woken by the master via tmux —
   they do not interact with the user and do not poll.

2. **Master only — verify the AIMFP dependency.** InterComm AIMFP is a hard AIMFP
   addon: the worker flow runs `aimfp_run` / `git_create_branch`, and the master
   integrates each branch via `export_state_changeset` / `apply_state_changeset`.
   After registering as master, confirm the AIMFP MCP tools are present in your
   toolset; if they are absent, warn the user — coordination and worktree
   isolation still work, but there is no AIMFP tracking or changeset merge until
   the AIMFP MCP server is connected.

Nothing else belongs here. Follow the injected protocol (and
`intercomm_get_protocol`) for everything about delegation, spawning, escalation,
and the merge queue.
