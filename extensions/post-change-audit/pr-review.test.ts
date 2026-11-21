import assert from "node:assert/strict";
import test from "node:test";
import { linkedPullRequests } from "./pr-review.ts";

test("review links are accepted on default hosts and on configured hosts of the matching forge only", () => {
  const text = [
    "https://github.com/owner/repo/pull/1",
    "https://git.example.com/group/repo/-/merge_requests/2",
    "https://git.example.com/owner/repo/pull/3",
    "https://unknown.example.com/group/repo/-/merge_requests/4",
  ].join(" ");

  const linked = linkedPullRequests(text, { "git.example.com": "gitlab" });

  assert.deepEqual(
    linked.map((pr) => `${pr.forge} ${pr.host} ${pr.number}`),
    ["github github.com 1", "gitlab git.example.com 2"],
  );
});
