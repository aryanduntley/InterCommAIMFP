// Pure functions for paths and constants

import { dirname, join, resolve } from "node:path";

const BASE_DIR_NAME = ".intercomm-aimfp";
const DB_FILE_NAME = "intercomm.db";
const WORKTREES_DIR_NAME = ".intercomm-worktrees";

export const STALE_THRESHOLD_MS = 30_000;
export const DEFAULT_KEEP = 100;

export const ENV_DB_ROOT = "INTERCOMM_DB_ROOT";

export const basePath = (root: string): string => join(root, BASE_DIR_NAME);

export const dbFile = (root: string): string =>
  join(basePath(root), DB_FILE_NAME);

// Resolve the directory that holds the SHARED intercomm.db. With one worktree
// per worker, the launch cwd differs per worker, so the bus must be pinned to a
// single path. Precedence (all inputs supplied by the caller's IO layer):
//   1. an explicit INTERCOMM_DB_ROOT override (exported by spawn-workers.sh),
//   2. the parent of the repo's common git dir (same for every linked worktree),
//   3. the launch cwd (non-git / single-tree fallback).
// Pure: it only transforms the strings it is given.
export const resolveDbRoot = (opts: {
  cwd: string;
  envRoot?: string | undefined;
  gitCommonDir?: string | null | undefined;
}): string => {
  const env = opts.envRoot?.trim();
  if (env) return env;
  if (opts.gitCommonDir) return dirname(opts.gitCommonDir);
  return opts.cwd;
};

// Default on-disk location for a worker's worktree: a sibling of the repo root
// (outside the main checkout, so git does not recursively scan it).
export const worktreesDir = (root: string): string =>
  resolve(root, "..", WORKTREES_DIR_NAME);

export const worktreePath = (root: string, workerId: string): string =>
  join(worktreesDir(root), workerId);

// Warn when the resolved bus root differs from the launch cwd — the signature of a
// project nested inside ANOTHER git repo: with no INTERCOMM_DB_ROOT pin, resolveDbRoot
// falls back to the parent of the git-common-dir, which for a nested checkout is the
// OUTER repo's root, not this project's. That mis-root makes intercomm_spawn(worktrees)
// create worktrees of the wrong repo (the Run-1 live-test bug). Pure: returns null when
// root == cwd. The caller suppresses it when INTERCOMM_DB_ROOT was explicitly set
// (root != cwd is then intentional, e.g. a pinned shared bus).
export const rootMismatchWarning = (
  resolvedRoot: string,
  cwd: string,
): string | null => {
  if (resolve(resolvedRoot) === resolve(cwd)) return null;
  return (
    `WARNING: InterComm bus root (${resolvedRoot}) differs from the launch directory (${cwd}). ` +
    `If this project is nested inside another git repository, spawned worktrees may be created from the WRONG repo. ` +
    `Pin INTERCOMM_DB_ROOT to the intended project root, or launch from a standalone (non-nested) checkout before spawning.`
  );
};
