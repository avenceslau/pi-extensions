import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../shared/config.ts";
import { runProgram } from "../shared/exec.ts";
import { createSession, findSession, openTab } from "../shared/rex.ts";
import { prepareWorktree, removeWorktree } from "../shared/worktree.ts";

const REX_SESSION_LABEL = "bugs";
const WINDOW_LABEL_MAX_CHARACTERS = 40;
const BRANCH_SLUG_MAX_CHARACTERS = 40;
// Two bugs with the same title still get separate branches, so a reused worktree is never reset over earlier work.
const BRANCH_SUFFIX_CHARACTERS = 6;

type BugFixWindow = {
  sessionId: string;
  windowId: string;
  createdSession: boolean;
};

const BUG_FIX_INSTRUCTIONS = [
  "Another Pi session found this bug while working on an unrelated task and started this session to fix it.",
  "Add a test that fails without the fix, fix the bug, and report what you changed.",
].join(" ");

function bugFixPrompt(
  description: string,
  branch: string,
  reporterCwd: string,
  reporterSession: string | undefined,
): string {
  const lines = [
    BUG_FIX_INSTRUCTIONS,
    "",
    `You are in a new worktree on branch ${branch}, started at origin's default branch.`,
    `Reported from: ${reporterCwd}`,
  ];

  if (reporterSession) {
    lines.push(`Reporter's session: ${reporterSession}`);
  }

  lines.push("", "Bug report:", description);

  return lines.join("\n");
}

function bugBranch(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, BRANCH_SLUG_MAX_CHARACTERS)
    .replace(/^-+|-+$/g, "");
  const suffix = randomUUID().slice(0, BRANCH_SUFFIX_CHARACTERS);

  return slug ? `bug/${slug}-${suffix}` : `bug/${suffix}`;
}

async function openBugFixWindow(
  label: string,
  cwd: string,
  command: string[],
): Promise<BugFixWindow> {
  const sessionId = await findSession(REX_SESSION_LABEL);

  if (sessionId) {
    return {
      sessionId,
      windowId: await openTab(sessionId, label, cwd, command),
      createdSession: false,
    };
  }

  const created = await createSession(REX_SESSION_LABEL, label, cwd, command);

  return {
    ...created,
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

export default function (pi: ExtensionAPI) {
  // Concurrent calls in one session would each see no bugs session and create two.
  let rexQueue: Promise<unknown> = Promise.resolve();

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
      const branch = bugBranch(title);

      const repositoryPath = await runProgram(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd },
      );
      const worktree = await prepareWorktree(repositoryPath, {
        branch,
        fetch: [],
        start: "origin/HEAD",
      });

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
          branch,
          cwd,
          context.sessionManager.getSessionFile(),
        ),
      ];

      const opened = rexQueue.then(() =>
        openBugFixWindow(
          title.slice(0, WINDOW_LABEL_MAX_CHARACTERS),
          worktree.path,
          command,
        ),
      );
      // The caller gets the failure from `opened`; the queue only needs to stay usable.
      rexQueue = opened.catch(() => undefined);
      const window = await opened.catch(async (error: unknown) => {
        await removeWorktree(repositoryPath, worktree.path, branch);
        throw error;
      });

      const where = window.createdSession
        ? `a new Rex session "${REX_SESSION_LABEL}"`
        : `the Rex session "${REX_SESSION_LABEL}"`;
      context.ui.notify(`Started bug fix "${title}" in ${where}`, "info");

      return {
        content: [
          {
            type: "text",
            text: `Started a Pi session to fix "${title}" on branch ${branch} in ${where}. Continue with the current task.`,
          },
        ],
        details: {
          ...window,
          branch,
          worktree: worktree.path,
        },
      };
    },
  });
}
