import assert from "node:assert/strict";
import test from "node:test";
import { reviewsFromJson } from "./reviews.ts";

test("GitHub merged timestamps distinguish merged from closed PRs", () => {
  const reviews = reviewsFromJson(
    "github",
    JSON.stringify([
      {
        number: 7,
        title: "Merged change",
        state: "CLOSED",
        url: "https://github.com/acme/app/pull/7",
        headRefName: "feature/merged",
        mergedAt: "2025-01-01T00:00:00Z",
      },
      {
        number: 8,
        title: "Closed change",
        state: "CLOSED",
        url: "https://github.com/acme/app/pull/8",
        headRefName: "feature/closed",
        mergedAt: null,
      },
    ]),
  );

  assert.deepEqual(
    reviews?.map((review) => review.state),
    ["merged", "closed"],
  );
});

test("GitLab opened, merged, and closed states are normalized", () => {
  const reviews = reviewsFromJson(
    "gitlab",
    JSON.stringify(
      ["opened", "merged", "closed"].map((state, index) => ({
        iid: index + 1,
        title: `Change ${state}`,
        state,
        web_url: `https://gitlab.com/acme/app/-/merge_requests/${index + 1}`,
        source_branch: `feature/${state}`,
      })),
    ),
  );

  assert.deepEqual(
    reviews?.map((review) => review.state),
    ["open", "merged", "closed"],
  );
});

test("invalid JSON is rejected and malformed items are skipped", () => {
  assert.equal(reviewsFromJson("github", "not json"), undefined);
  assert.deepEqual(reviewsFromJson("github", "[null, {}]"), []);
});
