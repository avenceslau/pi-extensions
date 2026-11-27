import type { PiExtensionsConfig } from "../shared/config-types.ts";
import type { ForgeClient } from "./forges/types.ts";

// A local agent is a set of checks, plain code run on a schedule by launchd, and the playbooks they start. A check
// returns triggers; each trigger starts a fresh pi session in a Rex tab of the agent's session, in a worktree, limited
// to what its playbook allows.

export interface Repository {
  url: string;
  // The local clone, with `~` expanded.
  path: string;
  forge: ForgeClient;
  // Extra command patterns from the config for playbooks that run the repository's checks.
  commands: string[];
}

export interface CheckContext {
  agent: string;
  repositories: Repository[];
  config: PiExtensionsConfig;
  now: Date;
  // The check's own data from earlier runs; changes are saved when the run finishes without throwing.
  memory: Record<string, unknown>;
  log(message: string): void;
}

// The Rex tab a run opens in. Runs with the same key share the tab, each in its own pane.
export interface Tab {
  key: string;
  label: string;
  // The tab and its worktrees are removed once this pull request is no longer open.
  pullRequest?: {
    repository: string;
    number: number;
  };
}

export interface Trigger {
  // A trigger runs once per key.
  key: string;
  playbook: string;
  repository: string;
  tab: Tab;
  worktree: {
    branch: string;
    // Refs to fetch from origin first.
    fetch: string[];
    // The commit or ref to start the branch at.
    start: string;
  };
  prompt: string;
  push?: {
    branch: string;
    expectedSha: string;
    askFirst: boolean;
  };
  review?: {
    number: number;
    url: string;
  };
  // Shown as a desktop notification when the run starts.
  notify?: string;
}

export interface Playbook {
  // Markdown appended to the system prompt.
  instructions: string;
  tools: string[];
  commands(repository: Repository): string[];
  // May open a merge request into the default branch, after the user confirms.
  mergeRequest?: boolean;
  // May comment on the trigger's review, after the user confirms.
  comment?: boolean;
}

export interface Check {
  name: string;
  everyMinutes: number;
  // Runs only from `from` to `to` o'clock local time, Monday to Friday.
  workingHours?: {
    from: number;
    to: number;
  };
  // A check's first run records its triggers as handled without starting them, so a newly installed agent acts only
  // on what changes afterwards. Set this for checks whose first triggers are as useful as later ones.
  actOnFirstRun?: boolean;
  run(context: CheckContext): Promise<Trigger[]>;
}

export interface LocalAgentDefinition {
  name: string;
  checks: Check[];
  playbooks: Record<string, Playbook>;
}
