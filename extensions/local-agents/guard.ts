import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ENV_FILE_READ_DENY_RULES,
  shellQuote,
} from "../protect-env-files/index.ts";
import { checkCommand, expandHome, isInside } from "./command-policy.ts";
import { slug } from "./text.ts";
import {
  POLICY_VARIABLE,
  type RunPolicy,
  type RunStatus,
} from "./run-policy.ts";

// Loaded explicitly into local agent sessions with -e; does nothing elsewhere. It enforces the run policy on every
// tool call, runs bash inside a macOS sandbox that only lets it write to the worktree and build caches, and adds the
// tools that act outside the worktree (push, open a review, comment), each limited by the policy.

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

const CACHE_DIRECTORIES = [
  ".cache",
  "Library/Caches",
  ".npm",
  ".local/share/pnpm",
  ".local/state/pnpm",
  "Library/pnpm",
  ".cargo/registry",
  ".cargo/git",
  ".rustup",
];

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

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

function sandboxString(value: string): string {
  return JSON.stringify(value);
}

export function sandboxProfile(policy: RunPolicy): string {
  const writable = [
    policy.worktree,
    policy.gitDirectory,
    "/dev",
    "/private/tmp",
    tmpdir(),
    ...CACHE_DIRECTORIES.map((directory) => join(homedir(), directory)),
  ].map(realPathOrSelf);

  const allowWrites = writable
    .map((path) => `(allow file-write* (subpath ${sandboxString(path)}))`)
    .join("");

  return `(version 1)(allow default)${ENV_FILE_READ_DENY_RULES}(deny file-write*)${allowWrites}`;
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

function readPolicy(): RunPolicy | undefined {
  const path = process.env[POLICY_VARIABLE];

  // SAFETY: the launcher writes this file from a RunPolicy.
  return path
    ? (JSON.parse(readFileSync(path, "utf8")) as RunPolicy)
    : undefined;
}

export default function (pi: ExtensionAPI) {
  const policy = readPolicy();

  if (!policy) {
    return;
  }

  const worktree = realPathOrSelf(policy.worktree);
  const repositoryUrl = policy.repository.url;
  const statusFile = policy.statusFile;
  let pushedSha = policy.push?.expectedSha;

  function writeStatus(status: RunStatus): void {
    writeFileSync(
      statusFile,
      JSON.stringify({
        pid: process.pid,
        status,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  async function run(command: string, args: string[]) {
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
        policy.commands,
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
        const head = await run("git", ["rev-parse", "HEAD"]);

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

        await run("git", [
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

        await run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);

        const created =
          policy.repository.forge === "gitlab"
            ? await run("glab", [
                "mr",
                "create",
                "--repo",
                repositoryUrl,
                "--source-branch",
                branch,
                "--target-branch",
                targetBranch,
                "--title",
                params.title,
                "--description",
                params.description,
                "--yes",
              ])
            : await run("gh", [
                "pr",
                "create",
                "--repo",
                `${policy.repository.host}/${policy.repository.project}`,
                "--head",
                branch,
                "--base",
                targetBranch,
                "--title",
                params.title,
                "--body",
                params.description,
              ]);

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

        await (policy.repository.forge === "gitlab"
          ? run("glab", [
              "mr",
              "note",
              String(number),
              "--repo",
              repositoryUrl,
              "--message",
              params.body,
            ])
          : run("gh", [
              "pr",
              "comment",
              String(number),
              "--repo",
              `${policy.repository.host}/${policy.repository.project}`,
              "--body",
              params.body,
            ]));

        return textResult("Posted the comment.");
      },
    });
  }
}
