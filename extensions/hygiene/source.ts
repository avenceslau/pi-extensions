import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Where the linted files are read from: a git tree or commit when a ref is given, otherwise the checkout on disk.
export interface SourceTree {
  read(path: string): Promise<string>;
  listDir(dir: string): Promise<string[]>;
  // Whole-word occurrences in the repository's tracked files, or undefined when git cannot count them.
  countWord(word: string): Promise<number | undefined>;
}

export async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    maxBuffer: MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    signal,
  });

  return stdout;
}

// Outside a repository the directory itself is the root.
export async function repositoryRoot(dir: string, signal?: AbortSignal): Promise<string> {
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"], signal)).trim();
  } catch {
    return dir;
  }
}

function sumCounts(output: string): number {
  let total = 0;

  for (const row of output.split("\n")) {
    total += Number(row.split(":").at(-1)) || 0;
  }

  return total;
}

export function sourceTree(root: string, ref?: string): SourceTree {
  const countWord = async (word: string) => {
    const args = ["grep", "-c", "-w", "-I", "-F", "-e", word];

    if (ref) {
      args.push(ref);
    }

    try {
      return sumCounts(await git(root, [...args, "--"]));
    } catch (error) {
      // git grep exits 1 when nothing matches.
      const nothingMatched =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1;

      return nothingMatched ? 0 : undefined;
    }
  };

  if (!ref) {
    return {
      read: (path) => readFile(join(root, path), "utf8"),
      listDir: (dir) => readdir(join(root, dir)).catch(() => []),
      countWord,
    };
  }

  return {
    read: (path) => git(root, ["show", `${ref}:${path}`]),
    listDir: async (dir) => {
      const prefix = dir === "." ? "" : `${dir}/`;
      const pathspec = prefix ? ["--", prefix] : [];
      const listing = await git(root, ["ls-tree", "--name-only", ref, ...pathspec]).catch(() => "");

      return listing
        .split("\n")
        .filter(Boolean)
        .map((path) => path.slice(prefix.length));
    },
    countWord,
  };
}
