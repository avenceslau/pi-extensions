import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE_READ_DENY_RULES } from "../../protect-env-files/sandbox-rules.ts";
import { realPathOrSelf } from "../paths.ts";

// Build caches and tool state that tests and builds write to, relative to the home directory.
const CACHE_DIRECTORIES = [
  ".cache",
  "Library/Caches",
  ".npm",
  ".local/share/pnpm",
  ".local/state/pnpm",
  "Library/pnpm",
  ".cargo/registry",
  ".cargo/git",
  ".rustup",
  ".wrangler",
];

// cargo locks and rewrites these even when it only checks that a tool is installed. ~/.cargo/bin, the cargo config,
// and its credentials stay read-only, so nothing new lands on the user's PATH.
const CARGO_STATE_FILES = [
  ".cargo/.crates.toml",
  ".cargo/.crates2.json",
  ".cargo/.package-cache",
  ".cargo/.package-cache-mutate",
  ".cargo/.global-cache",
];

export interface SandboxPaths {
  worktree: string;
  // The clone's git directory, which git writes to for commits made in the worktree.
  gitDirectory: string;
}

// A macOS sandbox profile that refuses reads of environment files outside the worktree and writes anywhere but the
// worktree, git, temporary directories, and build caches. The worktree is a fresh checkout, so the environment files in
// it are tracked ones that `git show` reads anyway; refusing them only breaks git.
export function sandboxProfile({
  worktree,
  gitDirectory,
}: SandboxPaths): string {
  const directories = [
    worktree,
    gitDirectory,
    "/dev",
    "/private/tmp",
    tmpdir(),
    ...CACHE_DIRECTORIES.map((directory) => join(homedir(), directory)),
  ].map(realPathOrSelf);

  const files = CARGO_STATE_FILES.map((file) =>
    realPathOrSelf(join(homedir(), file)),
  );

  const allowWrites = [
    ...directories.map(
      (path) => `(allow file-write* (subpath ${JSON.stringify(path)}))`,
    ),
    ...files.map(
      (path) => `(allow file-write* (literal ${JSON.stringify(path)}))`,
    ),
  ].join("");

  const allowWorktreeReads = `(allow file-read* (subpath ${JSON.stringify(realPathOrSelf(worktree))}))`;

  return `(version 1)(allow default)${ENV_FILE_READ_DENY_RULES}${allowWorktreeReads}(deny file-write*)${allowWrites}`;
}
