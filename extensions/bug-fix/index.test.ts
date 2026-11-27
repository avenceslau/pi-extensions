import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bugFix from "./index.ts";

type Tool = {
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
};

const directory = mkdtempSync(join(tmpdir(), "bug-fix-"));
const callLog = join(directory, "calls.jsonl");
const sessionsFile = join(directory, "sessions.json");

// Each fake records its argv and prints what the extension expects from the real program.
const FAKE_PROGRAMS: Record<string, string> = {
  git: `
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${directory}" ;;
  "rev-parse --git-common-dir") echo .git ;;
  "rev-parse origin/HEAD^{commit}") echo abc123 ;;
esac`,
  shirei: `echo "${directory}"`,
  rex: `
case "$1 $2" in
  "ls --json") cat "${sessionsFile}" ;;
  new\\ *) echo '{"session_id":"session:new","initial_windows":[{"window_id":"window:first"}]}' ;;
  "window new") echo '{"window_id":"window:added"}' ;;
esac`,
};

for (const [name, body] of Object.entries(FAKE_PROGRAMS)) {
  const path = join(directory, name);
  writeFileSync(
    path,
    `#!/bin/sh\nnode -e 'process.stdout.write(JSON.stringify(process.argv.slice(1))+"\\n")' ${name} "$@" >> "${callLog}"\n${body}\n`,
  );
  chmodSync(path, 0o755);
}

process.env.PATH = `${directory}:${process.env.PATH}`;

function calls(program: string): string[][] {
  return readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter(([name]) => name === program)
    .map(([, ...args]) => args);
}

function setup(existingSessions: { session_id: string; label: string }[]) {
  writeFileSync(callLog, "");
  writeFileSync(sessionsFile, JSON.stringify({ sessions: existingSessions }));

  let tool: Tool | undefined;
  const pi = {
    registerTool: (definition: Tool) => {
      tool = definition;
    },
    getThinkingLevel: () => "high",
    events: { emit: () => undefined },
  } as unknown as ExtensionAPI;
  bugFix(pi);

  if (!tool) {
    throw new Error("start_bug_fix was not registered");
  }

  const registeredTool = tool;
  const context = {
    cwd: directory,
    model: { provider: "provider", id: "model" },
    sessionManager: { getSessionFile: () => "/sessions/reporter.jsonl" },
    ui: { notify: () => undefined },
  };

  return (params: Record<string, string>) =>
    registeredTool.execute("call", params, undefined, undefined, context);
}

test("creates the bugs session and a worktree for the first bug", async () => {
  const startBugFix = setup([{ session_id: "session:main", label: "main" }]);

  const started = await startBugFix({
    title: "Parser drops   trailing newline",
    description: "parse() in src/parse.ts loses the final line.",
  });

  const { branch, ...window } = started.details as { branch: string };
  assert.match(branch, /^bug\/parser-drops-trailing-newline-[0-9a-f]{6}$/);
  assert.deepEqual(window, {
    sessionId: "session:new",
    windowId: "window:first",
    createdSession: true,
    worktree: directory,
  });

  assert.deepEqual(calls("shirei"), [
    [
      "branch",
      branch,
      "--base",
      "abc123",
      "--no-open",
      "--print-path",
      "--install=none",
    ],
  ]);

  const create = calls("rex")[1];
  const separator = create.indexOf("--");
  assert.deepEqual(create.slice(0, separator), [
    "new",
    "bugs",
    "--window",
    "Parser drops trailing newline",
    "--cwd",
    directory,
    "--json",
  ]);

  const command = create.slice(separator + 1);
  assert.deepEqual(command.slice(0, 7), [
    "pi",
    "--name",
    "Bug: Parser drops trailing newline",
    "--model",
    "provider/model",
    "--thinking",
    "high",
  ]);
  assert.match(command[7], new RegExp(`new worktree on branch ${branch}`));
  assert.match(command[7], /Reporter's session: \/sessions\/reporter\.jsonl/);
  assert.match(
    command[7],
    /parse\(\) in src\/parse\.ts loses the final line\./,
  );
});

test("adds a tab to the existing bugs session", async () => {
  const startBugFix = setup([{ session_id: "session:bugs", label: "bugs" }]);

  const started = await startBugFix({
    title: "Flaky retry",
    description: "Details.",
  });

  assert.equal(
    (started.details as { windowId: string }).windowId,
    "window:added",
  );
  assert.deepEqual(calls("rex")[1].slice(0, 6), [
    "window",
    "new",
    "-s",
    "session:bugs",
    "Flaky retry",
    "--focus=false",
  ]);
});
