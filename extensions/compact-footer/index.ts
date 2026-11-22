import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const MIN_GAP_COLUMNS = 2;
const THOUSAND = 1000;
const MILLION = 1_000_000;
const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_ERROR_PERCENT = 90;

interface SessionStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
}

function formatTokens(count: number): string {
	if (count < THOUSAND) {
		return count.toString();
	}

	if (count < 10 * THOUSAND) {
		return `${(count / THOUSAND).toFixed(1)}k`;
	}

	if (count < MILLION) {
		return `${Math.round(count / THOUSAND)}k`;
	}

	if (count < 10 * MILLION) {
		return `${(count / MILLION).toFixed(1)}M`;
	}

	return `${Math.round(count / MILLION)}M`;
}

function sumSessionStats(ctx: ExtensionContext): SessionStats {
	const stats: SessionStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};

	const add = (usage: Usage) => {
		stats.input += usage.input;
		stats.output += usage.output;
		stats.cacheRead += usage.cacheRead;
		stats.cacheWrite += usage.cacheWrite;
		stats.cost += usage.cost.total;
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			add(entry.usage);
			continue;
		}

		const isSummary = entry.type === "branch_summary" || entry.type === "compaction";
		if (isSummary && entry.usage) {
			add(entry.usage);
			continue;
		}

		if (entry.type !== "message") {
			continue;
		}

		const message = entry.message;
		if (message.role === "toolResult" && message.usage) {
			add(message.usage);
		}

		if (message.role === "assistant") {
			add(message.usage);
			const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
			stats.latestCacheHitRate = promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
		}
	}

	return stats;
}

function formatStats(stats: SessionStats): string {
	const counts = [
		["↑", stats.input],
		["↓", stats.output],
		["R", stats.cacheRead],
		["W", stats.cacheWrite],
	] as const;

	const parts: string[] = [];
	for (const [prefix, count] of counts) {
		if (count) {
			parts.push(`${prefix}${formatTokens(count)}`);
		}
	}

	const hasCacheUsage = stats.cacheRead > 0 || stats.cacheWrite > 0;
	if (hasCacheUsage && stats.latestCacheHitRate !== undefined) {
		parts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
	}

	if (stats.cost) {
		parts.push(`$${stats.cost.toFixed(3)}`);
	}

	return parts.join(" ");
}

function formatContext(
	ctx: ExtensionContext,
	isAutoCompactEnabled: boolean,
	theme: Theme,
): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const suffix = `/${formatTokens(contextWindow)}${isAutoCompactEnabled ? " (auto)" : ""}`;
	const percent = contextUsage?.percent ?? null;
	if (percent === null) {
		return theme.fg("dim", `?${suffix}`);
	}

	const text = `${percent.toFixed(1)}%${suffix}`;
	if (percent > CONTEXT_ERROR_PERCENT) {
		return theme.fg("error", text);
	}

	if (percent > CONTEXT_WARNING_PERCENT) {
		return theme.fg("warning", text);
	}

	return theme.fg("dim", text);
}

function formatPwd(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): string {
	const home = homedir();
	const cwd = ctx.sessionManager.getCwd();
	const branch = footerData.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName();

	return [
		cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd,
		branch && `(${branch})`,
		sessionName && `• ${sessionName}`,
	]
		.filter(Boolean)
		.join(" ");
}

function formatModel(pi: ExtensionAPI, ctx: ExtensionContext, providerCount: number): string {
	const model = ctx.model;
	if (!model) {
		return "no-model";
	}

	let text = model.id;
	if (model.reasoning) {
		const thinkingLevel = pi.getThinkingLevel();
		text += thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
	}

	return providerCount > 1 ? `(${model.provider}) ${text}` : text;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		const isAutoCompactEnabled = pi.getSettings().compaction?.enabled ?? true;
		let cachedStats: { leafId: string | null; text: string } | undefined;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const ellipsis = theme.fg("dim", "...");

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const leafId = ctx.sessionManager.getLeafId();
					if (cachedStats?.leafId !== leafId) {
						cachedStats = {
							leafId,
							text: formatStats(sumSessionStats(ctx)),
						};
					}

					const usage = cachedStats.text ? `${cachedStats.text} ` : "";
					const left =
						theme.fg("dim", `${formatPwd(ctx, footerData)}  ${usage}`) +
						formatContext(ctx, isAutoCompactEnabled, theme);
					const leftWidth = visibleWidth(left);

					const right = formatModel(pi, ctx, footerData.getAvailableProviderCount());
					const rightWidth = Math.min(visibleWidth(right), width - leftWidth - MIN_GAP_COLUMNS);
					const firstLine =
						rightWidth > 0
							? left +
								" ".repeat(width - leftWidth - rightWidth) +
								theme.fg("dim", truncateToWidth(right, rightWidth, ""))
							: truncateToWidth(left, width, ellipsis);

					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/\s+/g, " ").trim());
					if (statuses.length === 0) {
						return [firstLine];
					}

					return [
						firstLine,
						truncateToWidth(statuses.join(" "), width, ellipsis),
					];
				},
			};
		});
	});
}
