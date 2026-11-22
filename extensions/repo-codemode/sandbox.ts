import { Worker } from "node:worker_threads";
import type { RepoService } from "./repo-service.ts";

const MAX_CODE_BYTES = 20 * 1024;
const MAX_CALLS = 24;
const MAX_SEARCH_CALLS = 6;
const MAX_REMOTE_PROJECTS = 100;
const MAX_HOST_BYTES = 768 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_LINES = 300;
const EXECUTION_TIMEOUT_MS = 30_000;

interface WorkerCallMessage {
  type: "call";
  id: number;
  method: string;
  args: unknown[];
}

interface WorkerDoneMessage {
  type: "done";
  result?: { text?: unknown; guestTruncated?: unknown };
  error?: string;
}

type WorkerMessage = WorkerCallMessage | WorkerDoneMessage;

function compact(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  const json = JSON.stringify(value);

  return json === undefined ? String(value) : json;
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return message.slice(0, 4096);
}

function truncate(text: string, alreadyTruncated = false) {
  let end = text.length;
  let lineCount = 1;

  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 && ++lineCount > MAX_OUTPUT_LINES) {
      end = i;
      break;
    }
  }

  let output = text.slice(0, end);
  let truncated = alreadyTruncated || end < text.length;

  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
    const characters = Array.from(output);
    let low = 0;
    let high = characters.length;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);

      if (
        Buffer.byteLength(characters.slice(0, middle).join("")) <=
        MAX_OUTPUT_BYTES
      ) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    output = characters.slice(0, low).join("");
    truncated = true;
  }

  if (truncated) {
    output +=
      "\n[repo_execute output truncated; return a smaller result or read fewer lines]";
  }

  return { text: output, truncated };
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : (value as string);
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : (value as number);
}

export async function executeRepoCode(
  code: string,
  service: RepoService,
  allowedProjects: ReadonlySet<string>,
  signal?: AbortSignal,
) {
  if (
    !code ||
    Buffer.byteLength(code) > MAX_CODE_BYTES ||
    code.includes("\0")
  ) {
    throw new Error("Code must contain 1-20480 bytes and no NUL bytes");
  }

  if (signal?.aborted) {
    throw new Error("Repository execution cancelled");
  }

  return new Promise<{
    text: string;
    truncated: boolean;
    details: {
      calls: number;
      hostBytes: number;
      truncated: boolean;
      remoteProjects: string[];
    };
  }>((resolvePromise, reject) => {
    const controller = new AbortController();
    const initialProjects = new Set(
      [...allowedProjects].slice(0, MAX_REMOTE_PROJECTS),
    );
    const executionProjects = new Set(initialProjects);
    const newProjects = new Set<string>();
    const worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
      workerData: { code },
    });
    let calls = 0;
    let searchCalls = 0;
    let hostBytes = 0;
    let pendingCalls = 0;
    let queue: Promise<unknown> = Promise.resolve();
    let settled = false;

    const onAbort = () => {
      void finish(new Error("Repository execution cancelled"));
    };

    const timeout = setTimeout(() => {
      void finish(
        new Error(
          `repo_execute timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, EXECUTION_TIMEOUT_MS);

    const dispatch = async (method: string, args: unknown[]) => {
      switch (method) {
        case "list":
          return service.list();
        case "info":
          return service.info(args[0] as string, controller.signal);
        case "search": {
          const result = await service.search(
            args[0] as string,
            args[1] as boolean,
            controller.signal,
          );

          for (const match of result.remote) {
            if (executionProjects.size >= MAX_REMOTE_PROJECTS) {
              break;
            }

            executionProjects.add(match.project);

            if (!initialProjects.has(match.project)) {
              newProjects.add(match.project);
            }
          }

          return result;
        }

        case "files":
          return service.files(
            args[0] as string,
            optionalString(args[1]),
            controller.signal,
          );
        case "grep":
          return service.grep(
            args[0] as string,
            args[1] as string,
            optionalString(args[2]),
            controller.signal,
          );
        case "read":
          return service.read(
            args[0] as string,
            args[1] as string,
            optionalNumber(args[2]),
            optionalNumber(args[3]),
          );
        case "clone":
          return service.clone(
            args[0] as string,
            executionProjects,
            optionalString(args[1]),
            controller.signal,
          );
        default:
          throw new Error(`Unknown repository method: ${method}`);
      }
    };

    const finish = async (
      error?: Error,
      result?: WorkerDoneMessage["result"],
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      await worker.terminate();
      await queue;

      if (error) {
        reject(error);

        return;
      }

      if (typeof result?.text !== "string") {
        reject(new Error("repo_execute returned an invalid sandbox result"));

        return;
      }

      const output = truncate(result.text, result.guestTruncated === true);
      resolvePromise({
        ...output,
        details: {
          calls,
          hostBytes,
          truncated: output.truncated,
          remoteProjects: [...newProjects],
        },
      });
    };

    const handleCall = (message: WorkerCallMessage) => {
      calls += 1;

      if (calls > MAX_CALLS) {
        worker.postMessage({
          type: "callResult",
          id: message.id,
          error: `Repository API call limit exceeded (${MAX_CALLS})`,
        });

        return;
      }

      if (message.method === "search" && ++searchCalls > MAX_SEARCH_CALLS) {
        worker.postMessage({
          type: "callResult",
          id: message.id,
          error: `Repository search call limit exceeded (${MAX_SEARCH_CALLS})`,
        });

        return;
      }

      pendingCalls += 1;

      const task = queue.then(async () => {
        if (controller.signal.aborted) {
          throw new Error("Repository execution cancelled or timed out");
        }

        const result = await dispatch(message.method, message.args);
        hostBytes += Buffer.byteLength(compact(result));

        if (hostBytes > MAX_HOST_BYTES) {
          throw new Error(
            "Repository API data budget exceeded; narrow the search or read fewer lines",
          );
        }

        return result;
      });

      const tracked = task.then(
        (result) => {
          pendingCalls -= 1;

          if (!settled) {
            worker.postMessage({ type: "callResult", id: message.id, result });
          }

          return result;
        },
        (error) => {
          pendingCalls -= 1;

          if (!settled) {
            worker.postMessage({
              type: "callResult",
              id: message.id,
              error: boundedError(error),
            });
          }

          throw error;
        },
      );

      queue = tracked.catch(() => undefined);
    };

    worker.on("message", (message: WorkerMessage) => {
      if (settled) {
        return;
      }

      if (message.type === "call") {
        handleCall(message);

        return;
      }

      if (pendingCalls > 0) {
        void finish(
          new Error(
            "repo_execute returned before repository operations settled; await every repo call",
          ),
        );

        return;
      }

      if (message.error) {
        void finish(new Error(message.error.slice(0, 4096)));

        return;
      }

      void finish(undefined, message.result);
    });
    worker.on("error", (error) => {
      void finish(new Error(boundedError(error)));
    });
    worker.on("exit", (code) => {
      if (!settled) {
        void finish(
          new Error(
            `repo_execute worker exited before returning a result (${code})`,
          ),
        );
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
