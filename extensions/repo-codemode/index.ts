import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RepoService, type SearchResult } from "./repo-service.js";
import { executeRepoCode } from "./sandbox.js";

interface RepoToolDetails {
	remoteProjects?: string[];
}

function validProject(project: unknown): project is string {
	if (typeof project !== "string" || project.length > 1000 || !project.startsWith("https://")) {
		return false;
	}
	try {
		const url = new URL(project);
		return !url.username && !url.password && url.pathname.split("/").filter(Boolean).length >= 2;
	} catch {
		return false;
	}
}

function formatSearch(result: SearchResult) {
	const lines: string[] = [];
	if (result.local.length > 0) {
		lines.push("local:");
		for (const match of result.local) {
			lines.push(`- ${match.id}`);
			for (const path of match.paths) {
				lines.push(`  ${path}`);
			}
		}
	}
	if (result.remote.length > 0) {
		lines.push("remote:");
		for (const match of result.remote) {
			lines.push(`- ${match.project}`);
			for (const path of match.paths) {
				lines.push(`  ${path}`);
			}
		}
	}
	if (lines.length === 0) {
		if (!result.remoteAttempted) {
			return "No local repositories matched.";
		}
		if (!result.remoteHost || !result.remoteForge) {
			return "No local repositories matched, and the current repository has no supported GitHub or GitLab origin.";
		}
		return `No local or ${result.remoteForge} repositories on ${result.remoteHost} matched.`;
	}
	lines.push("[Limited to 15 repositories and 3 matching paths per repository]");
	return lines.join("\n");
}

export default function repoCodemodeExtension(pi: ExtensionAPI) {
	let service = new RepoService();
	let allowedProjects = new Set<string>();

	const addAllowedProjects = (projects: unknown) => {
		if (!Array.isArray(projects)) {
			return;
		}
		for (const project of projects) {
			if (allowedProjects.size >= 100) {
				return;
			}
			if (validProject(project)) {
				allowedProjects.add(project);
			}
		}
	};
	const restoreAllowedProjects = (ctx: ExtensionContext) => {
		allowedProjects = new Set();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") {
				continue;
			}
			if (entry.message.toolName !== "repo_search" && entry.message.toolName !== "repo_execute") {
				continue;
			}
			const details = entry.message.details as RepoToolDetails | undefined;
			addAllowedProjects(details?.remoteProjects);
		}
	};

	pi.registerTool({
		name: "repo_search",
		label: "Repository Search",
		description:
			"Find source repositories local-first under ~/projects. Falls back to the current repository's GitHub or GitLab origin when no local match exists; set remote=true to force both. Returns repository IDs and matching paths without source snippets.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 200, description: "Repository, service, symbol, path, or exact source term" }),
			remote: Type.Optional(Type.Boolean({ description: "Also search the current repository's remote forge when local matches exist" })),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await service.search(params.query, params.remote ?? false, signal);
			const remoteProjects = result.remote.map((match) => match.project);
			addAllowedProjects(remoteProjects);
			return {
				content: [{ type: "text", text: formatSearch(result) }],
				details: { remoteProjects },
			};
		},
	});

	pi.registerTool({
		name: "repo_execute",
		label: "Repository Code Mode",
		description:
			"Run an async JavaScript body in isolated QuickJS and return only its final value. API: repo.list(), info(id), search(query, remote?), files(id, glob?), grep(id, query, glob?), read(id, path, start?, lines?), clone(project, dest?). Remote search uses only the current repository's forge. Clone accepts only a repository URL returned by prior search and never overwrites a destination. Use return to emit a compact JSON value.",
		parameters: Type.Object({
			code: Type.String({ minLength: 1, maxLength: 20_480, description: "JavaScript statements for an async function body" }),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await executeRepoCode(params.code, service, allowedProjects, signal);
			addAllowedProjects(result.details.remoteProjects);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		service = new RepoService({ contextRoot: ctx.cwd });
		restoreAllowedProjects(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreAllowedProjects(ctx);
	});
}
