# InterCommAIMFP - Project Blueprint

**Version**: 1.0
**Status**: Active — Phase 1 (worktree isolation) built & verified (uncommitted); Phases 2 / 2.5 / 3 / 4 designed
**Last Updated**: 2026-06-21
**AIMFP Compliance**: Strict

---

## 1. Project Overview

### Idea

InterCommAIMFP is a local-only intercommunication system that lets multiple Claude Code
instances coordinate in real time on one project. One **master** instance is the sole
user-facing coordinator; it controls tmux-spawned **worker** instances by *pushing*
prompts via `tmux send-keys` (workers never poll). All coordination state lives in a
single SQLite database (WAL mode) — no servers, HTTP, or sockets. It is exposed as an
**MCP server** loaded by each Claude Code instance.

The active initiative extends InterComm into an **optional multi-agent parallelization
addon for AIMFP**: each worker runs in its own isolated **git worktree + branch**, with
**AIMFP git directives** (run by the agents themselves) governing how each branch is
created and merged back.

### Current Phase

- **Phase 1 — Worktree isolation foundation:** ✅ built & smoke-verified, **uncommitted**.
  worktrees table + migration, 4 worktree MCP tools, shared-DB-root resolution,
  git-wrapper, `spawn-workers.sh --worktrees`, `kill-workers.sh` worktree cleanup.
- **Phase 2 — Directive-driven tasking:** ⬜ designed.
- **Phase 2.5 — Worker→master escalation (no-poll):** ⬜ designed (incl. a P0 message-bus
  cursor bug to fix first).
- **Phase 3 — Sequential merge queue:** ⬜ designed.
- **Phase 4 — Teardown + polish:** 🟡 partial (kill-workers worktree cleanup landed early).

### Goals

- FP-only: pure functions + thin IO wrappers, no classes/OOP (the only `new` is the two
  unavoidable MCP SDK instantiations in `mcp-server.ts`, plus built-in errors).
- SQLite-only coordination: no HTTP/WebSocket/network servers; minimal dependencies.
- tmux-push model: the master wakes workers via `send-keys`; workers never poll.
- Strict role enforcement: workers never talk to the user, delegate, or control peers.
- **AIMFP-agnostic addon boundary** (the decision that shapes everything): InterComm
  isolates files (worktrees), carries messages, and *tracks* status — it never reads
  AIMFP's DB and never runs `git merge`. All branch/merge semantics are AIMFP directives.
- Multi-agent parallelization: one git worktree per worker, one shared coordination DB
  at the repo root.
- Master-orchestrated merge queue invoking AIMFP `git_detect_conflicts` / `git_merge_branch`.

### Success Criteria

- With both MCP servers installed, the user can say "parallelize this across N agents" and
  the master spins up N tmux workers each in its own git worktree, all sharing one
  `intercomm.db`, visible in `intercomm_status` + `intercomm_worktree_list`.
- Each worker runs AIMFP `git_create_branch` inside its worktree and reports its
  `aimfp-worker-N-NNN` branch back; the master merges branches sequentially via AIMFP
  directives, tracking lifecycle in the `worktrees` table.
- A worker can raise a question with **zero master polling** (escalation wakes the master).
- Degradation holds: AIMFP works fully without InterComm; InterComm without AIMFP still
  orchestrates plain workers but warns it lacks managed branching/merge.

---

## 2. Technical Blueprint

### Language & Runtime

- **Primary Language**: TypeScript 5.9 (ESM)
- **Runtime**: Node v24.15.0 (npm 11.12.1)
- **Build Tool**: `tsc` (`npm run build`)
- **Testing**: none configured — manual smoke tests (a calculator delegation test passed)

### Architecture Style

- **Paradigm**: Functional Procedural (AIMFP) — pure functions + isolated thin IO wrappers.
- **Pattern**: data in / data out; errors-as-data (Result-style `GitResult`, optional
  returns) over throwing, except at the CLI boundary.
- **State**: immutable data shapes; the one mutable ref is the MCP `ServerState`
  (identity), isolated to the smallest scope.

### Key Infrastructure

- `@modelcontextprotocol/sdk` — MCP server (the integration surface).
- `better-sqlite3` — SQLite storage (WAL, `busy_timeout=5000`).
- `zod` — MCP tool input schemas (validates transport shape only, never AIMFP meaning).
- `git` CLI (worktree isolation), `tmux` (worker sessions/wake), Claude Code (the agents).

### Package Structure

```
src/
  types.ts        # data contracts: Role/MessageType/WorktreeStatus, Instance/Message/
                  #   Worktree (+ Row counterparts), conversions, WORKTREE_STATUSES SoT
  config.ts       # pure paths/constants + shared-DB-root + worktree path resolution
  fs-wrapper.ts   # thin IO: ensureDir
  git-wrapper.ts  # thin git IO: gitCommonDir / addWorktree(--detach) / removeWorktree
  db.ts           # SQLite layer: schema, migration, init/get/close, query primitives
  store.ts        # domain CRUD: instances, messages/cursors, worktree registry
  mcp-server.ts   # orchestrator: 11 MCP tool handlers + guards + server lifecycle
  cli.ts          # orchestrator: debug-only CLI over the same store
  mcp-entry.ts    # MCP STDIO entry shim
scripts/          # master-run bash (outside the TS build)
  spawn-workers.sh / scan-workers.sh / kill-workers.sh

.intercomm-aimfp/intercomm.db   # runtime SQLite bus (shared at repo root)
.intercomm-worktrees/<worker>   # per-worker isolated checkouts (sibling of repo)
```

Import direction: `mcp-entry → mcp-server → store → db → config/types`;
`cli → store → db → config/types`. No circular deps.

---

## 3. Project Themes & Flows

### Themes
1. **Instance Coordination** — register master/worker, worker-name allocation, 30s stale
   detection + master takeover, role enforcement. (store, mcp-server, cli)
2. **Messaging Bus** — 6 message types, direct + broadcast, cursor-based reads, clear.
3. **Worktree Isolation** — per-worker `--detach` worktrees, the `worktrees` registry +
   lifecycle, shared-DB-root resolution. AIMFP-agnostic.
4. **MCP Interface** — 11 tools, identity/master guards, server factory + lifecycle.
5. **Persistence** — SQLite schema/migration/primitives over better-sqlite3.
6. **tmux Orchestration** — spawn/scan/kill worker bash automation.

### Flows
1. **Instance Registration & Role Management** — register → master deactivates all / worker
   auto-assigns `worker-N`; every call touches `last_active`; stale master → takeover.
2. **Message Exchange** — send/broadcast → `insertMessage` → `readNewMessages` (cursor
   advance, excludes own, includes `all`); no-poll: master writes then tmux-wakes.
3. **Worktree Provisioning & Lifecycle** — `worktree_add` (`git worktree add --detach` +
   row) → worker runs AIMFP `git_create_branch` → `set_status` (branch + lifecycle) →
   `worktree_remove`.
4. **MCP Server Lifecycle** — entry resolves shared root → create state → init DB →
   register 11 tools → signal cleanup → STDIO connect.
5. **CLI Debug Operations** — `parseArgs` → dispatch over the same store.
6. **tmux Worker Orchestration** — `spawn-workers.sh` (→ optional worktrees, bootstrap,
   `INTERCOMM_DB_ROOT` export, wake/register) → `scan-workers.sh` → `kill-workers.sh`.
7. **Worker→Master Escalation** *(designed, Phase 2.5)* — `intercomm_escalate` writes a
   `question` AND wakes the master via stored `tmux_target`.
8. **Sequential Merge Queue** *(designed, Phase 3)* — master, per worker in order, drives
   AIMFP `git_detect_conflicts` → `git_merge_branch` (+ optional verify gate), tracking
   `worktrees.status`.

---

## 4. Completion Path

### Stage 1: Foundation & Catalog (done)
- AIMFP init + backfill of the existing FP codebase (12 files, 71 functions, 13 types).
- Phase 1 worktree isolation foundation (built, verified, **uncommitted**).

### Stage 2: Directive-Driven Parallelization
- Phase 2: workers honor `required_directives`, run AIMFP `git_create_branch` in-worktree,
  report branch back; task payload carries `constraints` / `validation` (ctx contract).
- Phase 2.5: P0 message-bus cursor fix (monotonic seq), then `intercomm_escalate` +
  `instances.tmux_target` for no-poll worker→master wake.

### Stage 3: Merge Queue
- Phase 3: master sequential merge loop via AIMFP directives against latest `main`;
  optional verification gate; conflict → revision → resubmit loop.

### Stage 4: Polish & Release
- Phase 4: `scan-workers.sh` worktree-aware; AIMFP-absent degradation warning; README/docs
  update; commit the addon work.

---

## 5. Evolution History

### Version 1 - 2026-06-21
- **Change**: AIMFP initialized over the existing InterCommAIMFP codebase; full backfill
  (project_catalog) of all source; blueprint absorbed from `InterCommAIMFP.md` (former
  CLAUDE.md) and `docs/multi-agent/*`.
- **Rationale**: Dogfood the AIMFP MCP server to track the multi-agent parallelization
  addon work going forward.

---

## 6. User Settings System

### Purpose
Per-directive AI-behavior customization via `user_preferences.db`.

### Active Preferences
None set yet.

---

## 7. User Custom Directives System

**Status**: NULL — not applicable. This is a Case 1 software-development project (building
the coordination tool itself), not Case 2 automation.

---

## 8. Key Decisions & Constraints

### Architectural Decisions
- **InterComm stays AIMFP-agnostic** (core invariant): it never imports AIMFP schema, never
  reads AIMFP's DB, never runs `git merge`. The Claude **master session** is the only glue
  — it reads AIMFP via AIMFP's MCP tools and passes plain params (branch names,
  `required_directives`, task instructions) into InterComm tools.
- **tmux-push, not poll**: the master wakes workers via `send-keys` (double-Enter to submit).
- **One worktree per worker + one shared DB at repo root** (`git worktree add --detach`;
  DB root resolved via `INTERCOMM_DB_ROOT` → parent of git common dir → cwd).
- **Worktree status is a ctx-informed superset** (`WORKTREE_STATUSES` single source of
  truth, drives the DB CHECK) to avoid a later Phase-3 migration.
- **Escalation Option B**: a dedicated tool does the `send-keys` so workers never touch tmux
  (role enforcement stays literally true).
- **Flat src/ → one `intercomm_core` module**; finer boundaries tracked at function/type level.

### Constraints
- **FP Compliance Mandatory**: no classes/OOP/inheritance/`this` (except MCP SDK + errors).
- **SQLite-only**: no HTTP/WebSocket/network servers; no heavy deps (no Express/ORM/Commander).
- **Role enforcement**: workers never interact with the user, delegate, control peers, or
  call `intercomm_clear`; may claim master only after 30s master staleness.
- **Don't over-engineer**: a coordination tool, not a chat platform.
- **Transport-shape validation only**: zod validates message/tool shape, never AIMFP meaning
  (`required_directives` / `validation` stay opaque strings; no AIMFP-flavored MessageType).

---

## 9. Notes & References

### Important Context
- Phase 1 is **uncommitted**; also pending in the tree: a CLAUDE.md change and the new
  `docs/` folder. A feature branch is suggested before committing.
- A full live `spawn-workers.sh --worktrees 3` end-to-end run has **not** yet been exercised
  (Phase 1 mechanics verified in isolation only).
- **P0 bug** (pre-existing, affects all messages): the read cursor is millisecond-`ts` based
  with strict `ts > cursor`; same-millisecond messages can be silently lost. Migrate to a
  monotonic `rowid`/sequence cursor before trusting escalation. (`src/store.ts` readNewMessages)
- AIMFP shared-DB prerequisite (`work_branches` / `merge_history` one DB across worktrees) is
  out of InterComm's scope — the master verifies it.

### External References
- `docs/multi-agent/00-HANDOFF.md` — goal + the AIMFP-agnostic core decision.
- `docs/multi-agent/01-DESIGN.md` — architecture, MCP surface, schema, phased plan, §6.5
  escalation, §6.5.1 Codex review hardening.
- `docs/multi-agent/02-AIMFP-GIT-DIRECTIVES.md` — distilled AIMFP git directive reference.
- `docs/multi-agent/03-CTX-GUIDELINE.md` — ctx (ctxrs/ctx) concepts adopted (worktree,
  bootstrap, merge queue, diff-review-as-gate, task contract).
- `docs/multi-agent/04-PROGRESS.md` — living phase status tracker.
- `InterCommAIMFP.md` (former CLAUDE.md) — original dev guidelines + protocol (now absorbed).
- `README.md` / `system-prompt.md` — user-facing setup + the pasteable agent protocol.
