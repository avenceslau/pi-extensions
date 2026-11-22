import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import userConfig from "./index.ts";

test("loads user configuration before extension initialization finishes", async () => {
  let refreshFinished = false;
  function failIfSessionHandlerRegistered(): never {
    throw new Error(
      "session_start should not be registered after a successful load",
    );
  }

  const pi = {
    on: failIfSessionHandlerRegistered,
  } satisfies Parameters<typeof userConfig>[0];

  const loading = userConfig(pi, async () => {
    await setImmediate();
    refreshFinished = true;
  });

  assert.equal(refreshFinished, false);
  await loading;
  assert.equal(refreshFinished, true);
});
