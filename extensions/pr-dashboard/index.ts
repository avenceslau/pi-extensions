import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../shared/config.ts";
import { targetForRemote } from "../pr/index.ts";
import {
  reviewsFromJson,
  type Review,
  type ReviewForge,
  type ReviewState,
} from "./reviews.ts";

const REMOTE_TIMEOUT_MS = 5_000;
const REVIEW_TIMEOUT_MS = 30_000;
const REVIEW_LIMIT_COUNT = 100;
const MAX_VISIBLE_REVIEWS = 10;
const SELECTED_REVIEW_OFFSET = 5;

interface ReviewTarget {
  forge: ReviewForge;
  repository: string;
}

class ReviewList {
  private filter: ReviewState | "all" = "all";
  private selected = 0;

  constructor(
    private readonly reviews: Review[],
    private readonly theme: Theme,
    private readonly onOpen: (review: Review) => void,
    private readonly close: () => void,
  ) {}

  render(width: number): string[] {
    const filteredReviews = this.filteredReviews();
    const start = Math.max(
      0,
      Math.min(
        this.selected - SELECTED_REVIEW_OFFSET,
        filteredReviews.length - MAX_VISIBLE_REVIEWS,
      ),
    );
    const visibleReviews = filteredReviews.slice(
      start,
      start + MAX_VISIBLE_REVIEWS,
    );
    const lines = [
      truncateToWidth(
        this.theme.fg("accent", "Pull requests / merge requests"),
        width,
      ),
      truncateToWidth(
        this.theme.fg(
          "dim",
          "a all  o open  m merged  c closed  enter open  esc close",
        ),
        width,
      ),
      "",
    ];

    if (filteredReviews.length === 0) {
      lines.push(this.theme.fg("muted", "No reviews match this filter."));
    }

    for (const [index, review] of visibleReviews.entries()) {
      const selected = start + index === this.selected;
      const marker = selected ? "> " : "  ";
      const label = `${marker}#${review.number} [${review.state}] ${review.title} — ${review.branch}`;
      const color = review.state === "open" ? "success" : "muted";
      lines.push(
        truncateToWidth(
          selected
            ? this.theme.fg("accent", label)
            : this.theme.fg(color, label),
          width,
        ),
      );
    }

    return lines;
  }

  handleInput(keyData: string): void {
    if (matchesKey(keyData, "escape")) {
      this.close();
      return;
    }

    if (matchesKey(keyData, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }

    if (matchesKey(keyData, "down")) {
      this.selected = Math.min(
        this.filteredReviews().length - 1,
        this.selected + 1,
      );
      return;
    }

    if (matchesKey(keyData, "enter")) {
      const review = this.filteredReviews()[this.selected];
      if (review) {
        this.onOpen(review);
      }

      return;
    }

    const filters: Record<string, ReviewState | "all"> = {
      a: "all",
      o: "open",
      m: "merged",
      c: "closed",
    };
    const filter = filters[keyData];

    if (filter) {
      this.filter = filter;
      this.selected = 0;
    }
  }

  private filteredReviews(): Review[] {
    if (this.filter === "all") {
      return this.reviews;
    }

    return this.reviews.filter((review) => review.state === this.filter);
  }
}

async function findReviewTarget(
  pi: ExtensionAPI,
  cwd: string,
): Promise<ReviewTarget | undefined> {
  const remotes = await pi.exec("git", ["remote"], {
    cwd,
    timeout: REMOTE_TIMEOUT_MS,
  });
  const remoteNames = remotes.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  const candidates = ["origin", ...remoteNames].filter(
    (name, index, names) => names.indexOf(name) === index,
  );
  const forges = loadConfig(pi).forges ?? {};

  for (const remoteName of candidates) {
    const remote = await pi.exec("git", ["remote", "get-url", remoteName], {
      cwd,
      timeout: REMOTE_TIMEOUT_MS,
    });

    if (remote.code !== 0) {
      continue;
    }

    const target = targetForRemote(remote.stdout.trim(), forges);
    if (target) {
      return target;
    }
  }
}

async function listReviews(
  pi: ExtensionAPI,
  cwd: string,
  target: ReviewTarget,
): Promise<Review[] | string> {
  const command = target.forge === "github" ? "gh" : "glab";
  const args =
    target.forge === "github"
      ? [
          "pr",
          "list",
          "--state",
          "all",
          "--limit",
          String(REVIEW_LIMIT_COUNT),
          "--json",
          "number,title,state,url,headRefName,mergedAt",
          "--repo",
          target.repository,
        ]
      : [
          "mr",
          "list",
          "--all",
          "--per-page",
          String(REVIEW_LIMIT_COUNT),
          "--output",
          "json",
          "--repo",
          target.repository,
        ];

  try {
    const listing = await pi.exec(command, args, {
      cwd,
      timeout: REVIEW_TIMEOUT_MS,
    });

    if (listing.code !== 0 || listing.killed) {
      return listing.stderr.trim() || `${command} could not list reviews`;
    }

    return (
      reviewsFromJson(target.forge, listing.stdout) ??
      `${command} returned invalid review data`
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function openReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  target: ReviewTarget,
  review: Review,
): Promise<void> {
  const command = target.forge === "github" ? "gh" : "glab";
  const args =
    target.forge === "github"
      ? [
          "pr",
          "view",
          String(review.number),
          "--web",
          "--repo",
          target.repository,
        ]
      : [
          "mr",
          "view",
          String(review.number),
          "--web",
          "--repo",
          target.repository,
        ];

  try {
    const opened = await pi.exec(command, args, {
      cwd: ctx.cwd,
      timeout: REVIEW_TIMEOUT_MS,
    });

    if (opened.code !== 0) {
      ctx.ui.notify(
        opened.stderr.trim() || "Could not open the review",
        "warning",
      );
    }
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}

async function showReviewList(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  target: ReviewTarget,
  reviews: Review[],
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const reviewList = new ReviewList(
        reviews,
        theme,
        (review) => {
          void openReview(pi, ctx, target, review);
        },
        () => done(undefined),
      );

      return {
        render: (width: number) => reviewList.render(width),
        handleInput: (keyData: string) => {
          reviewList.handleInput(keyData);
          tui.requestRender();
        },
        invalidate: () => {},
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        maxHeight: "80%",
        margin: 1,
      },
    },
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prs", {
    description: "Show this repository's pull requests and merge requests",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/prs requires Pi's TUI mode", "warning");
        return;
      }

      const target = await findReviewTarget(pi, ctx.cwd);
      if (!target) {
        ctx.ui.notify("No supported GitHub or GitLab remote found", "warning");
        return;
      }

      ctx.ui.setStatus("pr-list", "Loading reviews…");

      try {
        const reviews = await listReviews(pi, ctx.cwd, target);
        if (typeof reviews === "string") {
          ctx.ui.notify(`Could not load reviews: ${reviews}`, "error");
          return;
        }

        await showReviewList(pi, ctx, target, reviews);
      } finally {
        ctx.ui.setStatus("pr-list", undefined);
      }
    },
  });
}
