import { resolve } from "node:path";
import type { Repository, Trigger } from "./definition.ts";
import { errorMessage } from "./errors.ts";
import { runProgram } from "./exec.ts";
import { sandboxProfile } from "./guard/sandbox.ts";

const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const SETUP_ERROR_MAX_CHARACTERS = 3_000;

export interface PreparedWorktree {
  path: string;
  gitDirectory: string;
  // The worktree had uncommitted changes, so it was left where it was instead of moved to the start.
  keptUncommittedChanges: boolean;
  // Why the repository's setup failed, when it did; the run starts anyway and is told.
  setupFailure?: string;
}

// Runs in the agents' own sandbox, so setup can write no more than the agent could.
export async function changedFiles(path: string): Promise<Set<string>> {
  const output = await runProgram("git", ["diff", "--name-only"], {
    cwd: path,
  });

  return new Set(output.split("\n").filter((file) => file !== ""));
}

// Setup may rewrite tracked files, as pnpm does with its lockfile. Those edits are put back, so the agent starts from
// the commit and a worktree is not left with changes nobody made; files changed before setup stay as they were.
export async function restoreFilesSetupChanged(
  path: string,
  before: Set<string>,
): Promise<void> {
  const rewritten = [...(await changedFiles(path))].filter(
    (file) => !before.has(file),
  );

  if (rewritten.length > 0) {
    await runProgram("git", ["checkout", "--", ...rewritten], { cwd: path });
  }
}

async function runSetup(
  repository: Repository,
  path: string,
  gitDirectory: string,
): Promise<string | undefined> {
  const before = await changedFiles(path);

  try {
    await runProgram(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        sandboxProfile({ worktree: path, gitDirectory }),
        ...repository.setup,
      ],
      {
        cwd: path,
        timeoutMs: SETUP_TIMEOUT_MS,
      },
    );
    await restoreFilesSetupChanged(path, before);

    return undefined;
  } catch (error) {
    await restoreFilesSetupChanged(path, before);

    const message = errorMessage(error);

    return message.length > SETUP_ERROR_MAX_CHARACTERS
      ? `…${message.slice(-SETUP_ERROR_MAX_CHARACTERS)}`
      : message;
  }
}

// Creates the trigger's branch worktree with Shirei, or reuses it. A clean reused worktree is moved to the trigger's
// start commit; a dirty one is left alone so a run never discards earlier work. With `shouldRunSetup`, the repository's
// setup then installs dependencies.
export async function prepareWorktree(
  repository: Repository,
  worktree: Trigger["worktree"],
  shouldRunSetup: boolean,
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

  const keptUncommittedChanges = status !== "";

  if (!keptUncommittedChanges) {
    await runProgram("git", ["reset", "--hard", start], { cwd: path });
  }

  const setupFailure =
    shouldRunSetup && repository.setup.length > 0
      ? await runSetup(repository, path, gitDirectory)
      : undefined;

  return {
    path,
    gitDirectory,
    keptUncommittedChanges,
    setupFailure,
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
