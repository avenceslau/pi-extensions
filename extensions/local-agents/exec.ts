import { execFile } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

// Maps the items with at most `limit` calls in flight, keeping the input order.
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;

      next += 1;
      results[index] = await map(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );

  return results;
}

export const API_CONCURRENCY = 8;

// Runs a program without a shell and resolves to its trimmed stdout; rejects with stderr when it exits non-zero.
export function run(
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
        timeout: options.timeoutMs ?? 300_000,
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
