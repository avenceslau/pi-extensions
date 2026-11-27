import { resolve } from "node:path";
import type { Repository, Trigger } from "./definition.ts";
import { runProgram } from "./exec.ts";

export interface PreparedWorktree {
  path: string;
  gitDirectory: string;
  // The worktree had uncommitted changes, so it was left where it was instead of moved to the start.
  keptUncommittedChanges: boolean;
}

// Creates the trigger's branch worktree with Shirei, or reuses it. A clean reused worktree is moved to the trigger's
// start commit; a dirty one is left alone so a run never discards earlier work.
export async function prepareWorktree(
  repository: Repository,
  worktree: Trigger["worktree"],
): Promise<PreparedWorktree> {
  await runProgram("git", ["fetch", "origin", ...worktree.fetch], {
    cwd: repository.path,
  });

  const start = await runProgram(
    "git",
    ["rev-parse", `${worktree.start}^{commit}`],
    {
      cwd: repository.path,
    },
  );

  const output = await runProgram(
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

  const path = output.split("\n").at(-1)?.trim();

  if (!path) {
    throw new Error(
      `shirei branch ${worktree.branch} printed no worktree path`,
    );
  }

  const status = await runProgram("git", ["status", "--porcelain"], {
    cwd: path,
  });

  const gitDirectory = resolve(
    path,
    await runProgram("git", ["rev-parse", "--git-common-dir"], { cwd: path }),
  );

  if (status !== "") {
    return {
      path,
      gitDirectory,
      keptUncommittedChanges: true,
    };
  }

  await runProgram("git", ["reset", "--hard", start], { cwd: path });

  return {
    path,
    gitDirectory,
    keptUncommittedChanges: false,
  };
}

// Removes a worktree and its branch when it has no uncommitted changes; returns whether it did.
export async function removeWorktree(
  repository: Repository,
  path: string,
  branch: string,
): Promise<boolean> {
  try {
    await runProgram("git", ["worktree", "remove", path], {
      cwd: repository.path,
    });
  } catch {
    return false;
  }

  await runProgram("git", ["branch", "-D", branch], { cwd: repository.path });
  await runProgram("shirei", ["worktrees", "prune", "--missing"]);

  return true;
}
