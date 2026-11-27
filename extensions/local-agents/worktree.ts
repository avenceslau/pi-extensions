import { runProgram } from "../shared/exec.ts";
import { prepareWorktree, type PreparedWorktree } from "../shared/worktree.ts";
import type { Repository, Trigger } from "./definition.ts";
import { errorMessage } from "./errors.ts";
import { sandboxProfile } from "./guard/sandbox.ts";

const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const SETUP_ERROR_MAX_CHARACTERS = 3_000;

export interface AgentWorktree extends PreparedWorktree {
  // Why the repository's setup failed, when it did; the run starts anyway and is told.
  setupFailure?: string;
}

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

// Runs in the agents' own sandbox, so setup can write no more than the agent could.
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

// Prepares the trigger's worktree; with `shouldRunSetup`, the repository's setup then installs dependencies.
export async function prepareAgentWorktree(
  repository: Repository,
  worktree: Trigger["worktree"],
  shouldRunSetup: boolean,
): Promise<AgentWorktree> {
  const prepared = await prepareWorktree(repository.path, worktree);

  if (!shouldRunSetup || repository.setup.length === 0) {
    return prepared;
  }

  return {
    ...prepared,
    setupFailure: await runSetup(
      repository,
      prepared.path,
      prepared.gitDirectory,
    ),
  };
}
