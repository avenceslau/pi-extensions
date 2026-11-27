import assert from "node:assert/strict";
import test from "node:test";
import type { Note, Thread } from "../forges/types.ts";
import { awaitsReply } from "./pull-requests.ts";

function note(author: string, createdAt: string): Note {
  return {
    id: `${author}-${createdAt}`,
    author,
    authorIsBot: false,
    body: "text",
    createdAt,
  };
}

function thread(fields: Partial<Thread>, notes: Note[]): Thread {
  return {
    id: notes[0]?.id ?? "thread",
    resolvable: true,
    resolved: false,
    notes,
    ...fields,
  };
}

test("an unresolved review thread where a reviewer spoke last awaits a reply", () => {
  assert.equal(
    awaitsReply([thread({}, [note("reviewer", "2026-11-01T00:00:00Z")])], "me"),
    true,
  );
  assert.equal(
    awaitsReply(
      [
        thread({}, [
          note("reviewer", "2026-11-01T00:00:00Z"),
          note("me", "2026-11-02T00:00:00Z"),
        ]),
      ],
      "me",
    ),
    false,
  );
  assert.equal(
    awaitsReply(
      [thread({ resolved: true }, [note("reviewer", "2026-11-01T00:00:00Z")])],
      "me",
    ),
    false,
  );
});

test("a plain comment awaits a reply until the user writes anything newer", () => {
  const comment = thread({ resolvable: false }, [
    note("reviewer", "2026-11-02T00:00:00Z"),
  ]);

  assert.equal(awaitsReply([comment], "me"), true);
  assert.equal(
    awaitsReply(
      [
        comment,
        thread({ resolvable: false }, [note("me", "2026-11-03T00:00:00Z")]),
      ],
      "me",
    ),
    false,
  );
});
