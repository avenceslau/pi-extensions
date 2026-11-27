import { API_CONCURRENCY, mapWithLimit, run } from "../exec.ts";
import type {
  FailedJob,
  ForgeClient,
  JobTiming,
  Pipeline,
  PullRequest,
  Thread,
} from "./types.ts";

interface GitHubUser {
  login: string;
  type: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  user: GitHubUser;
  draft: boolean;
  html_url: string;
  updated_at: string;
  head: {
    ref: string;
    sha: string;
    repo: { full_name: string } | null;
  };
  base: {
    ref: string;
    repo: { full_name: string };
  };
  mergeable_state?: string;
}

interface GitHubRun {
  id: number;
  head_branch: string;
  head_sha: string;
  html_url: string;
  run_started_at: string;
  updated_at: string;
  name: string;
  pull_requests: { number: number }[];
}

interface GitHubJob {
  id: number;
  name: string;
  workflow_name: string;
  conclusion: string | null;
  html_url: string;
  started_at: string;
  completed_at: string | null;
}

interface GraphQLComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: { login: string; __typename: string } | null;
}

interface GraphQLThreads {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: {
            id: string;
            isResolved: boolean;
            path: string | null;
            line: number | null;
            comments: { nodes: GraphQLComment[] };
          }[];
        };
        comments: { nodes: GraphQLComment[] };
      };
    };
  };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
// Failed runs examined per tick; the cursor then keeps only jobs that completed after it.
const FAILED_RUNS_EXAMINED = 50;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          line
          comments(last: 30) { nodes { id body createdAt url author { login __typename } } }
        }
      }
      comments(last: 50) { nodes { id body createdAt url author { login __typename } } }
    }
  }
}`;

export function githubClient(
  host: string,
  project: string,
  isBot: (username: string) => boolean,
): ForgeClient {
  const [owner, name] = project.split("/");
  const api = (path: string) => run("gh", ["api", "--hostname", host, path]);

  // SAFETY: each caller names the response type its endpoint documents.
  const json = async <T>(path: string): Promise<T> =>
    JSON.parse(await api(path)) as T;

  // Every page, so a review missing from the result is really not open.
  const listAll = async <T>(path: string): Promise<T[]> => {
    const items: T[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await json<T[]>(
        `${path}&per_page=${PAGE_SIZE}&page=${page}`,
      );

      items.push(...batch);

      if (batch.length < PAGE_SIZE) {
        return items;
      }
    }

    throw new Error(`${path} has more than ${MAX_PAGES} pages`);
  };

  let pulls: Promise<GitHubPullRequest[]> | undefined;
  let user: Promise<string> | undefined;

  const authorIsBot = (author: GraphQLComment["author"]) =>
    !author || author.__typename === "Bot" || isBot(author.login);

  const note = (comment: GraphQLComment) => ({
    id: comment.id,
    author: comment.author?.login ?? "ghost",
    authorIsBot: authorIsBot(comment.author),
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
  });

  const runJobs = (runId: number) =>
    json<{ jobs: GitHubJob[] }>(
      `repos/${project}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ).then((response) => response.jobs);

  return {
    kind: "github",
    host,
    project,
    url: `https://${host}/${project}`,

    currentUser() {
      user ??= json<GitHubUser>("user").then((current) => current.login);

      return user;
    },

    async defaultBranch() {
      return (await json<{ default_branch: string }>(`repos/${project}`))
        .default_branch;
    },

    async openPullRequests(): Promise<PullRequest[]> {
      pulls ??= listAll<GitHubPullRequest>(`repos/${project}/pulls?state=open`);

      return (await pulls).map((pull) => ({
        number: pull.number,
        title: pull.title,
        author: pull.user.login,
        authorIsBot: pull.user.type === "Bot" || isBot(pull.user.login),
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        headSha: pull.head.sha,
        headRef: `refs/pull/${pull.number}/head`,
        fromFork: pull.head.repo?.full_name !== pull.base.repo.full_name,
        draft: pull.draft,
        url: pull.html_url,
        updatedAt: pull.updated_at,
      }));
    },

    async hasConflicts(pullRequest) {
      const pull = await json<GitHubPullRequest>(
        `repos/${project}/pulls/${pullRequest.number}`,
      );

      if (!pull.mergeable_state || pull.mergeable_state === "unknown") {
        return undefined;
      }

      return pull.mergeable_state === "dirty";
    },

    async threads(pullRequest): Promise<Thread[]> {
      // SAFETY: THREADS_QUERY selects exactly the fields of GraphQLThreads.
      const response = JSON.parse(
        await run("gh", [
          "api",
          "graphql",
          "--hostname",
          host,
          "-f",
          `query=${THREADS_QUERY}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${pullRequest.number}`,
        ]),
      ) as GraphQLThreads;

      const { reviewThreads, comments } = response.data.repository.pullRequest;

      const reviewed = reviewThreads.nodes.map((thread) => ({
        id: thread.id,
        resolvable: true,
        resolved: thread.isResolved,
        path: thread.path ?? undefined,
        line: thread.line ?? undefined,
        notes: thread.comments.nodes.map(note),
      }));

      const plain = comments.nodes.map((comment) => ({
        id: comment.id,
        resolvable: false,
        resolved: false,
        notes: [note(comment)],
      }));

      return [...reviewed, ...plain];
    },

    async failedJobs(since): Promise<FailedJob[]> {
      const { workflow_runs: runs } = await json<{
        workflow_runs: GitHubRun[];
      }>(
        `repos/${project}/actions/runs?status=failure&per_page=${FAILED_RUNS_EXAMINED}`,
      );

      // A run is last updated when it completes, so older runs hold no job that failed after the cursor.
      const recent = runs.filter(
        (workflowRun) => new Date(workflowRun.updated_at) > since,
      );
      const jobs = await mapWithLimit(
        recent,
        API_CONCURRENCY,
        async (workflowRun) =>
          (await runJobs(workflowRun.id))
            .filter((job) => job.conclusion === "failure")
            .map((job) => ({
              id: String(job.id),
              name: `${workflowRun.name} / ${job.name}`,
              branch: workflowRun.head_branch,
              pullRequest: workflowRun.pull_requests[0]?.number,
              sha: workflowRun.head_sha,
              url: job.html_url,
              finishedAt: job.completed_at ?? workflowRun.updated_at,
              allowedToFail: false,
            })),
      );

      // The runs API can only filter by creation time, so a run that started before the cursor but failed after it
      // is kept by comparing completion times instead.
      return jobs.flat().filter((job) => new Date(job.finishedAt) > since);
    },

    jobLog(job) {
      return api(`repos/${project}/actions/jobs/${job.id}/logs`);
    },

    async successfulPipelines(branch, count): Promise<Pipeline[]> {
      const { workflow_runs: runs } = await json<{
        workflow_runs: GitHubRun[];
      }>(
        `repos/${project}/actions/runs?branch=${encodeURIComponent(branch)}&status=success&event=push&per_page=${count}`,
      );

      return runs.map((workflowRun) => ({
        id: String(workflowRun.id),
        url: workflowRun.html_url,
        seconds:
          (Date.parse(workflowRun.updated_at) -
            Date.parse(workflowRun.run_started_at)) /
          1000,
      }));
    },

    async pipelineJobs(pipeline): Promise<JobTiming[]> {
      return (await runJobs(Number(pipeline.id))).map((job) => ({
        name: `${job.workflow_name} / ${job.name}`,
        seconds: job.completed_at
          ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000
          : 0,
      }));
    },
  };
}
