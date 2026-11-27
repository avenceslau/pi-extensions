import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repository } from "./definition.ts";
import { errorCode, errorMessage } from "./errors.ts";
import {
  parseOpenedReviewLine,
  type OpenedReviewLine,
} from "./guard/policy.ts";
import { runReviewOpenedCommand } from "./review-opened.ts";
import type { OpenedReview, TabRecord } from "./state.ts";
import type { TickContext } from "./tick.ts";

const REVIEWS_SUFFIX = ".reviews.json";
const REVIEW_NUMBER = /\/(?:merge_requests|pull)\/(\d+)/;
const REVIEW_FOLLOW_UP_ATTEMPTS = 5;

// One JSON object per line; a missing file means the run opened nothing.
function readOpenedReviews(path: string): OpenedReviewLine[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const review = parseOpenedReviewLine(line);

        return review ? [review] : [];
      });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function reviewRepository(
  context: TickContext,
  url: string,
): { repository: Repository; number: number } | undefined {
  const repository = [...context.repositoryByUrl.values()].find((candidate) =>
    url.startsWith(`${candidate.forge.url}/`),
  );

  const number = Number(REVIEW_NUMBER.exec(url)?.[1]);

  return repository && Number.isInteger(number)
    ? { repository, number }
    : undefined;
}

// Runs reviewOpenedCommand once, with the review's current title from the forge.
async function announce(
  context: TickContext,
  review: OpenedReview,
  title: string,
): Promise<void> {
  const command = context.agentConfig.reviewOpenedCommand;
  const attempts = review.announceFailures ?? 0;

  if (!command || review.announced || attempts >= REVIEW_FOLLOW_UP_ATTEMPTS) {
    return;
  }

  try {
    await runReviewOpenedCommand(command, context.definition.name, {
      title,
      url: review.url,
    });
    review.announced = true;
    context.log(`ran reviewOpenedCommand for ${review.url}`);
  } catch (error) {
    review.announceFailures = attempts + 1;
    context.log(
      `reviewOpenedCommand failed for ${review.url} (attempt ${attempts + 1}): ${errorMessage(error)}`,
    );
  }
}

// Turns on auto-merge once the review has a pipeline.
async function turnOnAutoMerge(
  context: TickContext,
  review: OpenedReview,
  repository: Repository,
  number: number,
): Promise<void> {
  const attempts = review.autoMergeFailures ?? 0;
  const confirmedWithAutoMerge = review.title !== undefined;

  if (
    review.autoMerge ||
    !confirmedWithAutoMerge ||
    attempts >= REVIEW_FOLLOW_UP_ATTEMPTS
  ) {
    return;
  }

  try {
    if ((await repository.forge.enableAutoMerge(number)) === "enabled") {
      review.autoMerge = "enabled";
      context.log(`turned on auto-merge for ${review.url}`);
    }
  } catch (error) {
    review.autoMergeFailures = attempts + 1;
    context.log(
      `could not turn on auto-merge for ${review.url} (attempt ${attempts + 1}): ${errorMessage(error)}`,
    );
  }
}

// The tab's known reviews plus any its runs opened since the last tick.
function tabReviews(context: TickContext, tab: TabRecord): OpenedReview[] {
  const known = new Map(
    (tab.openedReviews ?? []).map((review) => [review.url, review]),
  );

  const written = tab.runIds.flatMap((runId) =>
    readOpenedReviews(join(context.runsDirectory, `${runId}${REVIEWS_SUFFIX}`)),
  );

  for (const { url, title } of written) {
    if (!known.has(url)) {
      known.set(url, {
        url,
        title,
        open: true,
      });
    }
  }

  return [...known.values()];
}

// Records whether each review the tabs' runs opened is still open, and runs reviewOpenedCommand and turns on auto-merge for new ones.
export async function followOpenedReviews(context: TickContext): Promise<void> {
  for (const tab of Object.values(context.state.tabs)) {
    tab.openedReviews = tabReviews(context, tab);

    for (const review of tab.openedReviews) {
      const target = review.open
        ? reviewRepository(context, review.url)
        : undefined;

      if (!target) {
        continue;
      }

      const open = await target.repository.forge.openPullRequests();
      const pull = open.find((candidate) => candidate.number === target.number);

      review.open = pull !== undefined;

      if (pull) {
        await announce(context, review, pull.title);
        await turnOnAutoMerge(
          context,
          review,
          target.repository,
          target.number,
        );
      }
    }
  }
}
