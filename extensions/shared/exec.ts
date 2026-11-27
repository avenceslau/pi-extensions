import { execFile } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  // Added to the current environment.
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

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
        env: options.env ? { ...process.env, ...options.env } : undefined,
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
