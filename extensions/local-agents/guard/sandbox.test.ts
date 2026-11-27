import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandboxProfile } from "./sandbox.ts";

const profile = sandboxProfile({
  worktree: "/work/worktree",
  gitDirectory: "/work/repo/.git",
});

test("the sandbox lets cargo update its install records but not install binaries", () => {
  assert.ok(
    profile.includes(`(literal "${join(homedir(), ".cargo/.crates.toml")}")`),
  );
  assert.ok(!profile.includes(join(homedir(), ".cargo/bin")));
  assert.ok(!profile.includes(`(subpath "${join(homedir(), ".cargo")}")`));
});

test("environment files are readable only inside the worktree", () => {
  assert.ok(
    profile.indexOf('(allow file-read* (subpath "/work/worktree"))') >
      profile.indexOf("(deny file-read*"),
  );
});

test("the sandbox denies writes by default and allows the worktree and git", () => {
  assert.match(
    profile,
    /\(deny file-write\*\)\(allow file-write\* \(subpath "\/work\/worktree"\)\)/,
  );
  assert.ok(profile.includes('(subpath "/work/repo/.git")'));
});
