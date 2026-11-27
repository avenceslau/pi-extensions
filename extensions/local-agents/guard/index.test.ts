import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toolPathIsInside } from "./index.ts";

const worktree = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));

mkdirSync(join(worktree, "src"));

symlinkSync(tmpdir(), join(worktree, "escape"));

test("file tool paths must stay in the worktree", () => {
  assert.equal(toolPathIsInside(worktree, worktree, "src/index.ts"), true);
  assert.equal(toolPathIsInside(worktree, worktree, "@src/new.ts"), true);
  assert.equal(toolPathIsInside(worktree, worktree, "."), true);
  assert.equal(toolPathIsInside(worktree, worktree, "~/.zshrc"), false);
  assert.equal(toolPathIsInside(worktree, worktree, "../other"), false);
  assert.equal(toolPathIsInside(worktree, worktree, "/etc/hosts"), false);
});

test("a symlink out of the worktree counts as outside", () => {
  assert.equal(toolPathIsInside(worktree, worktree, "escape/file"), false);
});
