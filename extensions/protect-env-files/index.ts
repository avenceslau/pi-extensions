import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GREP_EXCLUDE_GLOB = "!{.env,.env.*,.dev.vars,.dev.vars.*,**/.env,**/.env.*,**/.dev.vars,**/.dev.vars.*}";

const MACOS_SANDBOX_DENY_RULES =
	'(version 1)(allow default)(deny file-read* (regex #".*/[.]env([.][^/]*)?$"))(deny file-read* (regex #".*/[.]dev[.]vars([.][^/]*)?$"))';

// Global only: a project-level allow list would let any repository unprotect its own secrets.
const ALLOW_LIST_PATH = join(homedir(), ".pi", "agent", "env-file-guard.json");

// Emits regex syntax that both JavaScript and the macOS sandbox (SBPL) accept, so one
// pattern drives the tool checks and the bash sandbox identically.
function globToRegexSource(pattern: string): string {
	if (/[\\\]^"\x00-\x1f]/.test(pattern)) {
		throw new Error(`unsupported character in allow pattern: ${pattern}`);
	}

	const absolute = pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern;
	let source = absolute.startsWith("/") ? "^" : "^.*/";

	for (let i = 0; i < absolute.length; i++) {
		const char = absolute[i];

		if (absolute.startsWith("**/", i)) {
			source += "(.*/)?";
			i += 2;
		} else if (absolute.startsWith("**", i)) {
			source += ".*";
			i += 1;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else if (/[A-Za-z0-9/_-]/.test(char)) {
			source += char;
		} else {
			source += `[${char}]`;
		}
	}

	return `${source}$`;
}

async function loadAllowList(): Promise<string[]> {
	let raw: string;

	try {
		raw = await readFile(ALLOW_LIST_PATH, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}

		throw error;
	}

	const allow = (JSON.parse(raw) as { allow?: unknown }).allow ?? [];

	if (!Array.isArray(allow) || !allow.every((entry) => typeof entry === "string" && entry !== "")) {
		throw new Error(`"allow" must be an array of non-empty strings`);
	}

	return allow.map(globToRegexSource);
}

function sandboxProfile(allowSources: string[]): string {
	const allowRules = allowSources.map((source) => `(allow file-read* (regex #"${source}"))`).join("");

	return `${MACOS_SANDBOX_DENY_RULES}${allowRules}(deny file-write* (literal "${ALLOW_LIST_PATH}"))`;
}

function isProtectedName(name: string): boolean {
	const normalized = name.toLowerCase();

	return (
		normalized === ".env" ||
		normalized.startsWith(".env.") ||
		normalized === ".dev.vars" ||
		normalized.startsWith(".dev.vars.")
	);
}

async function isProtectedPath(path: string, cwd: string): Promise<boolean> {
	const normalizedPath = path.replace(/^@/, "");

	if (normalizedPath.split(/[\\/]/).some(isProtectedName)) {
		return true;
	}

	try {
		return isProtectedName(basename(await realpath(resolve(cwd, normalizedPath))));
	} catch {
		return false;
	}
}

// Both the requested path and its symlink target must be allowed, so an allowed name
// cannot be used as a symlink to a protected file.
async function isAllowedPath(path: string, cwd: string, allow: RegExp[]): Promise<boolean> {
	const resolved = resolve(cwd, path.replace(/^@/, ""));
	const matches = (candidate: string) => allow.some((pattern) => pattern.test(candidate));

	if (!matches(resolved)) {
		return false;
	}

	try {
		return matches(await realpath(resolved));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return false;
		}

		// A dangling symlink would let a write create its protected target.
		return lstat(resolved).then(
			() => false,
			(lstatError: NodeJS.ErrnoException) => lstatError.code === "ENOENT",
		);
	}
}

async function isBlockedPath(path: string, cwd: string, allow: RegExp[]): Promise<boolean> {
	return (await isProtectedPath(path, cwd)) && !(await isAllowedPath(path, cwd, allow));
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-env-file-guard", {
		description: "Disable the environment-file guard",
		type: "boolean",
		default: false,
	});

	let guardEnabled = true;
	let allowSources: string[] = [];
	let allowPatterns: RegExp[] = [];

	async function reloadAllowList(notify: (message: string, level: "info" | "warning") => void) {
		try {
			allowSources = await loadAllowList();
		} catch (error) {
			allowSources = [];
			notify(`Ignoring ${ALLOW_LIST_PATH}: ${(error as Error).message}`, "warning");
		}

		allowPatterns = allowSources.map((source) => new RegExp(source));
	}

	pi.on("session_start", async (_event, ctx) => {
		guardEnabled = pi.getFlag("no-env-file-guard") !== true;

		const notify = (message: string, level: "info" | "warning") => {
			if (ctx.hasUI) {
				ctx.ui.notify(message, level);
			}
		};

		if (!guardEnabled) {
			notify("Environment-file guard disabled via --no-env-file-guard", "warning");
		}

		await reloadAllowList(notify);
	});

	pi.registerCommand("env-file-guard", {
		description: "Enable, disable, reload the allow list, or show the environment-file guard",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "") {
				ctx.ui.notify(
					`Environment-file guard is ${guardEnabled ? "enabled" : "disabled"}; ${allowSources.length} allow pattern(s) from ${ALLOW_LIST_PATH}`,
					"info",
				);

				return;
			}

			if (action === "reload") {
				await reloadAllowList((message, level) => ctx.ui.notify(message, level));
				ctx.ui.notify(`Loaded ${allowSources.length} allow pattern(s)`, "info");

				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /env-file-guard on|off|reload", "warning");

				return;
			}

			guardEnabled = action === "on";
			ctx.ui.notify(
				`Environment-file guard ${guardEnabled ? "enabled" : "disabled"}`,
				guardEnabled ? "info" : "warning",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!guardEnabled) {
			return undefined;
		}

		if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") {
			const path = event.input.path;

			if (
				event.toolName !== "read" &&
				typeof path === "string" &&
				resolve(ctx.cwd, path.replace(/^@/, "").replace(/^~(?=\/)/, homedir())) === ALLOW_LIST_PATH
			) {
				return {
					block: true,
					reason: "The environment-file guard allow list can only be edited by the user",
				};
			}

			if (typeof path === "string" && (await isBlockedPath(path, ctx.cwd, allowPatterns))) {
				return {
					block: true,
					reason: `Accessing ${basename(path)} is blocked by the environment-file guard`,
				};
			}
		}

		if (event.toolName === "grep") {
			const path = typeof event.input.path === "string" ? event.input.path : ".";

			if (await isBlockedPath(path, ctx.cwd, allowPatterns)) {
				return {
					block: true,
					reason: `Searching ${basename(path)} is blocked by the environment-file guard`,
				};
			}

			try {
				if (event.input.glob !== undefined && (await stat(resolve(ctx.cwd, path))).isDirectory()) {
					return {
						block: true,
						reason: "Directory grep with a custom glob is blocked because it cannot safely exclude environment files; retry without glob",
					};
				}
			} catch {
				return undefined;
			}

			event.input.glob = GREP_EXCLUDE_GLOB;
		}

		if (event.toolName === "bash") {
			if (process.platform !== "darwin") {
				return {
					block: true,
					reason: "Bash is blocked because this platform cannot enforce the environment-file sandbox",
				};
			}

			const shell = process.env.SHELL || "/bin/sh";
			event.input.command = [
				"/usr/bin/sandbox-exec",
				"-p",
				shellQuote(sandboxProfile(allowSources)),
				shellQuote(shell),
				"-c",
				shellQuote(event.input.command),
			].join(" ");
		}

		if (event.toolName === "Agent" && event.input.isolated === true) {
			return {
				block: true,
				reason: "Isolated subagents are blocked because they would not inherit the environment-file guard",
			};
		}

		return undefined;
	});
}
