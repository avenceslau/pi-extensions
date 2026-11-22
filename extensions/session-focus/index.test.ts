import assert from "node:assert/strict";
import test from "node:test";
import { buildFocusDisplay } from "./index.ts";

const focus = {
  feature: "Rex integration",
  task: "Updating lifecycle status",
};

test("the Rex backend appends focus to the directory title", () => {
  assert.deepEqual(buildFocusDisplay("rex", "/Users/example/projects", focus), {
    title:
      "projects · Working on Rex integration | Doing Updating lifecycle status",
  });
});

test("the Pi backend keeps focus in the editor widget", () => {
  assert.deepEqual(buildFocusDisplay("pi", "/Users/example/projects", focus), {
    title: "projects",
    widget: "Working on Rex integration | Doing Updating lifecycle status",
  });
});

test("an empty focus keeps only the directory title", () => {
  assert.deepEqual(buildFocusDisplay("rex", "/Users/example/projects", {}), {
    title: "projects",
  });
});
