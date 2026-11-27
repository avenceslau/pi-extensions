import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedFiles, restoreFilesSetupChanged } from "./worktree.ts";

test("setup's edits to tracked files are put back, earlier changes are kept", async () => {
  const path = mkdtempSync(join(tmpdir(), "worktree-"));

  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
      {
        cwd: path,
      },
    );

  git("init", "-q");
  writeFileSync(join(path, "pnpm-lock.yaml"), "lock\n");
  writeFileSync(join(path, "notes.md"), "notes\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  writeFileSync(join(path, "notes.md"), "an earlier run's change\n");

  const before = await changedFiles(path);

  writeFileSync(join(path, "pnpm-lock.yaml"), "lock\nrewritten by setup\n");
  await restoreFilesSetupChanged(path, before);

  assert.equal(readFileSync(join(path, "pnpm-lock.yaml"), "utf8"), "lock\n");
  assert.equal(
    readFileSync(join(path, "notes.md"), "utf8"),
    "an earlier run's change\n",
  );
});
