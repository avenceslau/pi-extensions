import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCommand,
  FORGE_READ_COMMANDS,
  GIT_READ_COMMANDS,
  READ_ONLY_COMMANDS,
} from "./commands.ts";

const ROOT = "/work/repo";

const ALLOW = [
  ...READ_ONLY_COMMANDS,
  ...GIT_READ_COMMANDS,
  ...FORGE_READ_COMMANDS,
  "pnpm --filter * test **",
];

function allowed(command: string): boolean {
  return checkCommand(command, ALLOW, ROOT).allowed;
}

test("allows lists and pipelines of allowed commands", () => {
  assert.equal(allowed("git status && git log --oneline -5"), true);
  assert.equal(allowed("git diff origin/main...HEAD | head -50"), true);
  assert.equal(allowed("rg -n 'foo$' src 2>/dev/null; ls packages"), true);
  assert.equal(allowed("CI=1 pnpm --filter durability test -- --run"), true);
  assert.equal(allowed("cd packages/core && git log -3 2>&1"), true);
});

test("refuses commands outside the patterns", () => {
  assert.equal(allowed("git push origin HEAD"), false);
  assert.equal(allowed("git status && rm -rf src"), false);
  assert.equal(allowed("pnpm test"), false);
  assert.equal(allowed("glab mr note 12 -m hi"), false);
});

test("refuses shell features that hide what runs", () => {
  assert.equal(allowed("echo $(git push)"), false);
  assert.equal(allowed("echo `git push`"), false);
  assert.equal(allowed('cat "$HOME/.ssh/id_rsa"'), false);
  assert.equal(allowed("(git push)"), false);
  assert.equal(allowed("git log &"), false);
  assert.equal(allowed("cat <<EOF\nx\nEOF"), false);
  assert.equal(allowed("PATH=/tmp git status"), false);
});

test("refuses writing output anywhere but /dev/null", () => {
  assert.equal(allowed("echo hi > notes.txt"), false);
  assert.equal(allowed("git log>log.txt"), false);
  assert.equal(allowed("git log > /dev/null"), true);
  assert.equal(allowed("grep -- '->' src/index.ts"), true);
});

test("refuses paths outside the worktree", () => {
  assert.equal(allowed("cat ~/.ssh/id_rsa"), false);
  assert.equal(allowed("ls ../other"), false);
  assert.equal(allowed("cd /etc && ls"), false);
  assert.equal(allowed("rg foo --glob=/etc/*"), false);
  assert.equal(allowed("cat /work/repo/src/index.ts"), true);
});

test("refuses options that run programs or write through allowed commands", () => {
  assert.equal(allowed("find . -name '*.ts' -exec rm {} ;"), false);
  assert.equal(allowed("find . -delete"), false);
  assert.equal(allowed("rg --pre ./script foo"), false);
  assert.equal(allowed("git diff --output=x.patch"), false);
  assert.equal(allowed("git fetch --upload-pack=evil origin"), false);
  assert.equal(allowed("gh api -X POST repos/a/b/issues"), false);
  assert.equal(allowed("glab api -f body=hi projects/1/notes"), false);
  assert.equal(allowed("gh api repos/a/b/pulls/1"), true);
});

test("explains the refusal", () => {
  const verdict = checkCommand("npm publish", ALLOW, ROOT);

  assert.equal(verdict.allowed, false);
  assert.match(
    verdict.allowed ? "" : verdict.reason,
    /`npm publish` is not an allowed command/,
  );
});
