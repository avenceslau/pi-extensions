import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAgentConfig } from "../shared/config-types.ts";
import type {
  LocalAgentDefinition,
  Repository,
  Trigger,
} from "./definition.ts";
import { expandHome } from "./command-policy.ts";
import { POLICY_VARIABLE, type RunPolicy } from "./run-policy.ts";
import { agentDirectory } from "./state.ts";
import type { PreparedWorktree } from "./worktree.ts";

const EXTENSIONS_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)));

// Extensions from this package every run loads: the guard, Rex status reporting, and retries with model failover.
const PACKAGE_EXTENSIONS = [
  "local-agents/guard.ts",
  "rex/index.ts",
  "auto-retry/index.ts",
];

const RULES = join(dirname(fileURLToPath(import.meta.url)), "rules.md");

export interface Launch {
  runId: string;
  command: string[];
}

// Writes the run's policy and prompt and returns the command that starts its pi session. The session loads no
// extension, skill, prompt template, MCP server, or context file beyond what is listed here, so the tools it has are
// exactly the playbook's.
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
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${trigger.playbook}-${randomUUID().slice(0, 8)}`;
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
    tools,
    commands: playbook.commands(repository),
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

  const dirtyNote = worktree.dirty
    ? "\n\nThe worktree has uncommitted changes from an earlier run, so it was not moved to the commit above. Check `git status` and ask the user before discarding anything.\n"
    : "";

  mkdirSync(runsDirectory, { recursive: true });
  writeFileSync(promptPath, `${trigger.prompt}${dirtyNote}`);
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
