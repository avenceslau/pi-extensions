import assert from "node:assert/strict";
import test from "node:test";
import { errorSignature, logLines } from "./ci.ts";

test("the signature is the first error near the end, without run-specific numbers", () => {
  const first = logLines(
    [
      "\u001b[32;1m$ pnpm test\u001b[0;m",
      "section_start:1764200000:step_script\r\u001b[0K running",
      " FAIL  src/queue.test.ts > drains 120 messages in 35ms",
      "2026-11-27T01:05:11.123456Z 01O AssertionError: expected 119 to be 120",
      "2026-11-27T01:05:11.123456Z 00O [collapsed=true]Uploading artifacts for failed job",
      "2026-11-27T01:05:11.123456Z 00O ERROR: Job failed: exit code 1",
    ].join("\n"),
  );

  const second = logLines(
    [
      "2026-11-27T00:55:36.1234567Z  FAIL  src/queue.test.ts > drains 120 messages in 41ms",
      "2026-11-27T00:55:36.1234567Z AssertionError: expected 118 to be 120",
      "2026-11-27T00:55:37.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n"),
  );

  assert.equal(
    errorSignature(first),
    "FAIL  src/queue.test.ts > drains <n> messages in <n>ms",
  );
  assert.equal(errorSignature(second), errorSignature(first));
});

test("a log without an error line falls back to its last line", () => {
  assert.equal(
    errorSignature(logLines("step one\nKilled at commit 4f9c2a1b\n")),
    "Killed at commit <hash>",
  );
});
