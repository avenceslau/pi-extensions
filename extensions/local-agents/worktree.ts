import { resolve } from "node:path";
import type { Repository, Trigger } from "./definition.ts";
import { run } from "./exec.ts";

export interface PreparedWorktree {
  path: string;
  gitDirectory: string;
  // Set when the worktree had uncommitted changes, so it was left where it was instead of moved to the start.
  dirty: boolean;
}

// Creates the trigger's branch worktree with Shirei, or reuses it. A clean reused worktree is moved to the trigger's
// start commit; a dirty one is left alone so a run never discards earlier work.
export async function prepareWorktree(
  repository: Repository,
  worktree: Trigger["worktree"],
): Promise<PreparedWorktree> {
  await run("git", ["fetch", "origin", ...worktree.fetch], {
    cwd: repository.path,
  });

  const start = await run("git", ["rev-parse", `${worktree.start}^{commit}`], {
    cwd: repository.path,
  });

  const output = await run(
    "shirei",
    [
      "branch",
      worktree.branch,
      "--base",
      start,
      "--no-open",
      "--print-path",
      "--install=none",
    ],
    { cwd: repository.path },
  );

  const path = output.split("\n").at(-1)!.trim();
  const status = await run("git", ["status", "--porcelain"], { cwd: path });

  const gitDirectory = resolve(
    path,
    await run("git", ["rev-parse", "--git-common-dir"], { cwd: path }),
  );

  if (status !== "") {
    return {
      path,
      gitDirectory,
      dirty: true,
    };
  }

  await run("git", ["reset", "--hard", start], { cwd: path });

  return {
    path,
    gitDirectory,
    dirty: false,
  };
}

// Removes a worktree and its branch when it has no uncommitted changes; returns whether it did.
export async function removeWorktree(
  repository: Repository,
  path: string,
  branch: string,
): Promise<boolean> {
  try {
    await run("git", ["worktree", "remove", path], { cwd: repository.path });
  } catch {
    return false;
  }

  await run("git", ["branch", "-D", branch], { cwd: repository.path });
  await run("shirei", ["worktrees", "prune", "--missing"]);

  return true;
}
