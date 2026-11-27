import { execFile } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  mapItem: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;

      next += 1;
      results[index] = await mapItem(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );

  return results;
}

export const API_CONCURRENCY = 8;

const DEFAULT_TIMEOUT_MS = 300_000;

// Resolves to the trimmed stdout; rejects with stderr when the program exits non-zero.
export function runProgram(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        maxBuffer: 256 * 1024 * 1024,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")}: ${stderr.trim() || error.message}`,
            ),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}
