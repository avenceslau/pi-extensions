import type { Forge } from "../shared/config-types.ts";

// What one agent session may do. The launcher writes it to a file and passes the path in LOCAL_AGENT_POLICY;
// guard.ts reads it and enforces it on every tool call.
export interface RunPolicy {
  agent: string;
  runId: string;
  worktree: string;
  // The clone's git directory, which git writes to for commits made in the worktree.
  gitDirectory: string;
  statusFile: string;
  tools: string[];
  // Bash command patterns; see command-policy.ts.
  commands: string[];
  repository: {
    forge: Forge;
    host: string;
    project: string;
    url: string;
  };
  review?: {
    number: number;
    url: string;
  };
  // Lets push_branch force-push HEAD to this branch, but only over the commit the trigger saw.
  push?: {
    branch: string;
    expectedSha: string;
    askFirst: boolean;
  };
  // Lets open_merge_request push HEAD to a new `<agent>/...` branch and open a review into this branch, after the
  // user confirms.
  mergeRequest?: {
    targetBranch: string;
  };
  // Lets post_comment comment on the review, after the user confirms.
  comment?: boolean;
}

export type RunStatus = "working" | "waiting" | "idle";

export interface RunStatusFile {
  pid: number;
  status: RunStatus;
  updatedAt: string;
}

export const POLICY_VARIABLE = "LOCAL_AGENT_POLICY";
