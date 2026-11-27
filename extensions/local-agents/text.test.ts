import assert from "node:assert/strict";
import test from "node:test";
import { slug } from "./text.ts";

test("slug drops a dash left at the truncation point", () => {
  assert.equal(
    slug("Upgrade the dashboard sync component to version 1.3.1"),
    "upgrade-the-dashboard-sync-component-to-version-1",
  );
});
