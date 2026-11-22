import { parentPort, workerData } from "node:worker_threads";
import variant from "@jitl/quickjs-ng-wasmfile-release-asyncify";
import { loadAsyncQuickJs } from "@sebastianwessel/quickjs";

if (!parentPort) {
	throw new Error("repo_execute sandbox worker requires a parent port");
}

const pending = new Map();
let nextCallId = 1;

parentPort.on("message", (message) => {
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

const call = (method, args) =>
	new Promise((resolve, reject) => {
		const id = nextCallId++;
		pending.set(id, { resolve, reject });
		parentPort.postMessage({ type: "call", id, method, args });
	});

const hostRepo = {
	list: (...args) => call("list", args),
	info: (...args) => call("info", args),
	search: (...args) => call("search", args),
	files: (...args) => call("files", args),
	grep: (...args) => call("grep", args),
	read: (...args) => call("read", args),
	clone: (...args) => call("clone", args),
};

const boundedError = (error) => {
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

	return `${name}: ${message}`;
};

try {
	const { runSandboxed } = await loadAsyncQuickJs(variant);

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
${workerData.code}
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
		parentPort.postMessage({ type: "done", error: `${result.error.name}: ${result.error.message}`.slice(0, 4096) });
	} else if (result.data?.sandboxError) {
		parentPort.postMessage({ type: "done", error: boundedError(result.data.sandboxError) });
	} else {
		parentPort.postMessage({ type: "done", result: result.data });
	}
} catch (error) {
	parentPort.postMessage({ type: "done", error: boundedError(error) });
}
