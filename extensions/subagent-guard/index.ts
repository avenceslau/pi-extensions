import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { SUBAGENT_SESSION_NAME } from "../auto-retry/index.ts";
import { isForbiddenForSubagents, loadConfig } from "../shared/config.ts";

const READ_ONLY_AGENT_TYPES = new Set([
  "research",
  "Explore",
  "review",
  "code-restraint-review",
  "comment-review",
  "refactor-review",
  "Plan",
]);

// Writes tests, so it may edit files, but must leave git history and state alone.
const GIT_STATE_PRESERVING_AGENT_TYPE = "correctness-review";

// The post-change audit and /review-mr spawn these over pi-subagents' event bus, which the Agent tool_call never sees.
const REVIEW_AGENT_TYPES = new Set([
  "correctness-review",
  "review",
  "code-restraint-review",
  "refactor-review",
  "comment-review",
]);

const REVIEW_AGENT_REASON =
  "Reviews run only from the post-change audit, which already reviews your changes automatically, or from the user's /audit, /correctness, and /review-mr commands. Do not launch review or verification agents yourself.";

const DUPLICATE_PROMPT_WINDOW_MS = 10 * 60_000;

const COMMAND_START = String.raw`(?:^|[;&|(\n\`]|\$\()\s*(?:(?:sudo|command|nohup|time|xargs(?:\s+-\S+)*)\s+)*`;
const GIT = String.raw`git(?:\s+-[Cc]\s+\S+|\s+--\S+)*\s+`;
const GIT_STATE_SUBCOMMANDS = String.raw`(?:reset|commit|push|checkout|switch|restore|stash|clean|rebase|merge|cherry-pick)\b|worktree\s+remove\b`;

const GIT_WRITE_SUBCOMMANDS = [
  GIT_STATE_SUBCOMMANDS,
  String.raw`(?:apply|am)\b`,
  String.raw`worktree\s+(?:add|move|prune)\b`,
  String.raw`branch\s+-[dDmM]\b`,
  String.raw`tag\s+(?:-[adfs]\b|[^-\s])`,
].join("|");

const FILE_EDIT_COMMANDS = String.raw`(?:sed|perl)(?:\s+-\S+)*?\s+-[a-zA-Z0-9]*i(?![a-zA-Z0-9])|(?:rm|mv)\b`;
const FILE_REDIRECT = String.raw`>>?\|?(?!&)\s*(?!/dev/(?:null|stdout|stderr|tty)\b|/tmp/|/private/tmp/|/var/folders/|/private/var/folders/)[^\s&|;<>()]`;

const GIT_STATE_MUTATION = new RegExp(
  `${COMMAND_START}${GIT}(?:${GIT_STATE_SUBCOMMANDS})`,
);

const FILE_OR_GIT_MUTATION = new RegExp(
  `${COMMAND_START}(?:${GIT}(?:${GIT_WRITE_SUBCOMMANDS})|${FILE_EDIT_COMMANDS})|${FILE_REDIRECT}`,
);

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const WRITABLE_HOME_DIRECTORIES = [
  "Library/Caches",
  ".cache",
  ".npm",
  ".local/share/pnpm",
  ".cargo",
  "go",
  ".bun",
];

// The exact form protect-env-files.ts produces. It loads before this file and macOS refuses to
// apply a second sandbox inside a sandboxed process, so its profile is extended instead.
const SANDBOXED_COMMAND =
  /^\/usr\/bin\/sandbox-exec -p '((?:[^']|'"'"')*)' '((?:[^']|'"'"')*)' -c '((?:[^']|'"'"')*)'$/;

const TASK_OUTPUT_PATH = /tasks\/([A-Za-z0-9_-]+)\.output\b/g;

// Subagents run in the parent's process, so this map is shared by every session.
const REPOSITORY_WRITERS_KEY = Symbol.for(
  "pi-extensions/subagent-guard/repository-writers",
);

interface RepositoryWriter {
  sessionId: string;
  sessionName: string;
}

// Quoted text is mostly search patterns and messages, so `rg 'git commit'` is not a commit.
function stripQuotedText(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

export function mutatesGitState(command: string): boolean {
  return GIT_STATE_MUTATION.test(stripQuotedText(command));
}

export function mutatesFilesOrGit(command: string): boolean {
  return FILE_OR_GIT_MUTATION.test(stripQuotedText(command));
}

export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function shellUnquote(quotedText: string): string {
  return quotedText.replaceAll(`'"'"'`, "'");
}

export function parseSandboxedCommand(
  command: string,
): { profile: string; shell: string; command: string } | undefined {
  const match = SANDBOXED_COMMAND.exec(command);

  if (!match) {
    return undefined;
  }

  const [, profile, shell, innerCommand] = match;

  return {
    profile: shellUnquote(profile),
    shell: shellUnquote(shell),
    command: shellUnquote(innerCommand),
  };
}

function unsandboxedCommand(command: string): string {
  return parseSandboxedCommand(command)?.command ?? command;
}

function homeWriteDenyRules(home: string): string {
  const writable = WRITABLE_HOME_DIRECTORIES.map(
    (directory) => `(subpath "${join(home, directory)}")`,
  ).join(" ");

  return `(deny file-write* (subpath "${home}"))(allow file-write* ${writable})`;
}

export function sandboxCommand(command: string, home: string): string {
  const sandboxed = parseSandboxedCommand(command);
  const profile =
    (sandboxed?.profile ?? "(version 1)(allow default)") +
    homeWriteDenyRules(home);

  return [
    SANDBOX_EXEC,
    "-p",
    shellQuote(profile),
    shellQuote(sandboxed?.shell ?? "/bin/bash"),
    "-c",
    shellQuote(sandboxed?.command ?? command),
  ].join(" ");
}

export function taskOutputAgentIds(text: string): string[] {
  return [...text.matchAll(TASK_OUTPUT_PATH)].map((match) => match[1]);
}

export function frontmatterModel(text: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const modelLine = frontmatter
    ? /^model:\s*(.+?)\s*$/m.exec(frontmatter)?.[1]
    : undefined;

  return modelLine?.replace(/^["']|["']$/g, "") || undefined;
}

// pi-subagents accepts fuzzy model names such as "opus", so a request that names part of the
// pinned model asks for the same model.
export function modelMatchesPin(requested: string, pinned: string): boolean {
  return pinned.toLowerCase().includes(requested.toLowerCase());
}

// Same precedence as pi-subagents: project .pi/agents, then .agents/agents, then global.
function pinnedModel(agentType: string, cwd: string): string | undefined {
  const agentDirectory =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

  const agentFiles = [
    join(cwd, ".pi", "agents", `${agentType}.md`),
    join(cwd, ".agents", "agents", `${agentType}.md`),
    join(agentDirectory, "agents", `${agentType}.md`),
  ];

  const agentFile = agentFiles.find((path) => existsSync(path));

  return agentFile
    ? frontmatterModel(readFileSync(agentFile, "utf8"))
    : undefined;
}

function repositoryWriters(): Map<string, RepositoryWriter> {
  const store = globalThis as typeof globalThis & {
    [REPOSITORY_WRITERS_KEY]?: Map<string, RepositoryWriter>;
  };
  store[REPOSITORY_WRITERS_KEY] ??= new Map();

  return store[REPOSITORY_WRITERS_KEY];
}

function nearestExistingDirectory(path: string): string {
  let directory = dirname(path);

  while (!existsSync(directory) && dirname(directory) !== directory) {
    directory = dirname(directory);
  }

  return directory;
}

export default function (pi: ExtensionAPI) {
  const sessionId = randomUUID();
  const repositoryRootByDirectory = new Map<string, string | undefined>();
  const recentPrompts = new Map<
    string,
    { spawnedAt: number; toolCallId: string }
  >();
  const home = realpathSync(homedir());
  const canSandbox = process.platform === "darwin" && existsSync(SANDBOX_EXEC);

  const subagentType = (): string | undefined =>
    SUBAGENT_SESSION_NAME.exec(pi.getSessionName() ?? "")?.[1];

  const repositoryRoot = async (
    directory: string,
  ): Promise<string | undefined> => {
    if (repositoryRootByDirectory.has(directory)) {
      return repositoryRootByDirectory.get(directory);
    }

    const gitResult = await pi.exec(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      { timeout: 5_000 },
    );
    const root = gitResult.code === 0 ? gitResult.stdout.trim() : undefined;
    repositoryRootByDirectory.set(directory, root);

    return root;
  };

  const releaseRepositories = () => {
    const writers = repositoryWriters();

    for (const [root, writer] of writers) {
      if (writer.sessionId === sessionId) {
        writers.delete(root);
      }
    }
  };

  // Two subagents writing to one checkout overwrite each other's work, so the first writer
  // holds the repository until it settles.
  const claimRepository = async (
    directory: string,
    sessionName: string,
  ): Promise<ToolCallEventResult | undefined> => {
    const root = await repositoryRoot(directory);

    if (!root) {
      return undefined;
    }

    const writers = repositoryWriters();
    const holder = writers.get(root);

    if (holder && holder.sessionId !== sessionId) {
      return {
        block: true,
        reason: `${holder.sessionName} is already editing ${root}; spawn this agent with isolation: "worktree"`,
      };
    }

    writers.set(root, { sessionId, sessionName });

    return undefined;
  };

  const checkAgentModel = (
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ): ToolCallEventResult | undefined => {
    const agentType = input.subagent_type;

    if (typeof agentType !== "string" || typeof input.resume === "string") {
      return undefined;
    }

    const trimmedModel =
      typeof input.model === "string" ? input.model.trim() : "";
    const requested = trimmedModel === "" ? undefined : trimmedModel;
    const pinned = pinnedModel(agentType, ctx.cwd);
    const { models } = loadConfig(pi);
    const configured = models?.agents?.[agentType];

    if (pinned && requested) {
      if (!modelMatchesPin(requested, pinned)) {
        return {
          block: true,
          reason: `${agentType} is pinned to ${pinned}, which overrides the model argument; omit model or choose an agent type pinned to ${requested}`,
        };
      }
    }

    const currentModel = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined;
    const effectiveModel = pinned ?? requested ?? configured ?? currentModel;

    if (effectiveModel && isForbiddenForSubagents(models, effectiveModel)) {
      const allowed = models?.subagent?.[0];

      return {
        block: true,
        reason: `Subagents may not run on ${effectiveModel}, but ${agentType} would; pass an allowed model${allowed ? ` such as ${allowed}` : ""}`,
      };
    }

    if (!pinned && !requested) {
      if (configured) {
        input.model = configured;
      }
    }

    return undefined;
  };

  const checkReviewAgent = (
    input: Record<string, unknown>,
  ): ToolCallEventResult | undefined => {
    if (
      typeof input.resume === "string" ||
      typeof input.subagent_type !== "string" ||
      !(
        REVIEW_AGENT_TYPES.has(input.subagent_type) ||
        loadConfig(pi).agentRoles?.review?.includes(input.subagent_type)
      )
    ) {
      return undefined;
    }

    return {
      block: true,
      reason: `${input.subagent_type}: ${REVIEW_AGENT_REASON}`,
    };
  };

  const checkDuplicatePrompt = (
    input: Record<string, unknown>,
    toolCallId: string,
  ): ToolCallEventResult | undefined => {
    if (typeof input.resume === "string" || typeof input.prompt !== "string") {
      return undefined;
    }

    const now = Date.now();

    for (const [prompt, { spawnedAt }] of recentPrompts) {
      if (now - spawnedAt > DUPLICATE_PROMPT_WINDOW_MS) {
        recentPrompts.delete(prompt);
      }
    }

    const prompt = input.prompt.trim().replace(/\s+/g, " ");

    if (recentPrompts.has(prompt)) {
      return {
        block: true,
        reason:
          "An agent with this exact prompt was spawned in the last 10 minutes; use get_subagent_result or resume it instead of spawning it again",
      };
    }

    recentPrompts.set(prompt, { spawnedAt: now, toolCallId });

    return undefined;
  };

  // A spawn that failed or that a later extension blocked may be retried with the same prompt.
  const forgetPrompt = (toolCallId: string) => {
    for (const [prompt, spawn] of recentPrompts) {
      if (spawn.toolCallId === toolCallId) {
        recentPrompts.delete(prompt);
      }
    }
  };

  const guardReadOnlyTool = (
    event: ToolCallEvent,
    agentType: string,
  ): ToolCallEventResult | undefined => {
    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason: `${agentType} is a read-only agent and cannot ${event.toolName} files`,
      };
    }

    if (event.toolName !== "bash") {
      return undefined;
    }

    const input = event.input as { command: string };

    if (mutatesFilesOrGit(unsandboxedCommand(input.command))) {
      return {
        block: true,
        reason: `${agentType} is a read-only agent; this command changes files or git state. Write scratch output under /tmp instead`,
      };
    }

    if (canSandbox) {
      input.command = sandboxCommand(input.command, home);
    }

    return undefined;
  };

  const writeTargetDirectory = (
    event: ToolCallEvent,
    cwd: string,
  ): string | undefined => {
    const input = event.input as Record<string, unknown>;

    const writesFile = event.toolName === "write" || event.toolName === "edit";

    if (writesFile && typeof input.path === "string") {
      const pathFromTool = input.path
        .replace(/^@/, "")
        .replace(/^~(?=\/)/, homedir());
      return nearestExistingDirectory(resolve(cwd, pathFromTool));
    }

    if (
      event.toolName === "bash" &&
      typeof input.command === "string" &&
      mutatesFilesOrGit(unsandboxedCommand(input.command))
    ) {
      return cwd;
    }

    return undefined;
  };

  const consumeCompletionNotification = (agentId: string) => {
    pi.events.emit("subagents:rpc:consume", {
      requestId: randomUUID(),
      agentId,
    });
  };

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "Agent") {
      const input = event.input as Record<string, unknown>;

      if (subagentType()) {
        return checkAgentModel(input, ctx);
      }

      return (
        checkReviewAgent(input) ??
        checkAgentModel(input, ctx) ??
        checkDuplicatePrompt(input, event.toolCallId)
      );
    }

    const agentType = subagentType();

    if (!agentType) {
      return undefined;
    }

    // A subagent once started autoresearch and committed to the main checkout.
    if (event.toolName.includes("experiment")) {
      return {
        block: true,
        reason: "Subagents cannot run autoresearch experiment tools",
      };
    }

    if (
      READ_ONLY_AGENT_TYPES.has(agentType) ||
      loadConfig(pi).agentRoles?.readOnly?.includes(agentType)
    ) {
      return guardReadOnlyTool(event, agentType);
    }

    const input = event.input as Record<string, unknown>;

    if (
      agentType === GIT_STATE_PRESERVING_AGENT_TYPE &&
      event.toolName === "bash" &&
      typeof input.command === "string" &&
      mutatesGitState(unsandboxedCommand(input.command))
    ) {
      return {
        block: true,
        reason: `${agentType} must not change git history or state`,
      };
    }

    const directory = writeTargetDirectory(event, ctx.cwd);

    if (!directory) {
      return undefined;
    }

    return claimRepository(directory, pi.getSessionName() ?? agentType);
  });

  // pi-subagents drops a completion notification only when get_subagent_result reads the
  // result; reading the transcript file directly is just as much a read.
  pi.on("tool_result", async (event) => {
    if (subagentType() || event.isError) {
      return undefined;
    }

    if (event.toolName !== "read" && event.toolName !== "bash") {
      return undefined;
    }

    const input = event.input as Record<string, unknown>;
    const text = event.toolName === "read" ? input.path : input.command;

    if (typeof text !== "string") {
      return undefined;
    }

    for (const agentId of taskOutputAgentIds(text)) {
      consumeCompletionNotification(agentId);
    }

    return undefined;
  });

  // The parent stopped the agent itself, so a notification that it stopped adds nothing.
  const unsubscribeFailed = pi.events.on("subagents:failed", (data) => {
    const record = data as { id?: unknown; status?: unknown };

    if (
      subagentType() ||
      record.status !== "stopped" ||
      typeof record.id !== "string"
    ) {
      return;
    }

    consumeCompletionNotification(record.id);
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "Agent" && event.isError) {
      forgetPrompt(event.toolCallId);
    }
  });

  pi.on("agent_settled", async () => {
    releaseRepositories();
  });

  pi.on("session_shutdown", async () => {
    releaseRepositories();
    unsubscribeFailed();
  });
}
