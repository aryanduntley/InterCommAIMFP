---
description: Show all InterComm instances and (for the master) the worktree merge-queue view.
---

Call the `intercomm_status` MCP tool to list all registered instances (id, role, active/inactive, session, tmux target). If you are the master and workers are running in isolated worktrees, also call `intercomm_worktree_list` for the merge-queue lifecycle view (queued → merging → verifying → merged / conflict / failed).
