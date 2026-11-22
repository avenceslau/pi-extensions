export type Forge = "github" | "gitlab";

export type ReviewStatus = "actionable" | "waiting" | "ready";

export type ShepherdPhase =
  | "idle"
  | "working"
  | "reviewing"
  | "reviewed"
  | "blocked";

export interface WorktreeRecord {
  path: string;
  repo: string;
  branch: string;
}

export interface Review {
  key: string;
  forge: Forge;
  number: number;
  title: string;
  url: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  worktree: string;
  repository: string;
  status: ReviewStatus;
  summary: string;
  draft: boolean;
}

export interface RetryTarget {
  id: string;
  runId?: string;
  pipelineId?: string;
  name: string;
  status: string;
  url?: string;
}

export interface SavedShepherdState {
  active: boolean;
  selected: string[];
  retryAttempts: Record<string, number>;
  correctionLoops: Record<string, number>;
}

export interface ActiveRun {
  kind: "worker" | "correctness" | "refactor";
  reviewKey: string;
  baseline?: string;
}

export interface ReviewCycle {
  pending: Set<string>;
  failed: boolean;
  fingerprint: string;
  results: Array<{
    kind: "correctness" | "refactor";
    result: string;
  }>;
}
