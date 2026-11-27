import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAgentConfig } from "../shared/config-types.ts";
import type {
  LocalAgentDefinition,
  Playbook,
  Repository,
  Trigger,
} from "./definition.ts";
import { POLICY_VARIABLE, type RunPolicy } from "./guard/policy.ts";
import { expandHome } from "./paths.ts";
import { agentDirectory } from "./state.ts";
import type { PreparedWorktree } from "./worktree.ts";

const EXTENSIONS_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)));

const RUN_ID_SUFFIX_CHARACTERS = 8;

const PACKAGE_EXTENSIONS = [
  "local-agents/guard/index.ts",
  "rex/index.ts",
  "auto-retry/index.ts",
];

const RULES = join(dirname(fileURLToPath(import.meta.url)), "rules.md");

export interface Launch {
  runId: string;
  command: string[];
}

// What the agent should know about its worktree before it starts: leftover changes, whether dependencies are
// installed, and which of the repository's commands it may run.
function worktreeNotes(
  playbook: Playbook,
  repository: Repository,
  worktree: PreparedWorktree,
): string[] {
  const notes: string[] = [];

  if (worktree.keptUncommittedChanges) {
    notes.push(
      "The worktree has uncommitted changes from an earlier run, so it was not moved to the commit above. Check `git status` and ask the user before discarding anything.",
    );
  }

  if (!playbook.runsRepositoryCode) {
    return notes;
  }

  const setup = `\`${repository.setup.join(" ")}\``;

  if (worktree.setupFailure) {
    notes.push(
      `Installing dependencies with ${setup} failed, so tests may not run until that is fixed:\n\n\`\`\`\n${worktree.setupFailure}\n\`\`\``,
    );
  } else if (repository.setup.length > 0) {
    notes.push(`Dependencies are installed (${setup} ran in the worktree).`);
  }

  if (repository.commands.length > 0) {
    notes.push(
      `Besides read-only and git commands, you may run these repository commands to build and test (\`*\` is one word, \`**\` the rest):\n${repository.commands.map((pattern) => `- \`${pattern}\``).join("\n")}`,
    );
  }

  return notes;
}

export async function prepareLaunch(
  definition: LocalAgentDefinition,
  config: LocalAgentConfig,
  trigger: Trigger,
  repository: Repository,
  worktree: PreparedWorktree,
  now: Date,
): Promise<Launch> {
  const playbook = definition.playbooks[trigger.playbook];

  if (!playbook) {
    throw new Error(`${definition.name} has no playbook ${trigger.playbook}`);
  }

  // Launches in one tick share `now`, so the random suffix keeps their policy, prompt, and status files apart.
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${trigger.playbook}-${randomUUID().slice(0, RUN_ID_SUFFIX_CHARACTERS)}`;
  const runsDirectory = join(agentDirectory(definition.name), "runs");
  const policyPath = join(runsDirectory, `${runId}.policy.json`);
  const promptPath = join(runsDirectory, `${runId}.prompt.md`);

  const guardTools = [
    ...(trigger.push ? ["push_branch"] : []),
    ...(playbook.mergeRequest ? ["open_merge_request"] : []),
    ...(playbook.comment && trigger.review ? ["post_comment"] : []),
  ];

  const tools = [...playbook.tools, ...guardTools];

  const policy: RunPolicy = {
    agent: definition.name,
    runId,
    worktree: worktree.path,
    gitDirectory: worktree.gitDirectory,
    statusFile: join(runsDirectory, `${runId}.status.json`),
    reviewsFile: join(runsDirectory, `${runId}.reviews.json`),
    tools,
    bashCommandPatterns: playbook.commands(repository),
    repository: {
      forge: repository.forge.kind,
      host: repository.forge.host,
      project: repository.forge.project,
      url: repository.forge.url,
    },
    review: trigger.review,
    push: trigger.push,
    mergeRequest: playbook.mergeRequest
      ? { targetBranch: await repository.forge.defaultBranch() }
      : undefined,
    comment: playbook.comment,
  };

  mkdirSync(runsDirectory, { recursive: true });
  writeFileSync(
    promptPath,
    [trigger.prompt, ...worktreeNotes(playbook, repository, worktree)].join(
      "\n\n",
    ),
  );
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));

  const extensions = [
    ...PACKAGE_EXTENSIONS.map((path) => join(EXTENSIONS_DIRECTORY, path)),
    ...(config.extensions ?? []).map(expandHome),
  ];

  return {
    runId,
    command: [
      "env",
      `${POLICY_VARIABLE}=${policyPath}`,
      "pi",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-mcp",
      "--no-approve",
      ...extensions.flatMap((path) => ["-e", path]),
      "--tools",
      tools.join(","),
      ...(config.model ? ["--model", config.model] : []),
      "--thinking",
      config.thinking ?? "medium",
      "--name",
      `${trigger.tab.label} · ${trigger.playbook}`,
      "--append-system-prompt",
      RULES,
      "--append-system-prompt",
      playbook.instructions,
      `@${promptPath}`,
      "Do the task in the attached file.",
    ],
  };
}
