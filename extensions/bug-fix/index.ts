import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { loadConfig } from "../shared/config.ts";

const REX_SESSION_LABEL = "bugs";
const WINDOW_LABEL_MAX_CHARACTERS = 40;
const REX_TIMEOUT_MS = 10_000;

const RexSessionListSchema = Type.Object({
  sessions: Type.Array(
    Type.Object({
      session_id: Type.String(),
      label: Type.Optional(Type.String()),
    }),
  ),
});

const RexWindowSchema = Type.Object({
  window_id: Type.String(),
});

const RexCreatedSessionSchema = Type.Object({
  session_id: Type.String(),
  initial_windows: Type.Array(RexWindowSchema, { minItems: 1 }),
});

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

export default function (pi: ExtensionAPI) {
  // Concurrent calls in one session would each see no bugs session and create two.
  let rexQueue: Promise<unknown> = Promise.resolve();

  async function runRexJson<Schema extends TSchema>(
    args: string[],
    schema: Schema,
    what: string,
  ): Promise<Static<Schema>> {
    const completed = await pi.exec("rex", args, { timeout: REX_TIMEOUT_MS });

    if (completed.code !== 0) {
      throw new Error(completed.stderr.trim() || `Could not ${what} in Rex`);
    }

    let output: unknown;

    try {
      output = JSON.parse(completed.stdout);
    } catch {
      throw new Error(`Rex returned invalid JSON when asked to ${what}`);
    }

    if (!Value.Check(schema, output)) {
      throw new Error(
        `Rex returned an unexpected response when asked to ${what}`,
      );
    }

    return output;
  }

  async function openBugFixWindow(
    label: string,
    cwd: string,
    command: string[],
  ): Promise<BugFixWindow> {
    const launchArgs = ["--cwd", cwd, "--json", "--", ...command];
    const sessionList = await runRexJson(
      ["ls", "--json"],
      RexSessionListSchema,
      "list sessions",
    );
    const sessionId = sessionList.sessions.find(
      (session) => session.label === REX_SESSION_LABEL,
    )?.session_id;

    if (sessionId) {
      const window = await runRexJson(
        [
          "window",
          "new",
          "--session",
          sessionId,
          label,
          "--focus=false",
          ...launchArgs,
        ],
        RexWindowSchema,
        "create the bug-fix tab",
      );

      return {
        sessionId,
        windowId: window.window_id,
        createdSession: false,
      };
    }

    const created = await runRexJson(
      ["new", REX_SESSION_LABEL, "--window", label, ...launchArgs],
      RexCreatedSessionSchema,
      `create the ${REX_SESSION_LABEL} session`,
    );

    return {
      sessionId: created.session_id,
      windowId: created.initial_windows[0].window_id,
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
    const cwdStats = await stat(cwd).catch((error: Error) => {
      throw new Error(
        `Cannot use ${cwd} as the bug's repository: ${error.message}`,
      );
    });

    if (!cwdStats.isDirectory()) {
      throw new Error(`${cwd} is not a directory`);
    }

    return cwd;
  }

  pi.registerTool({
    name: "start_bug_fix",
    label: "Start Bug Fix",
    description:
      "Start a separate Pi session to fix a bug unrelated to the current task. That session sees only `description`.",
    promptGuidelines: [
      "Use start_bug_fix for bugs unrelated to the current task instead of fixing or ignoring them, then continue the task.",
    ],
    parameters: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Short bug summary",
      }),
      description: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description:
          "Self-contained bug report: files and symbols, repro steps, expected vs actual, suspected cause",
      }),
      cwd: Type.Optional(
        Type.String({
          description: "Bug's repository; defaults to the current directory",
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
        openBugFixWindow(
          title.slice(0, WINDOW_LABEL_MAX_CHARACTERS),
          cwd,
          command,
        ),
      );
      // The caller gets the failure from `opened`; the queue only needs to stay usable.
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
