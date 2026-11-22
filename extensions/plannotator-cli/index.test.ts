import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  lastAssistantText,
  parseLastDecision,
  runPlannotatorProcess,
} from "./index.ts";

type ConversationBranch = ReturnType<
  ExtensionContext["sessionManager"]["getBranch"]
>;

test("skips the assistant message that called the last-message tool", () => {
  const branch = [
    {
      type: "message",
      id: "earlier",
      parentId: null,
      timestamp: "2026-11-22T00:00:00.000Z",
      message: fauxAssistantMessage("The response to annotate"),
    },
    {
      type: "message",
      id: "tool-call",
      parentId: "earlier",
      timestamp: "2026-11-22T00:01:00.000Z",
      message: fauxAssistantMessage([
        fauxText("Opening Plannotator"),
        fauxToolCall("plannotator_last", {}, { id: "call-1" }),
      ]),
    },
  ] satisfies ConversationBranch;

  assert.equal(lastAssistantText(branch, "call-1"), "The response to annotate");
});

test("passes the reviewed message through stdin and captures CLI feedback", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plannotator-cli-"));
  const executable = join(directory, "plannotator");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    executable,
    `#!/bin/sh
message=$(cat)
printf '{"decision":"annotated","feedback":"Comment on %s"}' "$message"
`,
  );
  await chmod(executable, 0o755);

  const processOutput = await runPlannotatorProcess(
    executable,
    ["last", "--stdin", "--json"],
    {
      cwd: directory,
      input: "the prior response",
    },
  );

  assert.deepEqual(parseLastDecision(processOutput.stdout), {
    kind: "feedback",
    feedback: "Comment on the prior response",
  });
});

test("reports a missing Plannotator installation", async () => {
  await assert.rejects(
    runPlannotatorProcess("/missing/plannotator", ["review"], {
      cwd: process.cwd(),
    }),
    /Plannotator CLI was not found/,
  );
});

test("parses approved and dismissed last-message decisions", () => {
  assert.deepEqual(parseLastDecision('{"decision":"approved"}'), {
    kind: "approved",
  });
  assert.deepEqual(parseLastDecision(""), { kind: "dismissed" });
});
