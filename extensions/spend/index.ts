import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const REPORT_TYPE = "pi-spend-report";
const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 3,
	maximumFractionDigits: 3,
});

interface SpendReportData {
	title: string;
	lines: string[];
	expandedLines?: string[];
	footer: string;
}

interface SpendEvent {
	cost: number;
	timestamp?: number;
}

interface SessionRecord {
	created: Date;
	eventKeys: Set<string>;
	fallbackCost: number;
	id: string;
	label: string;
	parentPath?: string;
	path: string;
}

interface SessionSpend {
	cost: number;
	created: Date;
	id: string;
	label: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<SpendReportData>(REPORT_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) {
			return new Text(theme.fg("error", "Spend report is unavailable"), 0, 0);
		}

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.bold(theme.fg("accent", data.title)), 0, 0));
		box.addChild(new Text((expanded ? data.expandedLines ?? data.lines : data.lines).join("\n"), 0, 0));
		box.addChild(new Text(theme.fg("dim", data.footer), 0, 0));
		return box;
	});

	pi.registerCommand("spend", {
		description: "Show estimated spend from saved Pi sessions",
		getArgumentCompletions: (prefix) => {
			const values = ["daily", "sessions"];
			const matches = values.filter((value) => value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode && mode !== "daily" && mode !== "sessions") {
				ctx.ui.notify("Usage: /spend [daily|sessions]", "warning");
				return;
			}

			ctx.ui.setStatus("pi-spend", "Reading session costs…");
			try {
				const activeSessionManager = ctx.sessionManager as SessionManager;
				const sessions = activeSessionManager.usesDefaultSessionDir()
					? await SessionManager.listAll()
					: await SessionManager.listAll(activeSessionManager.getSessionDir());
				const events = new Map<string, SpendEvent>();
				const sessionRecords: SessionRecord[] = [];
				let unreadableSessions = 0;
				let malformedLines = 0;
				let invalidUsageRecords = 0;

				for (const session of sessions) {
					let content: string;
					try {
						content = await readFile(session.path, "utf8");
					} catch {
						unreadableSessions += 1;
						continue;
					}

					const eventKeys = new Set<string>();
					let fallbackCost = 0;
					const sessionStart = session.created.getTime();
					for (const line of content.split("\n")) {
						if (!line) {
							continue;
						}

						let entry: any;
						try {
							entry = JSON.parse(line);
						} catch {
							malformedLines += 1;
							continue;
						}

						if (entry?.type !== "message" || entry.message?.role !== "assistant") {
							continue;
						}

						const rawCost = entry.message.usage?.cost?.total;
						const cost = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : 0;
						if (typeof rawCost !== "number" || !Number.isFinite(rawCost)) {
							invalidUsageRecords += 1;
						}

						const messageTimestamp = entry.message.timestamp;
						const entryTimestamp = Date.parse(entry.timestamp);
						const timestamp = typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)
							? messageTimestamp
							: Number.isFinite(entryTimestamp)
								? entryTimestamp
								: Number.isFinite(sessionStart)
									? sessionStart
									: undefined;

						if (!Number.isFinite(sessionStart) || timestamp === undefined || timestamp >= sessionStart) {
							fallbackCost += cost;
						}

						// Forks and clones preserve entry IDs and timestamps, so this key counts copied responses once.
						const identity = typeof entry.id === "string" ? entry.id : JSON.stringify(entry.message);
						const eventKey = `${identity}\u0000${entry.timestamp ?? entry.message.timestamp ?? ""}`;
						eventKeys.add(eventKey);
						if (!events.has(eventKey)) {
							events.set(eventKey, { cost, timestamp });
						}
					}

					const home = homedir();
					const cwd = session.cwd.startsWith(home) ? `~${session.cwd.slice(home.length)}` : session.cwd;
					sessionRecords.push({
						created: session.created,
						eventKeys,
						fallbackCost,
						id: session.id,
						label: session.name || cwd || "(unknown directory)",
						parentPath: session.parentSessionPath ? resolve(session.parentSessionPath) : undefined,
						path: resolve(session.path),
					});
				}

				const eventKeysBySession = new Map(sessionRecords.map((session) => [session.path, session.eventKeys]));
				let attributionFallbacks = 0;
				const sessionSpends: SessionSpend[] = sessionRecords.map((session) => {
					const parentKeys = session.parentPath ? eventKeysBySession.get(session.parentPath) : undefined;
					if (session.parentPath && !parentKeys) {
						attributionFallbacks += 1;
					}
					const cost = parentKeys
						? [...session.eventKeys].reduce((sum, key) => sum + (parentKeys.has(key) ? 0 : (events.get(key)?.cost ?? 0)), 0)
						: session.parentPath
							? session.fallbackCost
							: [...session.eventKeys].reduce((sum, key) => sum + (events.get(key)?.cost ?? 0), 0);
					return { cost, created: session.created, id: session.id, label: session.label };
				});

				const daily = new Map<string, number>();
				let total = 0;
				let earliest = Number.POSITIVE_INFINITY;
				let latest = Number.NEGATIVE_INFINITY;
				for (const event of events.values()) {
					total += event.cost;
					if (event.timestamp === undefined) {
						continue;
					}
					earliest = Math.min(earliest, event.timestamp);
					latest = Math.max(latest, event.timestamp);
					const date = new Date(event.timestamp);
					const day = [
						date.getFullYear(),
						String(date.getMonth() + 1).padStart(2, "0"),
						String(date.getDate()).padStart(2, "0"),
					].join("-");
					daily.set(day, (daily.get(day) ?? 0) + event.cost);
				}

				const footerParts = ["Estimated from saved token usage; provider billing is authoritative."];
				if (unreadableSessions > 0) {
					footerParts.push(`${unreadableSessions} unreadable session${unreadableSessions === 1 ? "" : "s"} skipped.`);
				}
				if (malformedLines > 0) {
					footerParts.push(`${malformedLines} malformed record${malformedLines === 1 ? "" : "s"} skipped.`);
				}
				if (invalidUsageRecords > 0) {
					footerParts.push(`${invalidUsageRecords} assistant record${invalidUsageRecords === 1 ? "" : "s"} had no valid cost.`);
				}
				if (attributionFallbacks > 0) {
					footerParts.push(`${attributionFallbacks} child session${attributionFallbacks === 1 ? "" : "s"} used timestamp-based attribution because its parent was unavailable.`);
				}

				let report: SpendReportData;
				if (mode === "daily") {
					const rows = [...daily.entries()]
						.filter(([, cost]) => cost > 0)
						.sort(([left], [right]) => right.localeCompare(left))
						.map(([day, cost]) => `${day}  ${money.format(cost).padStart(12)}`);
					const visibleRows = rows.slice(0, 14);
					if (rows.length > visibleRows.length) {
						visibleRows.push(`… ${rows.length - visibleRows.length} more day${rows.length - visibleRows.length === 1 ? "" : "s"} (expand to view)`);
					}
					const dailyRows = visibleRows.length > 0 ? visibleRows : ["No recorded daily spend."];
					const expandedDailyRows = rows.length > 0 ? rows : ["No recorded daily spend."];
					report = {
						title: "Pi Spend by Day",
						lines: [...dailyRows, "", `Total       ${money.format(total).padStart(12)}`],
						expandedLines: [...expandedDailyRows, "", `Total       ${money.format(total).padStart(12)}`],
						footer: footerParts.join(" "),
					};
				} else if (mode === "sessions") {
					const rows = sessionSpends
						.filter((session) => session.cost > 0)
						.sort((left, right) => right.cost - left.cost)
						.map((session) => {
							const day = Number.isFinite(session.created.getTime()) ? session.created.toISOString().slice(0, 10) : "unknown";
							return `${money.format(session.cost).padStart(12)}  ${day}  ${session.id.slice(0, 8)}  ${session.label}`;
						});
					const visibleRows = rows.slice(0, 15);
					if (rows.length > visibleRows.length) {
						visibleRows.push(`… ${rows.length - visibleRows.length} more session${rows.length - visibleRows.length === 1 ? "" : "s"} (expand to view)`);
					}
					report = {
						title: "Pi Spend by Session",
						lines: visibleRows.length > 0 ? visibleRows : ["No recorded session spend."],
						expandedLines: rows.length > 0 ? rows : ["No recorded session spend."],
						footer: `${footerParts.join(" ")} Copied fork/clone history is excluded from child sessions.`,
					};
				} else {
					const range = Number.isFinite(earliest) && Number.isFinite(latest)
						? `${new Date(earliest).toLocaleDateString()} – ${new Date(latest).toLocaleDateString()}`
						: "No recorded usage";
					report = {
						title: "Pi Spend",
						lines: [
							`Total:               ${money.format(total)}`,
							`Recorded responses:  ${events.size.toLocaleString()}`,
							`Saved sessions:      ${sessions.length.toLocaleString()}`,
							`Date range:          ${range}`,
							"",
							"Use /spend daily or /spend sessions for a breakdown.",
						],
						footer: `${footerParts.join(" ")} Fork/clone history is de-duplicated.`,
					};
				}

				pi.appendEntry<SpendReportData>(REPORT_TYPE, report);
			} catch (error) {
				ctx.ui.notify(`Unable to calculate spend: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus("pi-spend", undefined);
			}
		},
	});
}
