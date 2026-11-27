import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReviewOpenedCommand } from "./review-opened.ts";

test("the command gets the agent, title, and URL of the opened review", async () => {
  const output = join(mkdtempSync(join(tmpdir(), "review-opened-")), "out");

  await runReviewOpenedCommand(
    [
      "sh",
      "-c",
      `printf '%s|%s|%s' "$LOCAL_AGENT" "$REVIEW_TITLE" "$REVIEW_URL" > ${output}`,
    ],
    "todai",
    {
      title: "Cache the worker build",
      url: "https://git.example.com/group/repo/-/merge_requests/7",
    },
  );

  assert.equal(
    readFileSync(output, "utf8"),
    "todai|Cache the worker build|https://git.example.com/group/repo/-/merge_requests/7",
  );
});

test("a failing command rejects, so the tick retries it", async () => {
  await assert.rejects(
    runReviewOpenedCommand(["false"], "todai", {
      title: "Title",
      url: "https://example.com/pull/1",
    }),
  );
});
