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
  resolvable: boolean;
  resolved: boolean;
  path?: string;
  line?: number;
  notes: Note[];
}

export interface FailedJob {
  id: string;
  name: string;
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

export type ConflictStatus = "conflicting" | "mergeable" | "computing";

export interface ForgeClient {
  kind: Forge;
  // How the forge writes a review's number, `!12` or `#12`, and the short name of its reviews.
  reviewPrefix: "!" | "#";
  reviewKind: "mr" | "pr";
  host: string;
  // owner/name on GitHub, group/.../name on GitLab.
  project: string;
  url: string;
  currentUser(): Promise<string>;
  defaultBranch(): Promise<string>;
  openPullRequests(): Promise<PullRequest[]>;
  conflictStatus(pullRequest: PullRequest): Promise<ConflictStatus>;
  threads(pullRequest: PullRequest): Promise<Thread[]>;
  failedJobs(since: Date): Promise<FailedJob[]>;
  jobLog(job: FailedJob): Promise<string>;
  successfulPipelines(branch: string, count: number): Promise<Pipeline[]>;
  pipelineJobs(pipeline: Pipeline): Promise<JobTiming[]>;
}
