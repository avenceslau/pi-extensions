import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./shared/config.ts";

interface SessionFocus {
	feature?: string;
	task?: string;
}

const ENTRY_TYPE = "session-focus";
const SUBCOMMANDS = ["feature", "task", "clear"];

const MAX_MESSAGE_CHARACTERS = 4000;
const LABEL_TIMEOUT_MS = 30_000;

const SET_FOCUS_TOOL: Tool = {
	name: "set_focus",
	description: "Set the label shown under the user's prompt as 'Working on <feature> | Doing <task>'.",
	parameters: Type.Object({
		feature: Type.String({ description: "The overall feature or goal of the session, 2 to 6 words" }),
		task: Type.String({ description: "What the agent is about to do for the newest message, 2 to 6 words" }),
	}),
};

const LABEL_SYSTEM_PROMPT = [
	"You label a coding agent session for a status line shown under the user's prompt.",
	`You receive the current label and the user's newest message to the agent. Always answer by calling ${SET_FOCUS_TOOL.name}.`,
	"feature: the overall feature or goal of the session. Keep the current feature unless the message clearly starts a different one.",
	"task: what the agent is about to do for this message, starting with a verb ending in -ing, such as 'Writing unit tests'.",
	`If the message adds nothing new, such as 'yes' or 'continue', call ${SET_FOCUS_TOOL.name} with the current values.`,
].join("\n");

function describe(focus: SessionFocus): string {
	const parts: string[] = [];
	if (focus.feature) {
		parts.push(`Working on ${focus.feature}`);
	}

	if (focus.task) {
		parts.push(`Doing ${focus.task}`);
	}

	return parts.join(" | ") || "no focus set";
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isSessionFocus(value: unknown): value is SessionFocus {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const fields: { feature?: unknown; task?: unknown } = value;
	return isOptionalString(fields.feature) && isOptionalString(fields.task);
}

async function requestLabel(
	ctx: ExtensionContext,
	model: Model<Api>,
	currentFocus: SessionFocus,
	message: string,
	signal: AbortSignal,
): Promise<SessionFocus | undefined> {
	const prompt = [
		`Current label: ${describe(currentFocus)}`,
		"",
		"Newest user message:",
		message.slice(0, MAX_MESSAGE_CHARACTERS),
	].join("\n");

	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: LABEL_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
			tools: [SET_FOCUS_TOOL],
		},
		{ signal },
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "labeling failed");
	}

	const call = response.content.find((part) => part.type === "toolCall" && part.name === SET_FOCUS_TOOL.name);
	if (call?.type !== "toolCall" || !isSessionFocus(call.arguments)) {
		return undefined;
	}

	return call.arguments;
}

export default function (pi: ExtensionAPI) {
	let focus: SessionFocus = {};
	// Looked up on the first message of each session; null when no model is configured or it is unavailable.
	let labelModel: Model<Api> | null | undefined;
	let labelRequest: AbortController | undefined;

	const showWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}

		const shownFocus = focus;
		if (!shownFocus.feature && !shownFocus.task) {
			ctx.ui.setWidget(ENTRY_TYPE, undefined);
			return;
		}

		ctx.ui.setWidget(
			ENTRY_TYPE,
			(_tui, theme) => ({
				render(width: number) {
					return [truncateToWidth(theme.fg("accent", describe(shownFocus)), width)];
				},
				invalidate() {},
			}),
			{ placement: "belowEditor" },
		);
	};

	const updateFocus = (ctx: ExtensionContext, change: SessionFocus): SessionFocus => {
		focus = {
			feature: (change.feature ?? focus.feature)?.trim(),
			task: (change.task ?? focus.task)?.trim(),
		};
		showWidget(ctx);
		return focus;
	};

	const restoreFocus = (ctx: ExtensionContext) => {
		focus = {};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) {
				continue;
			}

			if (isSessionFocus(entry.data)) {
				focus = entry.data;
			}
		}

		showWidget(ctx);
	};

	const labelFromMessage = async (ctx: ExtensionContext, model: Model<Api>, message: string) => {
		labelRequest?.abort();
		const request = new AbortController();
		labelRequest = request;

		let label: SessionFocus | undefined;
		try {
			label = await requestLabel(
				ctx,
				model,
				focus,
				message,
				AbortSignal.any([request.signal, AbortSignal.timeout(LABEL_TIMEOUT_MS)]),
			);
		} catch (error) {
			if (!request.signal.aborted) {
				ctx.ui.notify(`session-focus: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			return;
		}

		if (request.signal.aborted || !label) {
			return;
		}

		pi.appendEntry(ENTRY_TYPE, updateFocus(ctx, label));
	};

	// Without a configured model, the label only changes through /focus, so no message goes to the session's model.
	const findLabelModel = (ctx: ExtensionContext): Model<Api> | null => {
		const modelRef = loadConfig(pi).models?.extensions?.["session-focus"];
		const separator = modelRef?.indexOf("/") ?? -1;
		if (!modelRef || separator <= 0) {
			return null;
		}

		const model = ctx.modelRegistry.find(modelRef.slice(0, separator), modelRef.slice(separator + 1));
		if (!model) {
			ctx.ui.notify(`session-focus: ${modelRef} is not available`, "warning");
		}
		return model ?? null;
	};

	pi.on("session_start", async (_event, ctx) => {
		labelModel = undefined;
		restoreFocus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		labelRequest?.abort();
		restoreFocus(ctx);
	});
	pi.on("session_shutdown", async () => labelRequest?.abort());

	// Labeling runs in the background so the user's message is not held up waiting for the side model.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			return;
		}

		labelModel ??= findLabelModel(ctx);
		if (labelModel) {
			void labelFromMessage(ctx, labelModel, event.text);
		}
	});

	pi.registerCommand("focus", {
		description: "Set what the session is about: /focus feature <text> | task <text> | clear",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const matchingSubcommands = SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
				value: name,
				label: name,
			}));
			return matchingSubcommands.length > 0 ? matchingSubcommands : null;
		},
		handler: async (args, ctx) => {
			const [, subcommand = "", text = ""] = args.trim().match(/^(\S*)\s*([\s\S]*)$/) ?? [];

			let change: SessionFocus;
			if (subcommand === "feature" || subcommand === "task") {
				change = { [subcommand]: text };
			} else if (subcommand === "clear") {
				change = { feature: "", task: "" };
			} else if (subcommand === "") {
				ctx.ui.notify(describe(focus), "info");
				return;
			} else {
				ctx.ui.notify("Usage: /focus feature <text> | task <text> | clear", "error");
				return;
			}

			labelRequest?.abort();
			pi.appendEntry(ENTRY_TYPE, updateFocus(ctx, change));
		},
	});
}
