import assert from "node:assert/strict";
import test from "node:test";
import { targetForRemote } from "./index.ts";

test("github.com and gitlab.com work without config", () => {
  assert.deepEqual(targetForRemote("git@github.com:owner/repo.git", {}), {
    forge: "github",
    repository: "github.com/owner/repo",
  });
  assert.deepEqual(
    targetForRemote("https://gitlab.com/group/sub/repo.git", {}),
    {
      forge: "gitlab",
      repository: "https://gitlab.com/group/sub/repo",
    },
  );
});

test("configured hosts use their forge's CLI with the host in the repository", () => {
  const forges = {
    "github.example.com": "github",
    "git.example.com": "gitlab",
  } as const;

  assert.deepEqual(
    targetForRemote("git@github.example.com:owner/repo.git", forges),
    {
      forge: "github",
      repository: "github.example.com/owner/repo",
    },
  );
  assert.deepEqual(
    targetForRemote("ssh://git@git.example.com/group/repo.git", forges),
    {
      forge: "gitlab",
      repository: "https://git.example.com/group/repo",
    },
  );
});

test("an unknown host has no target", () => {
  assert.equal(
    targetForRemote("git@git.example.com:group/repo.git", {}),
    undefined,
  );
});
