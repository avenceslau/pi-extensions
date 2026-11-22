import assert from "node:assert/strict";
import test from "node:test";
import type { RepoService } from "../repo-service.ts";
import { executeRepoCode } from "../sandbox.ts";

function service() {
	return {
		list: async () => [{ id: "alpha" }],
		info: async (id: string) => ({ id, branch: "main", commit: "abc" }),
		search: async () => ({ local: [{ id: "alpha", paths: [] }], remote: [], remoteAttempted: false }),
		files: async () => ({ paths: ["src/index.ts"], limited: false }),
		grep: async () => ({ matches: [{ path: "src/index.ts", line: 1, text: "needle" }], limited: false }),
		read: async (_id: string, path: string) => ({ path, text: "contents", start: 1, end: 1, truncated: false }),
		clone: async (project: string) => ({ id: "clone", project, cloned: true, alreadyLocal: false }),
	} as unknown as RepoService;
}

test("executes async repository orchestration and returns only the final value", async () => {
	const result = await executeRepoCode(
		"const repos = await repo.list(); const hit = await repo.grep(repos[0].id, 'needle'); return { repo: repos[0].id, hit: hit.matches[0].path };",
		service(),
		new Set(),
	);

	assert.equal(result.text, '{"repo":"alpha","hit":"src/index.ts"}');
	assert.equal(result.details.calls, 2);
});

test("does not expose ambient Node, filesystem, network, or dynamic-code capabilities", async () => {
	const result = await executeRepoCode(
		"return { process: typeof process, require: typeof require, fetch: typeof fetch, deno: typeof Deno, bun: typeof Bun, eval: typeof eval, Function: typeof Function, constructor: String((() => {}).constructor) };",
		service(),
		new Set(),
	);

	assert.deepEqual(JSON.parse(result.text), {
		process: "undefined",
		require: "undefined",
		fetch: "undefined",
		deno: "undefined",
		bun: "undefined",
		eval: "undefined",
		Function: "undefined",
		constructor: "undefined",
	});
});

test("blocks module imports", async () => {
	await assert.rejects(
		executeRepoCode("return await import('node:fs');", service(), new Set()),
		/imports are disabled|module/i,
	);
});

test("terminates unbounded guest code on cancellation", async () => {
	const controller = new AbortController();
	const started = Date.now();
	setTimeout(() => controller.abort(), 100);
	await assert.rejects(
		executeRepoCode(
			"const iterator = { [Symbol.iterator]() { return this; }, next() { return { done: false, value: 1 }; } }; for (const value of iterator) {}",
			service(),
			new Set(),
			controller.signal,
		),
		/cancelled/,
	);
	assert.ok(Date.now() - started < 5000);
});

test("rejects circular results without crossing them into the host", async () => {
	await assert.rejects(
		executeRepoCode("const value = {}; value.self = value; return value;", service(), new Set()),
		/circular|cyclic/i,
	);
});

test("guest console calls do not serialize values into the host", async () => {
	const result = await executeRepoCode(
		"const value = {}; value.self = value; console.log(value); return 'ok';",
		service(),
		new Set(),
	);

	assert.equal(result.text, "ok");
	assert.equal("logs" in result.details, false);
});

test("validates API arguments inside the guest", async () => {
	await assert.rejects(
		executeRepoCode("const value = {}; value.self = value; return await repo.info(value);", service(), new Set()),
		/id must be a string/,
	);
});

test("serializes parallel guest calls before invoking host operations", async () => {
	let active = 0;
	let maxActive = 0;
	const mock = service() as unknown as { list: () => Promise<Array<{ id: string }>> };
	mock.list = async () => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active -= 1;

		return [{ id: "alpha" }];
	};

	const result = await executeRepoCode(
		"const values = await Promise.all(Array.from({ length: 8 }, () => repo.list())); return values.length;",
		mock as unknown as RepoService,
		new Set(),
	);

	assert.equal(result.text, "8");
	assert.equal(maxActive, 1);
});

test("persists only remote projects newly discovered by an execution", async () => {
	const mock = service() as unknown as {
		search: () => Promise<{ local: never[]; remote: Array<{ project: string; paths: never[] }>; remoteAttempted: boolean }>;
	};

	mock.search = async () => ({
		local: [],
		remote: [{ project: "https://github.example.test/group/new-project", paths: [] }],
		remoteAttempted: true,
	});

	const result = await executeRepoCode(
		"await repo.search('new-project', true); return 'done';",
		mock as unknown as RepoService,
		new Set(["https://github.example.test/group/already-known"]),
	);

	assert.deepEqual(result.details.remoteProjects, ["https://github.example.test/group/new-project"]);
});

test("truncates large results before they enter host context", async () => {
	const result = await executeRepoCode("return 'x'.repeat(100000);", service(), new Set());
	assert.equal(result.details.truncated, true);
	assert.ok(Buffer.byteLength(result.text) < 17 * 1024);
});

test("bounds guest-thrown error messages", async () => {
	let error: unknown;

	try {
		await executeRepoCode("throw new Error('x'.repeat(1000000));", service(), new Set());
	} catch (caught) {
		error = caught;
	}

	assert.ok(error instanceof Error);
	assert.ok(Buffer.byteLength(error.message) < 5000);
});

test("does not let unawaited repository operations outlive execution", async () => {
	let finished = false;
	const mock = service() as unknown as { list: () => Promise<Array<{ id: string }>> };
	mock.list = async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		finished = true;

		return [{ id: "alpha" }];
	};

	await assert.rejects(
		executeRepoCode("repo.list(); return 'early';", mock as unknown as RepoService, new Set()),
		/await every repo call/,
	);
	assert.equal(finished, true);
});
