import assert from "node:assert/strict";
import test from "node:test";
import type { Check } from "./definition.ts";
import { isDue } from "./schedule.ts";

const hourly: Check = {
  name: "hourly",
  everyMinutes: 60,
  workingHours: {
    from: 10,
    to: 19,
  },
  run: async () => ({ triggers: [] }),
};

test("runs a check that never ran, inside its working hours", () => {
  assert.equal(isDue(hourly, undefined, new Date(2026, 10, 25, 10, 0)), true);
  assert.equal(isDue(hourly, undefined, new Date(2026, 10, 25, 9, 59)), false);
  assert.equal(isDue(hourly, undefined, new Date(2026, 10, 25, 19, 0)), false);
});

test("skips weekends for checks with working hours", () => {
  assert.equal(isDue(hourly, undefined, new Date(2026, 10, 28, 12, 0)), false);
});

test("waits for the interval, allowing a tick that starts a minute early", () => {
  const lastRunAt = new Date(2026, 10, 25, 11, 0).toISOString();

  assert.equal(isDue(hourly, lastRunAt, new Date(2026, 10, 25, 11, 30)), false);
  assert.equal(isDue(hourly, lastRunAt, new Date(2026, 10, 25, 11, 59)), true);
});
