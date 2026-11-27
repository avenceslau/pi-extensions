import type { PiExtensionsConfig } from "../shared/config-types.ts";
import type { WorktreeRequest } from "../shared/worktree.ts";
import type { ForgeClient } from "./forges/types.ts";

export interface Repository {
  url: string;
  // The local clone, with `~` expanded.
  path: string;
  forge: ForgeClient;
  // Extra command patterns from the config for playbooks that run the repository's checks.
  commands: string[];
  // The command that installs dependencies in a worktree; empty when there is none.
  setup: string[];
}

export interface CheckContext {
  agent: string;
  repositories: Repository[];
  config: PiExtensionsConfig;
  now: Date;
  // No run of this check has finished before; see Check.actOnFirstRun.
  firstRun: boolean;
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
  // The problem the run works on, such as a merge request's conflicts. Several triggers can share one, as each new
  // comment on the same merge request does. The tab closes once every concern of its runs is addressed.
  concern: string;
  // Set by the framework to the check that returned the trigger.
  check?: string;
  playbook: string;
  repository: string;
  tab: Tab;
  worktree: WorktreeRequest;
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
  // Runs the repository's code, so the worktree gets the repository's setup first and the prompt lists its commands.
  runsRepositoryCode?: boolean;
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
  run(context: CheckContext): Promise<CheckResult>;
}

export interface CheckResult {
  triggers: Trigger[];
  // Every concern of this check that is still unaddressed, including ones whose runs already started. A concern the
  // check reported before and no longer lists is addressed. Leave it out when the check cannot tell; such concerns
  // count as addressed once every merge request their tab's runs opened is merged or closed.
  openConcerns?: string[];
}

export interface LocalAgentDefinition {
  name: string;
  checks: Check[];
  playbooks: Record<string, Playbook>;
}
