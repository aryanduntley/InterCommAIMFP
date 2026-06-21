// Thin IO wrappers around the git CLI.
//
// Every function here shells out (side effect) and returns data — no logic.
// InterComm's only git responsibility is filesystem ISOLATION: create and
// remove worktrees. Branch creation and all merge semantics belong to AIMFP's
// git directives, run by the agents — InterComm never branches or merges.

import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly error: string };

const runGit = (cwd: string, args: readonly string[]): GitResult => {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout };
  } catch (err) {
    const msg =
      err && typeof err === "object" && "stderr" in err && err.stderr
        ? String(err.stderr).trim()
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: msg };
  }
};

// Absolute path to the repo's COMMON git dir (shared by all linked worktrees),
// or null if cwd is not inside a git repo. `--git-common-dir` can return a path
// relative to cwd, so normalize it to absolute.
export const gitCommonDir = (cwd: string): string | null => {
  const res = runGit(cwd, ["rev-parse", "--git-common-dir"]);
  if (!res.ok) return null;
  return isAbsolute(res.stdout) ? res.stdout : resolve(cwd, res.stdout);
};

// `git worktree add --detach <path> <base>` — detached HEAD at base's commit.
// Detached because git refuses to check out a branch (e.g. main) in two
// worktrees at once; the worker then runs AIMFP git_create_branch inside it.
export const addWorktree = (
  repoRoot: string,
  worktreePath: string,
  base: string,
): GitResult =>
  runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, base]);

// `git worktree remove [--force] <path>`.
export const removeWorktree = (
  repoRoot: string,
  worktreePath: string,
  force: boolean = false,
): GitResult =>
  runGit(
    repoRoot,
    force
      ? ["worktree", "remove", "--force", worktreePath]
      : ["worktree", "remove", worktreePath],
  );
