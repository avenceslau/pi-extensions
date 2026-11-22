import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Forge } from "../shared/config.ts";
import { countLines, git, shellQuote } from "./git.ts";
import type { RepoChange } from "./tracking.ts";

const execFileAsync = promisify(execFile);

const GITHUB_PR = /https?:\/\/([^\s/]+)\/([^\s/]+\/[^\s/]+)\/pull\/(\d+)/g;
const GITLAB_MR = /https?:\/\/([^\s/]+)\/(\S+?)\/-\/merge_requests\/(\d+)/g;

const PR_PATTERNS = [
  {
    pattern: GITHUB_PR,
    forge: "github",
  },
  {
    pattern: GITLAB_MR,
    forge: "gitlab",
  },
] as const;

const DEFAULT_FORGES: Record<string, Forge> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
};

const PROJECT_SEGMENT = /^(?!\.+$)[\w.-]+$/;
const MAX_STACK_FRAMES = 10;
const PR_REPO_CACHE = join(
  homedir(),
  ".cache",
  "pi-post-change-audit",
  "repos",
);
const PR_CLONE_TIMEOUT_MS = 600_000;
const FORGE_TIMEOUT_MS = 30_000;

const GitHubPullSchema = Type.Object({
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  user: Type.Object({ login: Type.String() }),
  state: Type.String(),
  base: Type.Object({ ref: Type.String() }),
  head: Type.Object({ ref: Type.String() }),
});

const GitHubPullListSchema = Type.Array(
  Type.Object({
    number: Type.Number(),
    title: Type.String(),
    html_url: Type.String(),
    base: Type.Object({ ref: Type.String() }),
    head: Type.Object({ ref: Type.String() }),
  }),
);

const GitHubRepoSchema = Type.Object({ default_branch: Type.String() });
const GitHubUserSchema = Type.Object({ login: Type.String() });

const GitLabMergeRequestSchema = Type.Object({
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  author: Type.Object({ username: Type.String() }),
  state: Type.String(),
  source_branch: Type.String(),
  target_branch: Type.String(),
});

const GitLabMergeRequestListSchema = Type.Array(
  Type.Object({
    iid: Type.Number(),
    title: Type.String(),
    web_url: Type.String(),
    source_branch: Type.String(),
    target_branch: Type.String(),
  }),
);

const GitLabProjectSchema = Type.Object({ default_branch: Type.String() });
const GitLabUserSchema = Type.Object({ username: Type.String() });

export interface PullRequest {
  url: string;
  forge: "github" | "gitlab";
  host: string;
  project: string;
  number: string;
}

export interface PullRequestInfo {
  mine: boolean;
  open: boolean;
  author: string;
  title: string;
  description: string;
  baseBranch: string;
  sourceBranch: string;
  cloneUrl: string;
}

export interface StackFrame {
  pr: PullRequest;
  title: string;
  source: string;
  target: string;
}

export interface PullRequestCheckout {
  repo: string;
  path: string;
  change: RepoChange;
  // The head commit of each stack frame, bottom first.
  heads: string[];
  mergeBase: string;
}

// Host and project become credentialed forge calls and cache paths, so both are allow-listed: the host must be
// github.com, gitlab.com, or a host the config's forges name for the link's forge.
export function linkedPullRequests(
  text: string,
  forges: Record<string, Forge>,
): PullRequest[] {
  const found = PR_PATTERNS.flatMap(({ pattern, forge }) => {
    return [...text.matchAll(pattern)].flatMap((match) => {
      const [url, host, project, number] = match;

      if (
        !host ||
        !project ||
        !number ||
        (forges[host] ?? DEFAULT_FORGES[host]) !== forge ||
        !project.split("/").every((segment) => PROJECT_SEGMENT.test(segment))
      ) {
        return [];
      }

      const pr: PullRequest = {
        url,
        forge,
        host,
        project,
        number,
      };

      return [{ index: match.index, pr }];
    });
  });

  found.sort((a, b) => a.index - b.index);

  // The same review is often linked more than once, for example as both its overview and its diff tab.
  const unique = new Map(found.map(({ pr }) => [pr.url, pr]));

  return [...unique.values()];
}

async function forgeApi(
  command: "gh" | "glab",
  host: string,
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    command,
    ["api", "--hostname", host, path],
    {
      signal,
      timeout: FORGE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  return JSON.parse(stdout);
}

export async function pullRequestInfo(
  pr: PullRequest,
  signal: AbortSignal,
): Promise<PullRequestInfo> {
  if (pr.forge === "github") {
    const [pull, user] = await Promise.all([
      forgeApi("gh", pr.host, `repos/${pr.project}/pulls/${pr.number}`, signal),
      forgeApi("gh", pr.host, "user", signal),
    ]);

    const {
      title,
      body,
      user: author,
      state,
      base,
      head,
    } = Value.Parse(GitHubPullSchema, pull);

    return {
      mine: author.login === Value.Parse(GitHubUserSchema, user).login,
      open: state === "open",
      author: author.login,
      title,
      description: body ?? "",
      baseBranch: base.ref,
      sourceBranch: head.ref,
      cloneUrl: `https://${pr.host}/${pr.project}.git`,
    };
  }

  const [mergeRequest, user] = await Promise.all([
    forgeApi(
      "glab",
      pr.host,
      `projects/${encodeURIComponent(pr.project)}/merge_requests/${pr.number}`,
      signal,
    ),
    forgeApi("glab", pr.host, "user", signal),
  ]);

  const { title, description, author, state, source_branch, target_branch } =
    Value.Parse(GitLabMergeRequestSchema, mergeRequest);

  return {
    mine: author.username === Value.Parse(GitLabUserSchema, user).username,
    open: state === "opened",
    author: author.username,
    title,
    description: description ?? "",
    baseBranch: target_branch,
    sourceBranch: source_branch,
    cloneUrl: `git@${pr.host}:${pr.project}.git`,
  };
}

function forgeHeadRef(pr: PullRequest): string {
  return pr.forge === "github"
    ? `refs/pull/${pr.number}/head`
    : `refs/merge-requests/${pr.number}/head`;
}

async function forgeDefaultBranch(
  pr: PullRequest,
  signal: AbortSignal,
): Promise<string> {
  if (pr.forge === "github") {
    const repo = await forgeApi("gh", pr.host, `repos/${pr.project}`, signal);

    return Value.Parse(GitHubRepoSchema, repo).default_branch;
  }

  const project = await forgeApi(
    "glab",
    pr.host,
    `projects/${encodeURIComponent(pr.project)}`,
    signal,
  );

  return Value.Parse(GitLabProjectSchema, project).default_branch;
}

async function openReviews(
  pr: PullRequest,
  branches: { source?: string; target?: string },
  signal: AbortSignal,
): Promise<StackFrame[]> {
  if (pr.forge === "github") {
    const query = new URLSearchParams({ state: "open" });

    if (branches.source) {
      query.set("head", `${pr.project.split("/")[0]}:${branches.source}`);
    }

    if (branches.target) {
      query.set("base", branches.target);
    }

    const pulls = await forgeApi(
      "gh",
      pr.host,
      `repos/${pr.project}/pulls?${query}`,
      signal,
    );

    return Value.Parse(GitHubPullListSchema, pulls).map((pull) => {
      return {
        pr: {
          ...pr,
          url: pull.html_url,
          number: String(pull.number),
        },
        title: pull.title,
        source: pull.head.ref,
        target: pull.base.ref,
      };
    });
  }

  const query = new URLSearchParams({ state: "opened" });

  if (branches.source) {
    query.set("source_branch", branches.source);
  }

  if (branches.target) {
    query.set("target_branch", branches.target);
  }

  const mergeRequests = await forgeApi(
    "glab",
    pr.host,
    `projects/${encodeURIComponent(pr.project)}/merge_requests?${query}`,
    signal,
  );

  return Value.Parse(GitLabMergeRequestListSchema, mergeRequests).map(
    (mergeRequest) => {
      return {
        pr: {
          ...pr,
          url: mergeRequest.web_url,
          number: String(mergeRequest.iid),
        },
        title: mergeRequest.title,
        source: mergeRequest.source_branch,
        target: mergeRequest.target_branch,
      };
    },
  );
}

async function soleOpenReview(
  pr: PullRequest,
  branches: { source?: string; target?: string },
  signal: AbortSignal,
): Promise<StackFrame | undefined> {
  const reviews = await openReviews(pr, branches, signal);

  return reviews.length === 1 ? reviews[0] : undefined;
}

// Walks open reviews down to the default branch and up through reviews based on this one, bottom first.
// A branch with no open review, or with more than one, ends the walk in that direction.
export async function pullRequestStack(
  pr: PullRequest,
  info: PullRequestInfo,
  signal: AbortSignal,
): Promise<StackFrame[]> {
  const linked: StackFrame = {
    pr,
    title: info.title,
    source: info.sourceBranch,
    target: info.baseBranch,
  };

  const frames = [linked];

  if (!info.open) {
    return frames;
  }

  const defaultBranch = await forgeDefaultBranch(pr, signal);
  let bottom = linked;

  while (frames.length < MAX_STACK_FRAMES && bottom.target !== defaultBranch) {
    const parent = await soleOpenReview(pr, { source: bottom.target }, signal);

    if (!parent) {
      break;
    }

    frames.unshift(parent);
    bottom = parent;
  }

  let top = linked;

  while (frames.length < MAX_STACK_FRAMES) {
    const child = await soleOpenReview(pr, { target: top.source }, signal);

    if (!child) {
      break;
    }

    frames.push(child);
    top = child;
  }

  return frames;
}

// A cached blobless bare clone keeps repeat reviews cheap; each review gets its own detached worktree.
export async function checkoutPullRequest(
  pr: PullRequest,
  info: PullRequestInfo,
  frames: StackFrame[],
  signal: AbortSignal,
): Promise<PullRequestCheckout> {
  const repo = join(PR_REPO_CACHE, pr.host, `${pr.project}.git`);

  if (!existsSync(repo)) {
    // Cloning beside the cache and renaming it in means the cache path only ever holds a finished clone,
    // even when concurrent reviews of the same repository race to create it.
    const staging = `${repo}.${randomUUID()}`;

    try {
      await execFileAsync(
        "git",
        [
          "clone",
          "--bare",
          "--quiet",
          "--filter=blob:none",
          info.cloneUrl,
          staging,
        ],
        {
          signal,
          timeout: PR_CLONE_TIMEOUT_MS,
        },
      );
      await rename(staging, repo);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });

      if (!existsSync(repo)) {
        throw error;
      }
    }
  }

  // The bottom frame targets the default branch in a complete stack, and the leaf holds every frame's changes.
  const baseBranch = frames[0]?.target ?? info.baseBranch;
  const headRefs = frames.map(
    (frame) => `refs/pr-review/${frame.pr.number}/head`,
  );
  const baseRef = `refs/pr-review/${pr.number}/base`;
  const refspecs = frames.map(
    (frame, i) => `+${forgeHeadRef(frame.pr)}:${headRefs[i]}`,
  );
  await git(
    repo,
    [
      "fetch",
      "--quiet",
      "origin",
      ...refspecs,
      `+refs/heads/${baseBranch}:${baseRef}`,
    ],
    { signal },
  );
  const heads = await Promise.all(
    headRefs.map((ref) => git(repo, ["rev-parse", ref], { signal })),
  );
  const head = heads.at(-1);

  if (!head) {
    throw new Error(`${pr.url} has no stack frames to check out`);
  }

  const mergeBase = await git(repo, ["merge-base", head, baseRef], { signal });
  const base = await git(repo, ["rev-parse", `${mergeBase}^{tree}`], {
    signal,
  });
  const current = await git(repo, ["rev-parse", `${head}^{tree}`], { signal });

  const path = join(tmpdir(), `pi-pr-review-${randomUUID()}`);
  await git(repo, ["worktree", "add", "--detach", "--quiet", path, head], {
    signal,
  });

  try {
    return {
      repo,
      path,
      heads,
      mergeBase,
      change: {
        root: path,
        base,
        baseDescription: `${mergeBase}, the merge base of the head and ${baseBranch}`,
        current,
        paths: [],
        formatters: [],
        files: await git(path, ["diff", "--name-status", base, current], {
          signal,
        }),
        lines: countLines(
          await git(path, ["diff", "--numstat", base, current], { signal }),
        ),
      },
    };
  } catch (error) {
    await git(repo, ["worktree", "remove", "--force", path]);
    throw error;
  }
}

function stackSection(
  frames: StackFrame[],
  checkout: PullRequestCheckout,
): string {
  const rows = frames.map((frame, i) => {
    const parent = i === 0 ? checkout.mergeBase : checkout.heads[i - 1];

    return `Frame ${i + 1}: ${frame.pr.url} "${frame.title}": git -C ${shellQuote(checkout.path)} diff ${parent} ${checkout.heads[i]}`;
  });

  return [
    `This review covers a stack of ${frames.length} reviews, bottom first, checked out at the top one. Review the whole stack once, and set frame on every finding to the number of the frame that introduced it.`,
    ...rows,
  ].join("\n");
}

export function pullRequestIntro(
  pr: PullRequest,
  info: PullRequestInfo,
  request: string,
  frames: StackFrame[],
  checkout: PullRequestCheckout,
): string {
  const sections = [
    `Review ${pr.url}, "${info.title}" by ${info.author}. Someone else wrote it, so report back only: never edit the checkout under review, post comments, notes, or reviews to it, commit, or push.`,
    `The user asked:\n${request}`,
    `Description:\n${info.description || "(none)"}`,
  ];

  if (frames.length > 1) {
    sections.push(stackSection(frames, checkout));
  }

  return sections.join("\n\n");
}
