import type { Forge } from "../../shared/config-types.ts";

// A GitHub pull request or a GitLab merge request.
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  authorIsBot: boolean;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  // A ref that `git fetch origin <ref>` resolves to the head commit, even for a fork.
  headRef: string;
  fromFork: boolean;
  draft: boolean;
  url: string;
  // Changes with new commits and comments.
  updatedAt: string;
}

export interface Note {
  id: string;
  author: string;
  authorIsBot: boolean;
  body: string;
  createdAt: string;
  url?: string;
}

export interface Thread {
  id: string;
  // A resolvable thread, such as a code review comment; a plain comment cannot be resolved.
  resolvable: boolean;
  resolved: boolean;
  path?: string;
  line?: number;
  notes: Note[];
}

export interface FailedJob {
  id: string;
  name: string;
  // The branch the pipeline ran on, or the pull request it ran for.
  branch?: string;
  pullRequest?: number;
  sha: string;
  url: string;
  finishedAt: string;
  allowedToFail: boolean;
}

export interface Pipeline {
  id: string;
  url: string;
  seconds: number;
}

export interface JobTiming {
  name: string;
  seconds: number;
}

export interface ForgeClient {
  kind: Forge;
  host: string;
  // owner/name on GitHub, group/.../name on GitLab.
  project: string;
  url: string;
  currentUser(): Promise<string>;
  defaultBranch(): Promise<string>;
  openPullRequests(): Promise<PullRequest[]>;
  // Undefined while the forge is still computing it.
  hasConflicts(pullRequest: PullRequest): Promise<boolean | undefined>;
  threads(pullRequest: PullRequest): Promise<Thread[]>;
  failedJobs(since: Date): Promise<FailedJob[]>;
  jobLog(job: FailedJob): Promise<string>;
  // The latest successful pipelines on the branch, newest first.
  successfulPipelines(branch: string, count: number): Promise<Pipeline[]>;
  pipelineJobs(pipeline: Pipeline): Promise<JobTiming[]>;
}
