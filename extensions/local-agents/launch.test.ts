import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  LocalAgentDefinition,
  Repository,
  Trigger,
} from "./definition.ts";
import type { ForgeClient } from "./forges/types.ts";
import { parseRunPolicy, POLICY_VARIABLE } from "./guard/policy.ts";
import { prepareLaunch } from "./launch.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "launch-"));

// SAFETY: prepareLaunch reads only these fields of the forge client.
const forge = {
  kind: "github",
  host: "github.com",
  project: "owner/repo",
  url: "https://github.com/owner/repo",
  defaultBranch: async () => "main",
} as ForgeClient;

const repository: Repository = {
  url: "github.com/owner/repo",
  path: "/work/repo",
  forge,
  commands: ["pnpm test **"],
};

const definition: LocalAgentDefinition = {
  name: "watcher",
  checks: [],
  playbooks: {
    review: {
      instructions: "/playbooks/review.md",
      tools: ["read", "bash"],
      commands: (target) => ["git status **", ...target.commands],
      comment: true,
    },
  },
};

const trigger: Trigger = {
  key: "review:1",
  playbook: "review",
  repository: repository.url,
  tab: {
    key: "tab",
    label: "#1 - Title",
  },
  worktree: {
    branch: "watcher/pr-1",
    fetch: ["refs/pull/1/head"],
    start: "abc",
  },
  review: {
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
  },
  prompt: "Review it.",
};

test("a run loads nothing ambient and gets only its playbook's tools", async () => {
  const launch = await prepareLaunch(
    definition,
    { extensions: ["/provider.ts"] },
    trigger,
    repository,
    {
      path: "/work/worktree",
      gitDirectory: "/work/repo/.git",
      keptUncommittedChanges: false,
    },
    new Date(),
  );

  const { command } = launch;

  for (const flag of [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--no-approve",
  ]) {
    assert.ok(command.includes(flag), flag);
  }

  const extensions = command.flatMap((argument, index) =>
    command[index - 1] === "-e" ? [argument] : [],
  );

  assert.deepEqual(
    extensions.map((path) => path.split("/extensions/").at(-1)),
    [
      "local-agents/guard/index.ts",
      "rex/index.ts",
      "auto-retry/index.ts",
      "/provider.ts",
    ],
  );
  assert.equal(
    command[command.indexOf("--tools") + 1],
    "read,bash,post_comment",
  );

  const policyPath = command[1].slice(`${POLICY_VARIABLE}=`.length);
  const policy = parseRunPolicy(readFileSync(policyPath, "utf8"));

  assert.equal(policy?.worktree, "/work/worktree");
  assert.deepEqual(policy?.bashCommandPatterns, [
    "git status **",
    "pnpm test **",
  ]);
  assert.equal(policy?.comment, true);
  assert.equal(policy?.push, undefined);
});
