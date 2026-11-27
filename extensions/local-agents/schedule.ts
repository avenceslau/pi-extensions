import type { Check } from "./definition.ts";

const MINUTE_MS = 60_000;

// Date.getDay() numbers.
const MONDAY = 1;
const FRIDAY = 5;

// launchd starts a tick every few minutes and a tick can start a little early, so a check counts as due one minute
// before its interval has fully passed.
export function isDue(
  check: Check,
  lastRunAt: string | undefined,
  now: Date,
): boolean {
  if (check.workingHours) {
    const day = now.getDay();
    const hour = now.getHours();
    const weekday = day >= MONDAY && day <= FRIDAY;

    if (
      !weekday ||
      hour < check.workingHours.from ||
      hour >= check.workingHours.to
    ) {
      return false;
    }
  }

  if (!lastRunAt) {
    return true;
  }

  return (
    now.getTime() - Date.parse(lastRunAt) >=
    (check.everyMinutes - 1) * MINUTE_MS
  );
}
