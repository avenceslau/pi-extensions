import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge, RetryTarget, Review, ReviewStatus, WorktreeRecord } from "./types.ts";

interface RepositoryGroup {
  cwd: string;
  host: string;
  label: string;
  forge: Forge;
  worktrees: Map<string, string>;
}

interface DiscoveryResult {
  reviews: Review[];
  warnings: string[];
}

function shireiStatePath(): string {
  if (process.env.SHIREI_STATE_DIR) {
    return join(process.env.SHIREI_STATE_DIR, "state.json");
  }
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, "shirei", "state.json");
  }
  return join(homedir(), ".local", "share", "shirei", "state.json");
}

async function readWorktrees(): Promise<WorktreeRecord[]> {
  const parsed = JSON.parse(await readFile(shireiStatePath(), "utf8")) as {
    worktrees?: WorktreeRecord[];
  };

  return (parsed.worktrees ?? []).filter((worktree) => {
    return (
      typeof worktree.path === "string" &&
      typeof worktree.repo === "string" &&
      typeof worktree.branch === "string" &&
      worktree.branch !== "-" &&
      existsSync(worktree.path)
    );
  });
}

function remoteParts(remote: string): { host: string; path: string } | undefined {
  const ssh = remote.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) {
    return { host: ssh[1], path: ssh[2].replace(/\.git$/, "") };
  }

  try {
    const url = new URL(remote);
    return {
      host: url.host,
      path: url.pathname.replace(/^\//, "").replace(/\.git$/, ""),
    };
  } catch {
    return undefined;
  }
}

async function repositoryGroups(pi: ExtensionAPI): Promise<RepositoryGroup[]> {
  const byRepository = new Map<string, WorktreeRecord[]>();
  for (const worktree of await readWorktrees()) {
    const records = byRepository.get(worktree.repo) ?? [];
    records.push(worktree);
    byRepository.set(worktree.repo, records);
  }

  const repositories = await Promise.all(
    [...byRepository.entries()].map(async ([repository, worktrees]) => {
      const cwd = existsSync(repository) ? repository : worktrees[0].path;
      const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], {
        cwd,
        timeout: 10_000,
      });
      return remoteResult.code === 0
        ? { remote: remoteResult.stdout.trim(), worktrees }
        : undefined;
    }),
  );

  const groups = new Map<string, RepositoryGroup>();
  for (const repository of repositories) {
    if (!repository) {
      continue;
    }
    const parts = remoteParts(repository.remote);
    if (!parts) {
      continue;
    }

    const key = `${parts.host}/${parts.path}`;
    const existing = groups.get(key);
    if (existing) {
      for (const worktree of repository.worktrees) {
        existing.worktrees.set(worktree.branch, worktree.path);
      }
      continue;
    }

    groups.set(key, {
      cwd: repository.worktrees[0].path,
      host: parts.host,
      label: parts.path,
      forge: parts.host.toLowerCase().includes("github") ? "github" : "gitlab",
      worktrees: new Map(repository.worktrees.map((worktree) => [worktree.branch, worktree.path])),
    });
  }

  return [...groups.values()];
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function githubCheckStatus(checks: unknown[]): { status: ReviewStatus; summary: string } {
  if (checks.length === 0) {
    return { status: "waiting", summary: "no checks" };
  }

  const values = checks.map((check) => {
    const value = check as Record<string, unknown>;
    return String(value.conclusion ?? value.state ?? value.status ?? "").toUpperCase();
  });
  const failed = values.filter((value) => {
    return ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"].includes(value);
  }).length;
  if (failed > 0) {
    return { status: "actionable", summary: `${failed} failed check${failed === 1 ? "" : "s"}` };
  }

  const pending = values.filter((value) => {
    return ["PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"].includes(value);
  }).length;
  if (pending > 0) {
    return { status: "waiting", summary: `${pending} check${pending === 1 ? "" : "s"} running` };
  }

  return { status: "ready", summary: "checks passing" };
}

async function listGitHubReviews(
  pi: ExtensionAPI,
  group: RepositoryGroup,
): Promise<{ reviews: Review[]; warning?: string }> {
  const result = await pi.exec(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,headRefName,headRefOid,baseRefName,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup",
    ],
    { cwd: group.cwd, timeout: 30_000 },
  );
  if (result.code !== 0) {
    return { reviews: [], warning: result.stderr.trim() || `Unable to list ${group.label} pull requests` };
  }

  const rows = parseJson<Array<Record<string, unknown>>>(result.stdout) ?? [];
  const reviews: Review[] = [];
  for (const row of rows) {
    const branch = String(row.headRefName ?? "");
    const worktree = group.worktrees.get(branch);
    if (!worktree) {
      continue;
    }

    const checks = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : [];
    let status = githubCheckStatus(checks);
    if (String(row.mergeStateStatus).toUpperCase() === "DIRTY") {
      status = { status: "actionable", summary: "merge conflict" };
    } else if (String(row.reviewDecision).toUpperCase() === "CHANGES_REQUESTED") {
      status = { status: "actionable", summary: "changes requested" };
    } else if (row.isDraft === true) {
      status = { status: "waiting", summary: "draft" };
    }

    const number = Number(row.number);
    reviews.push({
      key: `${group.host}/${group.label}#${number}`,
      forge: "github",
      number,
      title: String(row.title ?? ""),
      url: String(row.url ?? ""),
      headBranch: branch,
      headSha: String(row.headRefOid ?? ""),
      baseBranch: String(row.baseRefName ?? "main"),
      worktree,
      repository: `${group.host}/${group.label}`,
      status: status.status,
      summary: status.summary,
      draft: row.isDraft === true,
    });
  }

  return { reviews };
}

async function gitLabPipelineStatus(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
): Promise<{ status: ReviewStatus; summary: string } | undefined> {
  const result = await pi.exec("glab", ["ci", "status", "--branch", branch, "--output", "json"], {
    cwd,
    timeout: 30_000,
  });
  const value = parseJson<{ jobs?: Array<Record<string, unknown>>; pipeline?: Record<string, unknown> }>(
    result.stdout,
  );
  if (!value?.pipeline) {
    return undefined;
  }

  const jobs = value.jobs ?? [];
  const failed = jobs.filter((job) => {
    return ["failed", "canceled"].includes(String(job.status));
  }).length;
  if (failed > 0) {
    return { status: "actionable", summary: `${failed} failed job${failed === 1 ? "" : "s"}` };
  }

  const pending = jobs.filter((job) => {
    return ["created", "pending", "running", "waiting_for_resource", "preparing"].includes(String(job.status));
  }).length;
  if (pending > 0) {
    return { status: "waiting", summary: `${pending} job${pending === 1 ? "" : "s"} running` };
  }

  return String(value.pipeline.status) === "success"
    ? { status: "ready", summary: "pipeline passing" }
    : { status: "waiting", summary: `pipeline ${String(value.pipeline.status)}` };
}

async function listGitLabReviews(
  pi: ExtensionAPI,
  group: RepositoryGroup,
  detailedReviews: ReadonlySet<string>,
): Promise<{ reviews: Review[]; warning?: string }> {
  const result = await pi.exec("glab", ["mr", "list", "--output", "json", "--per-page", "100"], {
    cwd: group.cwd,
    timeout: 30_000,
  });
  if (result.code !== 0) {
    return { reviews: [], warning: result.stderr.trim() || `Unable to list ${group.label} merge requests` };
  }

  const rows = parseJson<Array<Record<string, unknown>>>(result.stdout) ?? [];
  const matched = rows.filter((row) => group.worktrees.has(String(row.source_branch ?? "")));
  const reviews = await Promise.all(
    matched.map(async (row): Promise<Review> => {
      const branch = String(row.source_branch ?? "");
      const worktree = group.worktrees.get(branch)!;
      const number = Number(row.iid);
      const key = `${group.host}/${group.label}!${number}`;
      let status = detailedReviews.has(key)
        ? await gitLabPipelineStatus(pi, worktree, branch)
        : undefined;
      if (row.has_conflicts === true) {
        status = { status: "actionable", summary: "merge conflict" };
      } else if (row.blocking_discussions_resolved === false) {
        status = { status: "actionable", summary: "unresolved discussions" };
      } else if (row.draft === true) {
        status = { status: "waiting", summary: "draft" };
      }
      status ??= { status: "waiting", summary: "pipeline unavailable" };

      return {
        key,
        forge: "gitlab",
        number,
        title: String(row.title ?? ""),
        url: String(row.web_url ?? ""),
        headBranch: branch,
        headSha: String(row.sha ?? ""),
        baseBranch: String(row.target_branch ?? "main"),
        worktree,
        repository: `${group.host}/${group.label}`,
        status: status.status,
        summary: status.summary,
        draft: row.draft === true,
      };
    }),
  );

  return { reviews };
}

export async function discoverReviews(
  pi: ExtensionAPI,
  detailedReviews: ReadonlySet<string> = new Set(),
): Promise<DiscoveryResult> {
  const groups = await repositoryGroups(pi);
  const results = await Promise.all(
    groups.map((group) => {
      return group.forge === "github"
        ? listGitHubReviews(pi, group)
        : listGitLabReviews(pi, group, detailedReviews);
    }),
  );

  return {
    reviews: results.flatMap((result) => result.reviews).sort((a, b) => a.key.localeCompare(b.key)),
    warnings: results.flatMap((result) => (result.warning ? [result.warning] : [])),
  };
}

export async function worktreeFingerprint(pi: ExtensionAPI, cwd: string): Promise<string> {
  const [head, status, unstaged, staged, untracked] = await Promise.all([
    pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 }),
    pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, timeout: 10_000 }),
    pi.exec("git", ["diff", "--binary", "HEAD"], { cwd, timeout: 10_000 }),
    pi.exec("git", ["diff", "--binary", "--cached", "HEAD"], { cwd, timeout: 10_000 }),
    pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, timeout: 10_000 }),
  ]);
  const failed = [head, status, unstaged, staged, untracked].find((result) => result.code !== 0);
  if (failed) {
    throw new Error(failed.stderr.trim() || `Unable to inspect worktree ${cwd}`);
  }

  const hash = createHash("sha256");
  hash.update([head.stdout.trim(), status.stdout, unstaged.stdout, staged.stdout].join("\n---\n"));
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    hash.update(path);
    hash.update(await readFile(join(cwd, path)));
  }
  return hash.digest("hex");
}

export async function cleanWorktree(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const result = await pi.exec("git", ["status", "--porcelain=v1"], { cwd, timeout: 10_000 });
  return result.code === 0 && result.stdout.trim().length === 0;
}

export async function worktreeBlockedReason(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | undefined> {
  const unmerged = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd,
    timeout: 10_000,
  });
  const hasUnmerged = unmerged.stdout.trim().length > 0;

  const operations = [
    ["rebase-merge", "rebase in progress"],
    ["rebase-apply", "rebase in progress"],
    ["MERGE_HEAD", "merge in progress"],
    ["CHERRY_PICK_HEAD", "cherry-pick in progress"],
  ] as const;
  for (const [gitPath, reason] of operations) {
    const result = await pi.exec("git", ["rev-parse", "--git-path", gitPath], {
      cwd,
      timeout: 10_000,
    });
    const path = result.stdout.trim();
    if (result.code === 0 && path && existsSync(isAbsolute(path) ? path : resolve(cwd, path))) {
      return hasUnmerged ? `${reason} with unresolved conflicts` : reason;
    }
  }
  return hasUnmerged ? "unresolved merge conflicts" : undefined;
}

export async function currentHead(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Unable to read HEAD in ${cwd}`);
  }
  return result.stdout.trim();
}

export async function retryTargets(pi: ExtensionAPI, review: Review): Promise<RetryTarget[]> {
  if (review.forge === "github") {
    const result = await pi.exec(
      "gh",
      [
        "run",
        "list",
        "--branch",
        review.headBranch,
        "--commit",
        review.headSha,
        "--limit",
        "50",
        "--json",
        "databaseId,headSha,name,status,conclusion,url,workflowName",
      ],
      { cwd: review.worktree, timeout: 30_000 },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Unable to list GitHub workflow runs");
    }

    const rows = parseJson<Array<Record<string, unknown>>>(result.stdout) ?? [];
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const workflow = String(row.workflowName ?? row.name ?? row.databaseId);
      if (!latest.has(workflow)) {
        latest.set(workflow, row);
      }
    }

    return [...latest.values()]
      .filter((row) => {
        return ["failure", "cancelled", "timed_out", "startup_failure"].includes(String(row.conclusion));
      })
      .map((row) => ({
        id: String(row.databaseId),
        runId: String(row.databaseId),
        name: String(row.workflowName ?? row.name ?? row.databaseId),
        status: String(row.conclusion),
        url: String(row.url ?? ""),
      }));
  }

  const result = await pi.exec(
    "glab",
    ["ci", "status", "--branch", review.headBranch, "--output", "json"],
    { cwd: review.worktree, timeout: 30_000 },
  );
  const value = parseJson<{ jobs?: Array<Record<string, unknown>>; pipeline?: Record<string, unknown> }>(
    result.stdout,
  );
  if (!value?.pipeline) {
    throw new Error(result.stderr.trim() || "Unable to read GitLab pipeline status");
  }
  if (String(value.pipeline.sha) !== review.headSha) {
    return [];
  }

  const pipelineId = String(value.pipeline.id);
  return (value.jobs ?? [])
    .filter((job) => ["failed", "canceled"].includes(String(job.status)))
    .map((job) => ({
      id: String(job.id),
      pipelineId,
      name: String(job.name ?? job.id),
      status: String(job.status),
      url: String(job.web_url ?? ""),
    }));
}

export async function retryCiTarget(
  pi: ExtensionAPI,
  review: Review,
  target: RetryTarget,
): Promise<void> {
  const result = review.forge === "github"
    ? await pi.exec("gh", ["run", "rerun", target.runId!, "--failed"], {
        cwd: review.worktree,
        timeout: 30_000,
      })
    : await pi.exec(
        "glab",
        ["ci", "retry", target.id, "--pipeline-id", target.pipelineId!],
        { cwd: review.worktree, timeout: 30_000 },
      );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Unable to retry ${target.name}`);
  }
}
