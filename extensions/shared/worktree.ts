import { resolve } from "node:path";
import { runProgram } from "./exec.ts";

export interface PreparedWorktree {
  path: string;
  gitDirectory: string;
  // The worktree had uncommitted changes, so it was left where it was instead of moved to the start.
  keptUncommittedChanges: boolean;
}

export interface WorktreeRequest {
  branch: string;
  // Refs to fetch from origin first.
  fetch: string[];
  // The commit or ref to start the branch at.
  start: string;
}

// Creates the branch's worktree with Shirei, or reuses it. A clean reused worktree is moved to the start commit; a
// dirty one is left alone so earlier work is never discarded.
export async function prepareWorktree(
  repositoryPath: string,
  worktree: WorktreeRequest,
): Promise<PreparedWorktree> {
  await runProgram("git", ["fetch", "origin", ...worktree.fetch], {
    cwd: repositoryPath,
  });

  const start = await runProgram(
    "git",
    ["rev-parse", `${worktree.start}^{commit}`],
    {
      cwd: repositoryPath,
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
    { cwd: repositoryPath },
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

  const keptUncommittedChanges = status !== "";

  if (!keptUncommittedChanges) {
    await runProgram("git", ["reset", "--hard", start], { cwd: path });
  }

  return {
    path,
    gitDirectory,
    keptUncommittedChanges,
  };
}

// Removes a worktree and its branch when it has no uncommitted changes; returns whether it did.
export async function removeWorktree(
  repositoryPath: string,
  path: string,
  branch: string,
): Promise<boolean> {
  try {
    await runProgram("git", ["worktree", "remove", path], {
      cwd: repositoryPath,
    });
  } catch {
    return false;
  }

  await runProgram("git", ["branch", "-D", branch], { cwd: repositoryPath });
  await runProgram("shirei", ["worktrees", "prune", "--missing"]);

  return true;
}
