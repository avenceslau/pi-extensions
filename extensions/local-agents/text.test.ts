import assert from "node:assert/strict";
import test from "node:test";
import { slug } from "./text.ts";

test("a slug cut at a word boundary does not end in a dash", () => {
  const name = slug(
    "WOR-000: Upgrade the Grafana syncer component to 1.3.1 and more",
  );

  assert.equal(name, "wor-000-upgrade-the-grafana-syncer-component-to-1");
  assert.doesNotMatch(
    slug("CI: Cache the Norns experiments' Saffron cargo target"),
    /-$/,
  );
});

test("a slug has no leading or doubled dashes", () => {
  assert.equal(slug("  --Fix: the  build!  "), "fix-the-build");
});
