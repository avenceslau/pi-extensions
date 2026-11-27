import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../shared/config.ts";

const REX_SESSION_LABEL = "bugs";
const WINDOW_LABEL_MAX_LENGTH = 40;
const REX_TIMEOUT_MS = 10_000;

type RexSessionList = {
  sessions?: { session_id?: string; label?: string }[];
};

type RexWindow = { window_id?: string };

type RexCreatedSession = {
  session_id?: string;
  initial_windows?: RexWindow[];
};

type BugFixWindow = {
  sessionId: string;
  windowId: string;
  createdSession: boolean;
};

const BUG_FIX_INSTRUCTIONS = [
  "Another Pi session found this bug while working on an unrelated task and started this session to fix it.",
  "The working directory may be that task's checkout: do not commit to its branch or leave changes in it.",
  "Make the fix on a new branch in its own worktree off a freshly fetched trunk, add a test that fails without the fix, and report what you changed.",
].join(" ");

function bugFixPrompt(
  description: string,
  cwd: string,
  reporterSession: string | undefined,
): string {
  const lines = [BUG_FIX_INSTRUCTIONS, "", `Repository: ${cwd}`];

  if (reporterSession) {
    lines.push(`Reported from session: ${reporterSession}`);
  }

  lines.push("", "Bug report:", description);

  return lines.join("\n");
}

function parseJson<T>(output: string, what: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`Rex returned invalid JSON for ${what}`);
  }
}

export default function (pi: ExtensionAPI) {
  // Concurrent calls in one session would each see no bugs session and create two.
  let rexQueue: Promise<unknown> = Promise.resolve();

  async function rex(args: string[], what: string): Promise<string> {
    const result = await pi.exec("rex", args, { timeout: REX_TIMEOUT_MS });

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Could not ${what} in Rex`);
    }

    return result.stdout;
  }

  async function findBugsSession(): Promise<string | undefined> {
    const list = parseJson<RexSessionList>(
      await rex(["ls", "--json"], "list sessions"),
      "the session list",
    );

    return list.sessions?.find((session) => session.label === REX_SESSION_LABEL)
      ?.session_id;
  }

  async function openBugFixWindow(
    label: string,
    cwd: string,
    command: string[],
  ): Promise<BugFixWindow> {
    const sessionId = await findBugsSession();

    if (sessionId) {
      const window = parseJson<RexWindow>(
        await rex(
          [
            "window",
            "new",
            "--session",
            sessionId,
            label,
            "--focus=false",
            "--cwd",
            cwd,
            "--json",
            "--",
            ...command,
          ],
          "create the bug-fix tab",
        ),
        "the new tab",
      );

      if (!window.window_id) {
        throw new Error("Rex did not return the new bug-fix tab");
      }

      return {
        sessionId,
        windowId: window.window_id,
        createdSession: false,
      };
    }

    const created = parseJson<RexCreatedSession>(
      await rex(
        [
          "new",
          REX_SESSION_LABEL,
          "--window",
          label,
          "--cwd",
          cwd,
          "--json",
          "--",
          ...command,
        ],
        `create the ${REX_SESSION_LABEL} session`,
      ),
      "the new session",
    );
    const windowId = created.initial_windows?.[0]?.window_id;

    if (!created.session_id || !windowId) {
      throw new Error(
        `Rex did not return the new ${REX_SESSION_LABEL} session`,
      );
    }

    return {
      sessionId: created.session_id,
      windowId,
      createdSession: true,
    };
  }

  async function resolveCwd(
    requested: string | undefined,
    context: ExtensionContext,
  ): Promise<string> {
    if (!requested) {
      return context.cwd;
    }

    const cwd = resolve(context.cwd, requested.replace(/^@/, ""));
    const info = await stat(cwd).catch(() => undefined);

    if (!info?.isDirectory()) {
      throw new Error(`${cwd} is not a directory`);
    }

    return cwd;
  }

  pi.registerTool({
    name: "start_bug_fix",
    label: "Start Bug Fix",
    description: `Start a separate Pi session that tries to fix a bug unrelated to the current task. It runs in its own tab of the Rex session "${REX_SESSION_LABEL}", which is created when missing. The new session sees only the description, so make it self-contained.`,
    promptSnippet:
      "Hand a bug unrelated to the current task to a new Pi session",
    promptGuidelines: [
      "Use start_bug_fix when you find a bug unrelated to the current task, instead of fixing it in this session or ignoring it; then continue the current task.",
      "In the start_bug_fix description, include the affected files and symbols, how to reproduce the bug, the expected and actual behavior, and any suspected cause.",
    ],
    parameters: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Short summary of the bug, used as the tab name",
      }),
      description: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description:
          "Self-contained bug report: affected files and symbols, reproduction steps, expected versus actual behavior, suspected cause",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Repository directory the bug lives in; defaults to the current working directory",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      if (params.title.includes("\0") || params.description.includes("\0")) {
        throw new Error("Bug reports cannot contain null bytes");
      }

      const cwd = await resolveCwd(params.cwd, context);
      const title = params.title.replace(/\s+/g, " ").trim();
      const model =
        loadConfig(pi).models?.extensions?.["bug-fix"] ??
        (context.model && `${context.model.provider}/${context.model.id}`);
      const command = [
        "pi",
        "--name",
        `Bug: ${title}`,
        ...(model ? ["--model", model] : []),
        "--thinking",
        String(pi.getThinkingLevel()),
        bugFixPrompt(
          params.description,
          cwd,
          context.sessionManager.getSessionFile(),
        ),
      ];

      const opened = rexQueue.then(() =>
        openBugFixWindow(title.slice(0, WINDOW_LABEL_MAX_LENGTH), cwd, command),
      );
      rexQueue = opened.catch(() => undefined);
      const window = await opened;

      const where = window.createdSession
        ? `a new Rex session "${REX_SESSION_LABEL}"`
        : `the Rex session "${REX_SESSION_LABEL}"`;
      context.ui.notify(`Started bug fix "${title}" in ${where}`, "info");

      return {
        content: [
          {
            type: "text",
            text: `Started a Pi session to fix "${title}" in ${where} (${window.windowId}). Continue with the current task.`,
          },
        ],
        details: window,
      };
    },
  });
}
