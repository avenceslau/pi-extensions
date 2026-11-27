import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bugFix from "./index.ts";

type Tool = {
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
};

function setup(existingSessions: { session_id: string; label: string }[]) {
  const calls: string[][] = [];
  let tool: Tool | undefined;
  const pi = {
    registerTool: (definition: Tool) => {
      tool = definition;
    },
    getThinkingLevel: () => "high",
    events: { emit: () => undefined },
    exec: async (_command: string, args: string[]) => {
      calls.push(args);

      if (args[0] === "ls") {
        return {
          code: 0,
          stdout: JSON.stringify({ sessions: existingSessions }),
          stderr: "",
        };
      }

      if (args[0] === "new") {
        return {
          code: 0,
          stdout: JSON.stringify({
            session_id: "session:new",
            initial_windows: [{ window_id: "window:first" }],
          }),
          stderr: "",
        };
      }

      return {
        code: 0,
        stdout: JSON.stringify({ window_id: "window:added" }),
        stderr: "",
      };
    },
  } as unknown as ExtensionAPI;
  bugFix(pi);

  const context = {
    cwd: "/repo",
    model: { provider: "provider", id: "model" },
    sessionManager: { getSessionFile: () => "/sessions/reporter.jsonl" },
    ui: { notify: () => undefined },
  };
  const run = (params: Record<string, string>) =>
    tool!.execute("call", params, undefined, undefined, context);

  return { calls, run };
}

test("creates the bugs session when it does not exist", async () => {
  const { calls, run } = setup([{ session_id: "session:main", label: "main" }]);

  const result = await run({
    title: "Parser drops   trailing newline",
    description: "parse() in src/parse.ts loses the final line.",
  });

  assert.deepEqual(result.details, {
    sessionId: "session:new",
    windowId: "window:first",
    createdSession: true,
  });

  const create = calls[1];
  const command = create.slice(create.indexOf("--") + 1);
  assert.deepEqual(create.slice(0, create.indexOf("--")), [
    "new",
    "bugs",
    "--window",
    "Parser drops trailing newline",
    "--cwd",
    "/repo",
    "--json",
  ]);
  assert.deepEqual(command.slice(0, 7), [
    "pi",
    "--name",
    "Bug: Parser drops trailing newline",
    "--model",
    "provider/model",
    "--thinking",
    "high",
  ]);
  assert.match(
    command[7],
    /Reported from session: \/sessions\/reporter\.jsonl/,
  );
  assert.match(
    command[7],
    /parse\(\) in src\/parse\.ts loses the final line\./,
  );
});

test("adds a tab to the existing bugs session", async () => {
  const { calls, run } = setup([{ session_id: "session:bugs", label: "bugs" }]);

  const result = await run({ title: "Flaky retry", description: "Details." });

  assert.deepEqual(result.details, {
    sessionId: "session:bugs",
    windowId: "window:added",
    createdSession: false,
  });
  assert.deepEqual(calls[1].slice(0, 6), [
    "window",
    "new",
    "--session",
    "session:bugs",
    "Flaky retry",
    "--focus=false",
  ]);
});
