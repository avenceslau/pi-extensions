import assert from "node:assert/strict";
import test from "node:test";
import type { AgentState, TabRecord } from "./state.ts";
import { isAddressed, updateConcerns } from "./tabs.ts";

function tab(fields: Partial<TabRecord>): TabRecord {
  return {
    key: "repo!1",
    label: "!1 - Title",
    windowId: "window",
    worktrees: [],
    runIds: [],
    ...fields,
  };
}

function state(record: TabRecord): AgentState {
  return {
    checks: {},
    handled: {},
    attempts: {},
    queue: [],
    tabs: { [record.key]: record },
  };
}

test("a concern its check stops reporting is addressed, and reopens when reported again", () => {
  const record = tab({
    concerns: [
      {
        check: "conflicts",
        id: "conflicts:repo!1",
        addressed: false,
      },
    ],
  });
  const agent = state(record);

  updateConcerns(agent, new Map([["conflicts", new Set<string>()]]));
  assert.equal(isAddressed(record), true);

  updateConcerns(
    agent,
    new Map([["conflicts", new Set(["conflicts:repo!1"])]]),
  );
  assert.equal(isAddressed(record), false);
});

test("a check that did not run leaves its concerns alone", () => {
  const record = tab({
    concerns: [
      {
        check: "comments",
        id: "comments:repo!1",
        addressed: false,
      },
    ],
  });

  updateConcerns(state(record), new Map([["conflicts", new Set<string>()]]));
  assert.equal(isAddressed(record), false);
});

test("concerns no check decides are addressed once the opened merge requests are merged or closed", () => {
  const concerns = [
    {
      check: "ci-speed",
      id: "ci-speed:repo:build",
      addressed: false,
    },
  ];

  assert.equal(isAddressed(tab({ concerns })), false);
  assert.equal(
    isAddressed(
      tab({
        concerns,
        openedReviews: [
          { url: "https://git/repo/-/merge_requests/9", open: true },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    isAddressed(
      tab({
        concerns,
        openedReviews: [
          { url: "https://git/repo/-/merge_requests/9", open: false },
        ],
      }),
    ),
    true,
  );
});

test("a tab from before concerns were tracked is never addressed", () => {
  assert.equal(isAddressed(tab({})), false);
});
