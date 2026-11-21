import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepoService, runCommand, type CommandRunner } from "../repo-service.ts";

function commandResult(stdout = "", code = 0) {
	return { code, stdout, stderr: "", limited: false, timedOut: false };
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "repo-codemode-"));
	const repo = join(root, "alpha");
	await mkdir(join(repo, ".git"), { recursive: true });
	await mkdir(join(repo, "src"));
	await writeFile(join(repo, "src", "worker.ts"), "export const DurableWidget = 42;\n");
	await writeFile(join(repo, "src", "special-path.ts"), "export const ordinary = true;\n");
	await writeFile(join(repo, ".env"), "SECRET=value\n");
	await writeFile(join(repo, ".env.local"), "SECRET=local\n");
	await writeFile(join(repo, ".dev.vars.production"), "SECRET=production\n");
	await writeFile(join(repo, ".git", "config"), "credential=secret\n");
	await mkdir(join(root, "not-a-repo"));
	return { root, repo };
}

test("discovers direct child repositories and searches source", async (t) => {
	const { root } = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new RepoService({ projectsRoot: root, runner: runCommand });

	assert.deepEqual(await service.list(), [{ id: "alpha" }]);
	const result = await service.search("DurableWidget");
	assert.equal(result.remoteAttempted, false);
	assert.deepEqual(result.local, [{ id: "alpha", paths: ["src/worker.ts"] }]);

	const grep = await service.grep("alpha", "DurableWidget");
	assert.equal(grep.matches.length, 1);
	assert.equal(grep.matches[0]?.path, "src/worker.ts");
	assert.equal(grep.matches[0]?.line, 1);

	const pathResult = await service.search("special-path");
	assert.deepEqual(pathResult.local, [{ id: "alpha", paths: ["src/special-path.ts"] }]);

	const read = await service.read("alpha", "src/worker.ts", 1, 1);
	assert.match(read.text, /DurableWidget/);
	await assert.rejects(service.read("alpha", "../outside"), /stay within/);
	await assert.rejects(service.read("alpha", ".env"), /cannot be read/);
	await assert.rejects(service.read("alpha", ".env.local"), /cannot be read/);
	await assert.rejects(service.read("alpha", ".dev.vars.production"), /cannot be read/);
	await assert.rejects(service.read("alpha", ".git/config"), /cannot be read/);
	assert.deepEqual(await service.grep("alpha", "SECRET", "**/.*"), { matches: [], limited: false });
	assert.deepEqual(await service.files("alpha", "**/.*"), { paths: [], limited: false });
});

test("uses glab for the current GitLab origin", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "repo-codemode-"));
	const projectsRoot = join(base, "projects");
	const contextRoot = join(base, "context");
	await mkdir(projectsRoot);
	await mkdir(contextRoot);
	t.after(() => rm(base, { recursive: true, force: true }));
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner: CommandRunner = async (command, args) => {
		calls.push({ command, args });
		if (command === "git") {
			return commandResult("ssh://git@gitlab.example.test:2222/group/current.git\n");
		}
		if (command === "gh") {
			return commandResult("", 1);
		}
		if (command === "glab" && args[0] === "repo" && args[1] === "view") {
			return commandResult(JSON.stringify({ web_url: "https://gitlab.example.test/group/current" }));
		}
		if (command === "glab" && args[0] === "repo" && args[1] === "search") {
			return commandResult(JSON.stringify([{ web_url: "https://gitlab.example.test/group/name-match" }]));
		}
		if (command === "glab" && args[1] === "search") {
			return commandResult(JSON.stringify([{ project_id: 7, path: "src/runtime.ts" }]));
		}
		if (command === "glab" && args[1] === "projects/7") {
			return commandResult(JSON.stringify({ web_url: "https://gitlab.example.test/group/code-match" }));
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};
	const result = await new RepoService({ projectsRoot, contextRoot, runner }).search("runtime");

	assert.equal(result.remoteForge, "gitlab");
	assert.equal(result.remoteHost, "gitlab.example.test");
	assert.deepEqual(result.remote, [
		{ project: "https://gitlab.example.test/group/code-match", paths: ["src/runtime.ts"] },
		{ project: "https://gitlab.example.test/group/name-match", paths: [] },
	]);
	assert.ok(calls.some((call) => call.command === "glab" && call.args.includes("gitlab.example.test")));
	assert.ok(calls.some((call) => call.command === "glab" && call.args.includes("https://gitlab.example.test/group/current")));
});

test("uses gh for the current GitHub origin", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "repo-codemode-"));
	const projectsRoot = join(base, "projects");
	const contextRoot = join(base, "context");
	await mkdir(projectsRoot);
	await mkdir(contextRoot);
	t.after(() => rm(base, { recursive: true, force: true }));
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner: CommandRunner = async (command, args) => {
		calls.push({ command, args });
		if (command === "git") {
			return commandResult("git@github.example.test:owner/current.git\n");
		}
		if (command === "glab") {
			return commandResult("", 1);
		}
		if (command === "gh" && args[0] === "repo") {
			return commandResult(JSON.stringify({ url: "https://github.example.test/owner/current" }));
		}
		if (command === "gh" && args[1] === "repos") {
			return commandResult(JSON.stringify([{ fullName: "owner/name-match", url: "https://github.example.test/owner/name-match" }]));
		}
		if (command === "gh" && args[1] === "code") {
			return commandResult(JSON.stringify([
				{ path: "src/runtime.ts", repository: { url: "https://github.example.test/owner/code-match" } },
			]));
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};
	const result = await new RepoService({ projectsRoot, contextRoot, runner }).search("runtime");

	assert.equal(result.remoteForge, "github");
	assert.equal(result.remoteHost, "github.example.test");
	assert.deepEqual(result.remote, [
		{ project: "https://github.example.test/owner/code-match", paths: ["src/runtime.ts"] },
		{ project: "https://github.example.test/owner/name-match", paths: [] },
	]);
	assert.equal(calls.filter((call) => call.command === "gh" && call.args[0] === "search").length, 2);
	assert.ok(calls.some((call) => call.command === "gh" && call.args.includes("https://github.example.test/owner/current")));
});

test("clone requires a repository returned by remote search", async () => {
	const root = await mkdtemp(join(tmpdir(), "repo-codemode-"));
	try {
		const service = new RepoService({ projectsRoot: root, runner: runCommand });
		await assert.rejects(service.clone("https://github.com/group/project", new Set()), /prior remote search/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("repo info redacts credentials from origin URLs", async () => {
	const root = await mkdtemp(join(tmpdir(), "repo-codemode-"));
	const repo = join(root, "secure");
	try {
		await mkdir(repo);
		assert.equal((await runCommand("git", ["init", repo])).code, 0);
		assert.equal(
			(await runCommand("git", ["-C", repo, "remote", "add", "origin", "https://user:secret@gitlab.example.test/group/secure.git"])).code,
			0,
		);
		const info = await new RepoService({ projectsRoot: root, runner: runCommand }).info("secure");
		assert.equal(info.origin, "gitlab.example.test/group/secure");
		assert.doesNotMatch(JSON.stringify(info), /secret|user:/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("read pagination stops on complete lines at the byte limit", async () => {
	const { root, repo } = await fixture();
	try {
		const longLines = Array.from({ length: 100 }, (_, index) => `${index + 1}:${"é".repeat(500)}`);
		await writeFile(join(repo, "src", "large.txt"), longLines.join("\n"));
		const result = await new RepoService({ projectsRoot: root, runner: runCommand }).read("alpha", "src/large.txt", 1, 100);
		const emitted = result.text.split("\n");
		assert.ok(emitted.length < 100);
		assert.equal(result.end, emitted.length);
		assert.equal(result.nextLine, emitted.length + 1);
		assert.ok(Buffer.byteLength(result.text) <= 64 * 1024);
		assert.match(emitted.at(-1) ?? "", /^\d+:é+$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("clone uses the current forge and verifies the resulting origin", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "repo-codemode-"));
	const projectsRoot = join(base, "projects");
	const contextRoot = join(base, "context");
	await mkdir(projectsRoot);
	await mkdir(contextRoot);
	t.after(() => rm(base, { recursive: true, force: true }));
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner: CommandRunner = async (command, args) => {
		calls.push({ command, args });
		if (command === "git" && args.includes("remote")) {
			return commandResult("git@github.example.test:owner/current.git\n");
		}
		if (command === "git") {
			return commandResult("git@github.example.test:owner/project.git\n");
		}
		if (command === "glab") {
			return commandResult("", 1);
		}
		if (command === "gh" && args[0] === "repo" && args[1] === "view") {
			return commandResult(JSON.stringify({ url: "https://github.example.test/owner/current" }));
		}
		if (command === "gh" && args[0] === "repo" && args[1] === "clone") {
			await mkdir(join(args[3]!, ".git"));
			return commandResult();
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};
	const project = "https://github.example.test/owner/project";
	const service = new RepoService({ projectsRoot, contextRoot, runner });
	const result = await service.clone(project, new Set([project]));

	assert.equal(result.cloned, true);
	const cloneCall = calls.find((call) => call.command === "gh" && call.args[1] === "clone");
	assert.equal(cloneCall?.args[2], project);
	await assert.rejects(
		service.clone("https://other.example.test/owner/project", new Set(["https://other.example.test/owner/project"])),
		/current repository's remote host/,
	);
});

test("removes a clone whose resulting origin fails verification", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "repo-codemode-"));
	const projectsRoot = join(base, "projects");
	const contextRoot = join(base, "context");
	await mkdir(projectsRoot);
	await mkdir(contextRoot);
	t.after(() => rm(base, { recursive: true, force: true }));
	const runner: CommandRunner = async (command, args) => {
		if (command === "git" && args.includes("remote")) {
			return commandResult("git@github.example.test:owner/current.git\n");
		}
		if (command === "git") {
			return commandResult("git@github.example.test:attacker/project.git\n");
		}
		if (command === "glab") {
			return commandResult("", 1);
		}
		if (command === "gh" && args[1] === "view") {
			return commandResult(JSON.stringify({ url: "https://github.example.test/owner/current" }));
		}
		if (command === "gh" && args[1] === "clone") {
			await mkdir(join(args[3]!, ".git"));
			return commandResult();
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};
	const project = "https://github.example.test/owner/project";
	const service = new RepoService({ projectsRoot, contextRoot, runner });

	await assert.rejects(service.clone(project, new Set([project])), /does not match/);
	assert.deepEqual(await service.list(), []);
});
