---
description: Register this Claude Code instance on the InterComm bus as master or worker.
argument-hint: [master|worker]
---

Call the `intercomm_register` MCP tool to register this instance on the InterComm coordination bus.

- If the user passed "master" as an argument, call `intercomm_register(role: "master")`. The master is the sole user-facing instance; it delegates to and controls workers via tmux. After registering as master, verify the AIMFP MCP tools are present in your toolset and warn the user if they are absent (InterComm is a hard AIMFP addon — coordination still works, but there is no AIMFP tracking or changeset merge without it).
- Otherwise call `intercomm_register()` (defaults to worker — auto-assigns the lowest `worker-N`). Workers are normally spawned and woken by the master and do not interact with the user.

After registering, call `intercomm_status` to confirm your identity and see active peers. The full master/worker protocol is auto-injected via the InterComm MCP `instructions` (re-read it any time with `intercomm_get_protocol`).
