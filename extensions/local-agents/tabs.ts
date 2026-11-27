import type { RunStatusFile } from "./guard/policy.ts";
import type { AgentState, TabRecord } from "./state.ts";

// Marks each tab concern addressed or open again by what its check reported this tick.
export function updateConcerns(
  state: AgentState,
  openConcerns: Map<string, Set<string>>,
): void {
  for (const tab of Object.values(state.tabs)) {
    for (const concern of tab.concerns ?? []) {
      const open = openConcerns.get(concern.check);

      if (open) {
        concern.addressed = !open.has(concern.id);
      }
    }
  }
}

// A session that finished its task stays open for the user but is idle, so it does not hold the tab's worktree.
export function hasActiveRun(
  tab: TabRecord,
  runs: Map<string, RunStatusFile>,
): boolean {
  return tab.runIds.some((runId) => {
    const status = runs.get(runId)?.status;

    return status !== undefined && status !== "idle";
  });
}

// Every concern is addressed: its check no longer reports it, or the merge requests the tab's runs opened are all
// merged or closed. Tabs opened before concerns were tracked have none and are never addressed this way.
export function isAddressed(tab: TabRecord): boolean {
  const reviews = tab.openedReviews ?? [];

  const reviewsSettled =
    reviews.length > 0 && reviews.every((review) => !review.open);

  const concerns = tab.concerns ?? [];

  return (
    concerns.length > 0 &&
    !reviews.some((review) => review.open) &&
    concerns.every((concern) => concern.addressed || reviewsSettled)
  );
}

export function lastActivity(
  tab: TabRecord,
  runs: Map<string, RunStatusFile>,
): number {
  const times = [
    tab.lastActivityAt,
    ...tab.runIds.map((runId) => runs.get(runId)?.updatedAt),
  ].flatMap((time) => (time ? [Date.parse(time)] : []));

  return Math.max(0, ...times);
}
