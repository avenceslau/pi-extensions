import { runProgram } from "../exec.ts";
import { listAllPages } from "./pagination.ts";
import type {
  FailedJob,
  ForgeClient,
  JobTiming,
  Pipeline,
  PullRequest,
  Thread,
} from "./types.ts";

interface GitLabUser {
  username: string;
}

interface GitLabMergeRequest {
  iid: number;
  title: string;
  author: GitLabUser;
  source_branch: string;
  target_branch: string;
  sha: string;
  has_conflicts: boolean;
  draft: boolean;
  source_project_id: number;
  target_project_id: number;
  web_url: string;
  updated_at: string;
}

interface GitLabNote {
  id: number;
  body: string;
  author: GitLabUser;
  system: boolean;
  resolvable: boolean;
  resolved?: boolean;
  created_at: string;
  position?: {
    new_path?: string;
    new_line?: number;
  };
}

interface GitLabDiscussion {
  id: string;
  notes: GitLabNote[];
}

interface GitLabJob {
  id: number;
  name: string;
  ref: string;
  allow_failure: boolean;
  web_url: string;
  finished_at: string;
  duration: number | null;
  commit: {
    id: string;
  };
}

interface GitLabPipeline {
  id: number;
  ref: string;
  created_at: string;
  updated_at: string;
  web_url: string;
}

interface GitLabBridge {
  downstream_pipeline?: {
    id: number;
  } | null;
}

const MILLISECONDS_PER_SECOND = 1000;

const MERGE_TRAIN_REF = /^refs\/merge-requests\/\d+\/train$/;
const MERGE_TRAIN_PAGES = 5;
const MERGE_TRAIN_PAGE_ITEMS = 100;

const MERGE_REQUEST_REF = /^refs\/merge-requests\/(\d+)\/(?:head|merge|train)$/;

function pipelineTiming(pipeline: GitLabPipeline): Pipeline {
  return {
    id: String(pipeline.id),
    url: pipeline.web_url,
    seconds:
      (Date.parse(pipeline.updated_at) - Date.parse(pipeline.created_at)) /
      MILLISECONDS_PER_SECOND,
  };
}

export function gitlabClient(
  host: string,
  project: string,
  isBot: (username: string) => boolean,
): ForgeClient {
  const projectPath = `projects/${encodeURIComponent(project)}`;

  const api = (path: string) =>
    runProgram("glab", ["api", "--hostname", host, path]);

  // SAFETY: each caller names the response type its endpoint documents.
  const json = async <T>(path: string): Promise<T> =>
    JSON.parse(await api(path)) as T;

  let mergeRequests: Promise<GitLabMergeRequest[]> | undefined;
  let user: Promise<string> | undefined;

  const listMergeRequests = () => {
    mergeRequests ??= listAllPages(
      `${projectPath}/merge_requests?state=opened`,
      (pagePath) => json<GitLabMergeRequest[]>(pagePath),
    );

    return mergeRequests;
  };

  const pipelineJobs = async (pipelineId: number): Promise<GitLabJob[]> => {
    const [jobs, bridges] = await Promise.all([
      json<GitLabJob[]>(
        `${projectPath}/pipelines/${pipelineId}/jobs?per_page=100`,
      ),
      json<GitLabBridge[]>(
        `${projectPath}/pipelines/${pipelineId}/bridges?per_page=100`,
      ),
    ]);

    const children = await Promise.all(
      bridges.flatMap((bridge) =>
        bridge.downstream_pipeline
          ? [pipelineJobs(bridge.downstream_pipeline.id)]
          : [],
      ),
    );

    return [...jobs, ...children.flat()];
  };

  return {
    kind: "gitlab",
    reviewPrefix: "!",
    reviewKind: "mr",
    host,
    project,
    url: `https://${host}/${project}`,

    currentUser() {
      user ??= json<GitLabUser>("user").then((current) => current.username);

      return user;
    },

    async defaultBranch() {
      return (await json<{ default_branch: string }>(projectPath))
        .default_branch;
    },

    async openPullRequests(): Promise<PullRequest[]> {
      return (await listMergeRequests()).map((mergeRequest) => ({
        number: mergeRequest.iid,
        title: mergeRequest.title,
        author: mergeRequest.author.username,
        authorIsBot: isBot(mergeRequest.author.username),
        sourceBranch: mergeRequest.source_branch,
        targetBranch: mergeRequest.target_branch,
        headSha: mergeRequest.sha,
        headRef: `refs/merge-requests/${mergeRequest.iid}/head`,
        fromFork:
          mergeRequest.source_project_id !== mergeRequest.target_project_id,
        draft: mergeRequest.draft,
        url: mergeRequest.web_url,
        updatedAt: mergeRequest.updated_at,
      }));
    },

    async conflictStatus(pullRequest) {
      const mergeRequest = (await listMergeRequests()).find(
        (candidate) => candidate.iid === pullRequest.number,
      );

      return mergeRequest?.has_conflicts ? "conflicting" : "mergeable";
    },

    async threads(pullRequest): Promise<Thread[]> {
      const discussions = await json<GitLabDiscussion[]>(
        `${projectPath}/merge_requests/${pullRequest.number}/discussions?per_page=100`,
      );

      return discussions.flatMap((discussion) => {
        const notes = discussion.notes.filter((note) => !note.system);
        const first = notes[0];

        if (!first) {
          return [];
        }

        return [
          {
            id: discussion.id,
            resolvable: first.resolvable,
            resolved: first.resolvable && first.resolved === true,
            path: first.position?.new_path,
            line: first.position?.new_line,
            notes: notes.map((note) => ({
              id: String(note.id),
              author: note.author.username,
              authorIsBot: isBot(note.author.username),
              body: note.body,
              createdAt: note.created_at,
              url: `${pullRequest.url}#note_${note.id}`,
            })),
          },
        ];
      });
    },

    async failedJobs(since): Promise<FailedJob[]> {
      const jobs = await json<GitLabJob[]>(
        `${projectPath}/jobs?scope[]=failed&per_page=100`,
      );

      return jobs
        .filter((job) => new Date(job.finished_at) > since)
        .map((job) => {
          const mergeRequest = MERGE_REQUEST_REF.exec(job.ref);

          return {
            id: String(job.id),
            name: job.name,
            branch: mergeRequest ? undefined : job.ref,
            pullRequest: mergeRequest ? Number(mergeRequest[1]) : undefined,
            sha: job.commit.id,
            url: job.web_url,
            finishedAt: job.finished_at,
            allowedToFail: job.allow_failure,
          };
        });
    },

    jobLog(job) {
      return api(`${projectPath}/jobs/${job.id}/trace`);
    },

    async successfulPipelines(branch, count): Promise<Pipeline[]> {
      const pipelines = await json<GitLabPipeline[]>(
        `${projectPath}/pipelines?ref=${encodeURIComponent(branch)}&status=success&source=push&per_page=${count}`,
      );

      return pipelines.map(pipelineTiming);
    },

    // Train pipelines are mixed with the other merge request pipelines, so this reads pages until it has enough.
    async successfulMergeTrainPipelines(count): Promise<Pipeline[]> {
      const trains: GitLabPipeline[] = [];

      for (
        let page = 1;
        page <= MERGE_TRAIN_PAGES && trains.length < count;
        page += 1
      ) {
        const batch = await json<GitLabPipeline[]>(
          `${projectPath}/pipelines?status=success&source=merge_request_event&per_page=${MERGE_TRAIN_PAGE_ITEMS}&page=${page}`,
        );

        trains.push(
          ...batch.filter((pipeline) => MERGE_TRAIN_REF.test(pipeline.ref)),
        );

        if (batch.length < MERGE_TRAIN_PAGE_ITEMS) {
          break;
        }
      }

      return trains.slice(0, count).map(pipelineTiming);
    },

    // Merges only the commit that has the pipeline, once it succeeds, so a later push is not merged unseen.
    async enableAutoMerge(number) {
      const mergeRequest = await json<{
        sha: string;
        head_pipeline: { id: number } | null;
      }>(`${projectPath}/merge_requests/${number}`);

      if (!mergeRequest.head_pipeline) {
        return "waiting";
      }

      await runProgram("glab", [
        "api",
        "--hostname",
        host,
        "--method",
        "PUT",
        `${projectPath}/merge_requests/${number}/merge`,
        "--field",
        "auto_merge=true",
        "--field",
        "merge_when_pipeline_succeeds=true",
        "--field",
        `sha=${mergeRequest.sha}`,
      ]);

      return "enabled";
    },

    async pipelineJobs(pipeline): Promise<JobTiming[]> {
      return (await pipelineJobs(Number(pipeline.id))).map((job) => ({
        name: job.name,
        seconds: job.duration ?? 0,
      }));
    },
  };
}
