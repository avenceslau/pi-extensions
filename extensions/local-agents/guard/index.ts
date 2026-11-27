import {
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { shellQuote } from "../../shared/shell.ts";
import { expandHome, isInside, realPathOrSelf } from "../paths.ts";
import { slug } from "../text.ts";
import { checkCommand } from "./commands.ts";
import { sandboxProfile } from "./sandbox.ts";
import {
  parseRunPolicy,
  POLICY_VARIABLE,
  type RunPolicy,
  type RunStatus,
} from "./policy.ts";

// Loaded only into local agent sessions, with -e; without LOCAL_AGENT_POLICY it does nothing.

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

// Resolves symlinks in the longest existing prefix, so a new file under a symlinked directory is checked where it
// would really be written.
function realPathOfNewOrExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);

    return parent === path
      ? path
      : join(realPathOfNewOrExisting(parent), path.slice(parent.length + 1));
  }
}

// The file tools expand a leading `~` and drop a leading `@`, so the check does too before resolving symlinks.
export function toolPathIsInside(
  worktree: string,
  cwd: string,
  path: string,
): boolean {
  const target = realPathOfNewOrExisting(
    resolve(cwd, expandHome(path.replace(/^@/, ""))),
  );

  return isInside(worktree, target);
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    details: {},
  };
}

type ForgeCommand = [program: string, args: string[]];

function forgeCommands(repository: RunPolicy["repository"]) {
  const githubRepository = `${repository.host}/${repository.project}`;

  if (repository.forge === "gitlab") {
    return {
      createReview: (
        branch: string,
        targetBranch: string,
        title: string,
        description: string,
      ): ForgeCommand => [
        "glab",
        [
          "mr",
          "create",
          "--repo",
          repository.url,
          "--source-branch",
          branch,
          "--target-branch",
          targetBranch,
          "--title",
          title,
          "--description",
          description,
          "--yes",
        ],
      ],
      comment: (number: number, body: string): ForgeCommand => [
        "glab",
        [
          "mr",
          "note",
          String(number),
          "--repo",
          repository.url,
          "--message",
          body,
        ],
      ],
    };
  }

  return {
    createReview: (
      branch: string,
      targetBranch: string,
      title: string,
      description: string,
    ): ForgeCommand => [
      "gh",
      [
        "pr",
        "create",
        "--repo",
        githubRepository,
        "--head",
        branch,
        "--base",
        targetBranch,
        "--title",
        title,
        "--body",
        description,
      ],
    ],
    comment: (number: number, body: string): ForgeCommand => [
      "gh",
      [
        "pr",
        "comment",
        String(number),
        "--repo",
        githubRepository,
        "--body",
        body,
      ],
    ],
  };
}

export default function (pi: ExtensionAPI) {
  const policyPath = process.env[POLICY_VARIABLE];

  if (!policyPath) {
    return;
  }

  const policy = parseRunPolicy(readFileSync(policyPath, "utf8"));

  // A session that was meant to be restricted but cannot read its limits gets no tools at all.
  if (!policy) {
    pi.on("tool_call", () => ({
      block: true,
      reason: `${policyPath} is not a valid run policy, so every tool is blocked`,
    }));

    return;
  }

  const worktree = realPathOrSelf(policy.worktree);
  const forge = forgeCommands(policy.repository);
  const statusFile = policy.statusFile;
  let pushedSha = policy.push?.expectedSha;

  // Written to a temporary file and renamed, so a tick never reads a half-written status.
  function writeStatus(status: RunStatus): void {
    const temporaryFile = `${statusFile}.tmp`;

    writeFileSync(
      temporaryFile,
      JSON.stringify({
        pid: process.pid,
        status,
        updatedAt: new Date().toISOString(),
      }),
    );
    renameSync(temporaryFile, statusFile);
  }

  async function runInWorktree(command: string, args: string[]) {
    const output = await pi.exec(command, args, {
      cwd: worktree,
      timeout: 120_000,
    });

    if (output.code !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed: ${output.stderr.trim() || output.stdout.trim()}`,
      );
    }

    return output.stdout.trim();
  }

  async function confirmed(
    context: ExtensionContext,
    title: string,
    message: string,
  ): Promise<boolean> {
    return context.hasUI && (await context.ui.confirm(title, message));
  }

  pi.on("agent_start", () => writeStatus("working"));
  pi.on("ui_prompt_start", () => writeStatus("waiting"));
  pi.on("ui_prompt_end", () => writeStatus("working"));
  pi.on("agent_settled", () => writeStatus("idle"));
  pi.on("session_shutdown", () => rmSync(policy.statusFile, { force: true }));

  pi.on("tool_call", async (event, context) => {
    if (!policy.tools.includes(event.toolName)) {
      return {
        block: true,
        reason: `${event.toolName} is not available to this agent`,
      };
    }

    if (PATH_TOOLS.has(event.toolName)) {
      const path =
        "path" in event.input && typeof event.input.path === "string"
          ? event.input.path
          : ".";

      if (!toolPathIsInside(worktree, context.cwd, path)) {
        return {
          block: true,
          reason: `${path} is outside the worktree ${worktree}`,
        };
      }
    }

    if (isToolCallEventType("bash", event)) {
      const verdict = checkCommand(
        event.input.command,
        policy.bashCommandPatterns,
        worktree,
        realPathOrSelf(context.cwd),
      );

      if (!verdict.allowed) {
        return {
          block: true,
          reason: verdict.reason,
        };
      }

      event.input.command = [
        "/usr/bin/sandbox-exec",
        "-p",
        shellQuote(sandboxProfile(policy)),
        "/bin/sh",
        "-c",
        shellQuote(event.input.command),
      ].join(" ");
    }

    return undefined;
  });

  if (policy.push) {
    const { branch, askFirst } = policy.push;

    pi.registerTool({
      name: "push_branch",
      label: "Push branch",
      description: `Force-push HEAD to ${branch}, only if the remote branch is still at the commit this task started from or the one this tool last pushed.`,
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, context) {
        const head = await runInWorktree("git", ["rev-parse", "HEAD"]);

        if (
          askFirst &&
          !(await confirmed(
            context,
            "Push?",
            `Force-push ${head} to ${branch}`,
          ))
        ) {
          return textResult("The user declined the push.");
        }

        await runInWorktree("git", [
          "push",
          `--force-with-lease=refs/heads/${branch}:${pushedSha}`,
          "origin",
          `HEAD:refs/heads/${branch}`,
        ]);
        pushedSha = head;

        return textResult(`Pushed ${head} to ${branch}.`);
      },
    });
  }

  if (policy.mergeRequest) {
    const { targetBranch } = policy.mergeRequest;

    pi.registerTool({
      name: "open_merge_request",
      label: "Open merge request",
      description: `Push HEAD to a new branch and open a merge or pull request into ${targetBranch}. The user sees the title and description and must confirm.`,
      parameters: Type.Object({
        title: Type.String(),
        description: Type.String(),
      }),
      async execute(_id, params, _signal, _update, context) {
        const branch = `${policy.agent}/${slug(params.title)}`;

        if (
          !(await confirmed(
            context,
            `Open a review: ${params.title}`,
            `${branch} -> ${targetBranch}\n\n${params.description}`,
          ))
        ) {
          return textResult(
            "The user declined to open the review. Ask them what to change.",
          );
        }

        await runInWorktree("git", [
          "push",
          "origin",
          `HEAD:refs/heads/${branch}`,
        ]);

        const created = await runInWorktree(
          ...forge.createReview(
            branch,
            targetBranch,
            params.title,
            params.description,
          ),
        );

        return textResult(created);
      },
    });
  }

  if (policy.comment && policy.review) {
    const { number, url } = policy.review;

    pi.registerTool({
      name: "post_comment",
      label: "Post comment",
      description: `Comment on ${url}. The user sees the comment and must confirm.`,
      parameters: Type.Object({
        body: Type.String(),
      }),
      async execute(_id, params, _signal, _update, context) {
        if (!(await confirmed(context, `Comment on ${url}?`, params.body))) {
          return textResult(
            "The user declined the comment. Ask them what to change.",
          );
        }

        await runInWorktree(...forge.comment(number, params.body));

        return textResult("Posted the comment.");
      },
    });
  }
}
