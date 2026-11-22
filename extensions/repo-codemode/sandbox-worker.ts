import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { loadAsyncQuickJs } from "@sebastianwessel/quickjs";
import {
  Boolean,
  Object as ObjectType,
  Optional,
  String as StringType,
  Union,
} from "typebox";
import { Check } from "typebox/value";

type HostArgument = string | number | boolean | undefined;
type HostValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | HostValue[]
  | { [key: string]: HostValue };

type CallResultMessage = {
  type: "callResult";
  id: number;
  result?: HostValue;
  error?: string;
};

type PendingCall = {
  resolve: (value: HostValue) => void;
  reject: (reason: Error) => void;
};

const ErrorDetailsType = ObjectType({
  name: Optional(StringType()),
  message: Optional(StringType()),
});

const SandboxOutputType = Union([
  ObjectType({
    text: StringType(),
    guestTruncated: Boolean(),
  }),
  ObjectType({
    sandboxError: ErrorDetailsType,
  }),
]);

const require = createRequire(import.meta.url);
const quickJsVariant: Parameters<
  typeof loadAsyncQuickJs
>[0] = require("@jitl/quickjs-ng-wasmfile-release-asyncify");
const port = parentPort;

if (!port) {
  throw new Error("repo_execute sandbox worker requires a parent port");
}

const code: string = workerData.code;
const pending = new Map<number, PendingCall>();
let nextCallId = 1;

port.on("message", (message: CallResultMessage) => {
  if (message?.type !== "callResult" || typeof message.id !== "number") {
    return;
  }

  const call = pending.get(message.id);

  if (!call) {
    return;
  }

  pending.delete(message.id);

  if (typeof message.error === "string") {
    call.reject(new Error(message.error));
  } else {
    call.resolve(message.result);
  }
});

const call = (method: string, args: HostArgument[]) =>
  new Promise<HostValue>((resolve, reject) => {
    const id = nextCallId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ type: "call", id, method, args });
  });

const hostRepo = {
  list: () => call("list", []),
  info: (id: string) => call("info", [id]),
  search: (query: string, remote = false) => call("search", [query, remote]),
  files: (id: string, glob?: string) => call("files", [id, glob]),
  grep: (id: string, query: string, glob?: string) =>
    call("grep", [id, query, glob]),
  read: (id: string, path: string, start?: number, lines?: number) =>
    call("read", [id, path, start, lines]),
  clone: (project: string, dest?: string) => call("clone", [project, dest]),
};

const boundedError = (error: unknown) => {
  if (!Check(ErrorDetailsType, error)) {
    return "Error: Sandbox execution failed";
  }

  const name = (error.name ?? "Error").slice(0, 100);
  const message = (error.message ?? "Sandbox execution failed").slice(0, 4096);

  return `${name}: ${message}`;
};

try {
  const { runSandboxed } = await loadAsyncQuickJs(quickJsVariant);

  const result = await runSandboxed(
    async ({ ctx, evalCode }) => {
      ctx.runtime.setModuleLoader(() => {
        throw new Error("Imports are disabled in repo_execute");
      });

      return evalCode(`
const repo = ((host) => {
  const string = (value, name, optional = false) => {
    if (optional && value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new TypeError(name + " must be a string");
    }
    return value;
  };
  const integer = (value, name) => {
    if (value === undefined) {
      return undefined;
    }
    if (!Number.isInteger(value)) {
      throw new TypeError(name + " must be an integer");
    }
    return value;
  };
  return Object.freeze({
    list: () => host.list(),
    info: (id) => host.info(string(id, "id")),
    search: (query, remote = false) => host.search(string(query, "query"), Boolean(remote)),
    files: (id, glob) => host.files(string(id, "id"), string(glob, "glob", true)),
    grep: (id, query, glob) => host.grep(string(id, "id"), string(query, "query"), string(glob, "glob", true)),
    read: (id, path, start, lines) => host.read(string(id, "id"), string(path, "path"), integer(start, "start"), integer(lines, "lines")),
    clone: (project, dest) => host.clone(string(project, "project"), string(dest, "dest", true)),
  });
})(env.repo);
for (const key of ["log", "error", "warn", "info", "debug", "trace"]) {
  console[key] = () => {};
}
Object.freeze(console);
for (const fn of [Function, async function () {}, function* () {}, async function* () {}]) {
  Object.defineProperty(Object.getPrototypeOf(fn), "constructor", { value: undefined });
}
delete globalThis.eval;
delete globalThis.Function;
delete globalThis.env;
delete globalThis.process;
delete globalThis.fetch;
delete globalThis.require;
delete globalThis.Deno;
delete globalThis.Bun;
let output;
try {
  const value = await (async () => {
    "use strict";
${code}
  })();
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError("repo_execute must return a JSON-compatible value");
    }
  }
  const guestTruncated = text.length > 32768;
  output = { text: guestTruncated ? text.slice(0, 32768) : text, guestTruncated };
} catch (error) {
  let name = "Error";
  let message = "Sandbox execution failed";
  try {
    if (typeof error?.name === "string") {
      name = error.name.slice(0, 100);
    }
    if (typeof error?.message === "string") {
      message = error.message.slice(0, 4096);
    }
  } catch {}
  output = { sandboxError: { name, message } };
}
export default output;
`);
    },
    {
      allowFetch: false,
      allowFs: false,
      env: { repo: hostRepo },
      memoryLimit: 32 * 1024 * 1024,
      maxStackSize: 512 * 1024,
      maxTimeoutCount: 2,
      maxIntervalCount: 0,
      console: {
        log: () => {},
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      },
    },
  );

  if (!result.ok) {
    port.postMessage({
      type: "done",
      error: `${result.error.name}: ${result.error.message}`.slice(0, 4096),
    });
  } else if (!Check(SandboxOutputType, result.data)) {
    port.postMessage({
      type: "done",
      error: "repo_execute returned an invalid sandbox result",
    });
  } else if ("sandboxError" in result.data) {
    port.postMessage({
      type: "done",
      error: boundedError(result.data.sandboxError),
    });
  } else {
    port.postMessage({ type: "done", result: result.data });
  }
} catch (error) {
  port.postMessage({ type: "done", error: boundedError(error) });
}
