import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Generous because `git add --all` snapshots of large repositories can be slow.
const GIT_TIMEOUT_MS = 120_000;
export const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: "1" };

export async function git(
  root: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeout?: number;
    // Porcelain output starts with significant spaces.
    untrimmed?: boolean;
  } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, ...options.env },
    signal: options.signal,
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return options.untrimmed ? stdout : stdout.trim();
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function countLines(numstat: string): number {
  let lines = 0;
  for (const row of numstat.split("\n")) {
    const [added, deleted] = row.split("\t");
    lines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return lines;
}
