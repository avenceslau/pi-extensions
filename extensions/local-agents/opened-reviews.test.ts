import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Repository } from "./definition.ts";
import type { ForgeClient, PullRequest } from "./forges/types.ts";
import { followOpenedReviews } from "./opened-reviews.ts";
import type { OpenedReview, TabRecord } from "./state.ts";
import type { TickContext } from "./tick.ts";

const URL_7 = "https://git.example.com/group/repo/-/merge_requests/7";

function contextWith(
  reviewOpenedCommand: string[],
  reviews: OpenedReview[],
  autoMergeCalls: number[],
) {
  const pull: Pick<PullRequest, "number" | "title"> = {
    number: 7,
    title: "Current title",
  };

  const forgeMembers: Pick<
    ForgeClient,
    "url" | "openPullRequests" | "enableAutoMerge"
  > = {
    url: "https://git.example.com/group/repo",
    // SAFETY: followOpenedReviews reads only the number and title of a pull request.
    openPullRequests: async () => [pull as PullRequest],
    enableAutoMerge: async (number) => {
      autoMergeCalls.push(number);

      return "enabled";
    },
  };

  // SAFETY: followOpenedReviews uses only these members of the forge client.
  const forge = forgeMembers as ForgeClient;

  const repository: Repository = {
    url: "git.example.com/group/repo",
    path: "/work/repo",
    forge,
    commands: [],
    setup: [],
  };

  const tab: TabRecord = {
    key: "tab",
    label: "ci - build",
    windowId: "window",
    worktrees: [],
    runIds: [],
    openedReviews: reviews,
  };

  const context: TickContext = {
    definition: {
      name: "todai",
      checks: [],
      playbooks: {},
    },
    agentConfig: { reviewOpenedCommand },
    config: {},
    state: {
      checks: {},
      handled: {},
      attempts: {},
      queue: [],
      tabs: { tab },
    },
    repositoryByUrl: new Map([[repository.url, repository]]),
    runsDirectory: mkdtempSync(join(tmpdir(), "opened-reviews-")),
    now: new Date(),
    log: () => undefined,
  };

  return { context, tab };
}

test("a failing reviewOpenedCommand does not hold up auto-merge", async () => {
  const calls: number[] = [];

  const { context, tab } = contextWith(
    ["false"],
    [{ url: URL_7, title: "Opened title", open: true }],
    calls,
  );

  await followOpenedReviews(context);

  assert.deepEqual(calls, [7]);
  assert.equal(tab.openedReviews?.[0].autoMerge, "enabled");
  assert.equal(tab.openedReviews?.[0].announceFailures, 1);
});

test("the command gets the review's current title", async () => {
  const output = join(mkdtempSync(join(tmpdir(), "announce-")), "out");

  const { context } = contextWith(
    ["sh", "-c", `printf '%s' "$REVIEW_TITLE" > ${output}`],
    [{ url: URL_7, title: "Opened title", open: true }],
    [],
  );

  await followOpenedReviews(context);

  assert.equal(readFileSync(output, "utf8"), "Current title");
});

test("a review recorded without a title never gets auto-merge", async () => {
  const calls: number[] = [];

  const { context } = contextWith(
    ["true"],
    [{ url: URL_7, open: true }],
    calls,
  );

  await followOpenedReviews(context);

  assert.deepEqual(calls, []);
});
