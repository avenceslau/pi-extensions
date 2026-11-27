import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tab, Trigger } from "./definition.ts";
import { errorCode } from "./errors.ts";

export interface TabRecord extends Tab {
  windowId: string;
  worktrees: {
    repository: string;
    path: string;
    branch: string;
  }[];
  runIds: string[];
  // Missing on tabs opened before concerns were tracked; those close only with their pull request.
  concerns?: {
    check: string;
    id: string;
    addressed: boolean;
  }[];
  // Merge requests the tab's runs opened, and what the tick has done with each.
  openedReviews?: OpenedReview[];
  lastActivityAt?: string;
}

export interface OpenedReview {
  url: string;
  title: string;
  open: boolean;
  // reviewOpenedCommand ran for it.
  announced?: boolean;
  autoMerge?: "enabled";
  // Ticks that failed to run reviewOpenedCommand or turn on auto-merge; both stop after a few.
  failures?: number;
}

export interface AgentState {
  checks: Record<
    string,
    {
      lastRunAt?: string;
      memory: Record<string, unknown>;
    }
  >;
  // Trigger keys and when they ran.
  handled: Record<string, string>;
  // Failed attempts to start a queued trigger, by key.
  attempts: Record<string, number>;
  queue: Trigger[];
  tabs: Record<string, TabRecord>;
}

const HANDLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function agentDirectory(agent: string): string {
  return join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "local-agents",
    agent,
  );
}

export function readState(agent: string): AgentState {
  const empty: AgentState = {
    checks: {},
    handled: {},
    attempts: {},
    queue: [],
    tabs: {},
  };

  try {
    // SAFETY: only writeState writes this file.
    return {
      ...empty,
      ...(JSON.parse(
        readFileSync(join(agentDirectory(agent), "state.json"), "utf8"),
      ) as Partial<AgentState>),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return empty;
    }

    throw error;
  }
}

export function writeState(agent: string, state: AgentState, now: Date): void {
  const directory = agentDirectory(agent);
  const cutoff = now.getTime() - HANDLED_RETENTION_MS;

  for (const [key, at] of Object.entries(state.handled)) {
    if (Date.parse(at) < cutoff) {
      delete state.handled[key];
      delete state.attempts[key];
    }
  }

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "state.json.tmp"),
    JSON.stringify(state, null, 2),
  );
  renameSync(join(directory, "state.json.tmp"), join(directory, "state.json"));
}
