import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  LocalAgentConfig,
  PiExtensionsConfig,
} from "../shared/config-types.ts";
import type {
  LocalAgentDefinition,
  Repository,
  Trigger,
} from "./definition.ts";
import { expandHome } from "./command-policy.ts";
import { run } from "./exec.ts";
import { forgeClient } from "./forges/index.ts";
import { prepareLaunch } from "./launch.ts";
import {
  addPane,
  closeWindow,
  ensureSession,
  openTab,
  windowIds,
} from "./rex.ts";
import type { RunStatusFile } from "./run-policy.ts";
import { isDue } from "./schedule.ts";
import {
  agentDirectory,
  readState,
  writeState,
  type AgentState,
  type TabRecord,
} from "./state.ts";
import { prepareWorktree, removeWorktree } from "./worktree.ts";

const DEFAULT_MAX_RUNNING_AGENTS = 3;
const LAUNCH_ATTEMPTS = 3;

export interface TickOptions {
  // Print the triggers instead of starting runs, and save nothing.
  dryRun: boolean;
  // When set, runs only these checks, now, regardless of their schedule.
  onlyChecks: string[];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(directory: string): (() => void) | undefined {
  const path = join(directory, "tick.lock");

  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    if (isAlive(Number(readFileSync(path, "utf8")))) {
      return undefined;
    }

    writeFileSync(path, String(process.pid));
  }

  return () => rmSync(path, { force: true });
}

// Status files of runs whose pi process is still alive, by run id. Files left by exited processes are removed.
function liveRuns(runsDirectory: string): Map<string, RunStatusFile> {
  const runs = new Map<string, RunStatusFile>();

  const names = readdirSync(runsDirectory).filter((name) =>
    name.endsWith(".status.json"),
  );

  for (const name of names) {
    const path = join(runsDirectory, name);
    const status = JSON.parse(readFileSync(path, "utf8")) as RunStatusFile;

    if (isAlive(status.pid)) {
      runs.set(name.slice(0, -".status.json".length), status);
    } else {
      rmSync(path, { force: true });
    }
  }

  return runs;
}

function repositoriesFor(
  agentConfig: LocalAgentConfig,
  config: PiExtensionsConfig,
): Repository[] {
  const ignored = (agentConfig.ignoredAuthors ?? []).map(
    (pattern) => new RegExp(pattern, "i"),
  );

  const isBot = (username: string) =>
    username.endsWith("[bot]") ||
    ignored.some((pattern) => pattern.test(username));

  return (agentConfig.repositories ?? []).map((repository) => ({
    url: repository.url,
    path: expandHome(repository.path),
    commands: repository.commands ?? [],
    forge: forgeClient(repository.url, config.forges ?? {}, isBot),
  }));
}

async function notify(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  // A notification is a courtesy; the run has started either way.
  await run("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ]).catch(() => undefined);
}

function enqueue(state: AgentState, triggers: Trigger[]): number {
  let added = 0;

  for (const trigger of triggers) {
    const known =
      state.handled[trigger.key] !== undefined ||
      state.queue.some((queued) => queued.key === trigger.key);

    if (!known) {
      state.queue.push(trigger);
      added += 1;
    }
  }

  return added;
}

export async function tick(
  definition: LocalAgentDefinition,
  config: PiExtensionsConfig,
  options: TickOptions,
): Promise<void> {
  const agent = definition.name;
  const agentConfig = config.localAgents?.[agent] ?? {};
  const directory = agentDirectory(agent);
  const runsDirectory = join(directory, "runs");
  const now = new Date();

  const log = (message: string) =>
    console.log(`${new Date().toISOString()} ${message}`);

  mkdirSync(runsDirectory, { recursive: true });

  const release = acquireLock(directory);

  if (!release) {
    log("another tick is still running");

    return;
  }

  try {
    const state = readState(agent);
    const repositories = repositoriesFor(agentConfig, config);

    const due = definition.checks.filter((check) =>
      options.onlyChecks.length > 0
        ? options.onlyChecks.includes(check.name)
        : isDue(check, state.checks[check.name]?.lastRunAt, now),
    );

    const baseline: Trigger[] = [];

    // Checks run at the same time; each keeps its own memory, and they share the forge clients' cached lists.
    const triggersByCheck = await Promise.all(
      due.map(async (check) => {
        const memory = structuredClone(state.checks[check.name]?.memory ?? {});
        const firstRun = state.checks[check.name]?.lastRunAt === undefined;
        const started = Date.now();

        try {
          const triggers = await check.run({
            agent,
            repositories,
            config,
            now,
            memory,
            log: (message) => log(`${check.name}: ${message}`),
          });

          state.checks[check.name] = {
            lastRunAt: now.toISOString(),
            memory,
          };
          log(
            `${check.name}: ${triggers.length} trigger(s) in ${Math.round((Date.now() - started) / 1000)}s`,
          );

          if (firstRun && !check.actOnFirstRun) {
            baseline.push(...triggers);

            return [];
          }

          return triggers;
        } catch (error) {
          log(`${check.name} failed: ${(error as Error).message}`);

          return [];
        }
      }),
    );

    const checkTriggers = triggersByCheck.flat();

    if (options.dryRun) {
      const fresh = checkTriggers.filter(
        (trigger) => state.handled[trigger.key] === undefined,
      );

      for (const trigger of fresh) {
        console.log(
          `\n## ${trigger.tab.label} · ${trigger.playbook}\n${trigger.key}\n\n${trigger.prompt}`,
        );
      }

      log(`${checkTriggers.length - fresh.length} trigger(s) already handled`);

      for (const trigger of baseline) {
        console.log(
          `\n## ${trigger.tab.label} · ${trigger.playbook} (first run: recorded, not started)\n${trigger.key}`,
        );
      }

      return;
    }

    for (const trigger of baseline) {
      state.handled[trigger.key] = now.toISOString();
    }

    if (baseline.length > 0) {
      log(
        `recorded ${baseline.length} existing trigger(s) without starting them`,
      );
    }

    const added = enqueue(state, checkTriggers);

    if (added > 0) {
      log(`queued ${added} trigger(s)`);
    }

    await ensureSession(agent, join(directory, "tick.log"));
    await removeFinishedTabs(agent, state, repositories, runsDirectory, log);
    await launchQueued(
      definition,
      agentConfig,
      state,
      repositories,
      runsDirectory,
      now,
      log,
    );
    writeState(agent, state, now);
  } finally {
    release();
  }
}

// A session that finished its task stays open for the user but is idle, so it does not hold the tab's worktree.
function hasActiveRun(
  tab: TabRecord,
  runs: Map<string, RunStatusFile>,
): boolean {
  return tab.runIds.some((runId) => {
    const status = runs.get(runId)?.status;

    return status !== undefined && status !== "idle";
  });
}

async function launchQueued(
  definition: LocalAgentDefinition,
  agentConfig: LocalAgentConfig,
  state: AgentState,
  repositories: Repository[],
  runsDirectory: string,
  now: Date,
  log: (message: string) => void,
): Promise<void> {
  const agent = definition.name;
  const runs = liveRuns(runsDirectory);
  const capacity = agentConfig.maxRunningAgents ?? DEFAULT_MAX_RUNNING_AGENTS;

  let working = [...runs.values()].filter(
    (run) => run.status === "working",
  ).length;

  const windows = await windowIds(agent);
  const waiting: Trigger[] = [];
  // Tabs that got a run in this tick; their status files may not exist yet.
  const startedTabs = new Set<string>();

  for (const trigger of state.queue) {
    const tab = state.tabs[trigger.tab.key];
    const tabOpen = tab !== undefined && windows.has(tab.windowId);
    const tabBusy =
      startedTabs.has(trigger.tab.key) || (tabOpen && hasActiveRun(tab, runs));

    // Runs in one tab share a worktree, so a second one waits until the first has finished.
    if (working >= capacity || tabBusy) {
      waiting.push(trigger);
      continue;
    }

    const repository = repositories.find(
      (candidate) => candidate.url === trigger.repository,
    );

    if (!repository) {
      log(`dropping ${trigger.key}: ${trigger.repository} is not configured`);
      continue;
    }

    try {
      const worktree = await prepareWorktree(repository, trigger.worktree);

      const launch = await prepareLaunch(
        definition,
        agentConfig,
        trigger,
        repository,
        worktree,
        now,
      );

      let record = tab;

      if (record && tabOpen) {
        await addPane(
          agent,
          record.windowId,
          trigger.playbook,
          worktree.path,
          launch.command,
        );
      } else {
        const windowId = await openTab(
          agent,
          trigger.tab.label,
          worktree.path,
          launch.command,
        );

        record = {
          ...trigger.tab,
          windowId,
          worktrees: [],
          runIds: [],
        };
        state.tabs[trigger.tab.key] = record;
        windows.add(windowId);
      }

      if (!record.worktrees.some((known) => known.path === worktree.path)) {
        record.worktrees.push({
          repository: repository.url,
          path: worktree.path,
          branch: trigger.worktree.branch,
        });
      }

      record.runIds.push(launch.runId);
      startedTabs.add(trigger.tab.key);
      state.handled[trigger.key] = now.toISOString();
      working += 1;
      log(`started ${trigger.playbook} for ${trigger.tab.label}`);

      if (trigger.notify) {
        await notify(agent, trigger.notify);
      }
    } catch (error) {
      const attempts = (state.attempts[trigger.key] ?? 0) + 1;

      state.attempts[trigger.key] = attempts;
      log(
        `could not start ${trigger.key} (attempt ${attempts}): ${(error as Error).message}`,
      );

      if (attempts < LAUNCH_ATTEMPTS) {
        waiting.push(trigger);
      } else {
        state.handled[trigger.key] = now.toISOString();
      }
    }
  }

  state.queue = waiting;
}

// Removes tabs the user closed and tabs whose pull request is no longer open, with their clean worktrees. A tab with
// an active run is kept; closing a tab ends its idle sessions, whose transcripts stay in pi's session files.
async function removeFinishedTabs(
  agent: string,
  state: AgentState,
  repositories: Repository[],
  runsDirectory: string,
  log: (message: string) => void,
): Promise<void> {
  const windows = await windowIds(agent);
  const runs = liveRuns(runsDirectory);

  for (const [key, tab] of Object.entries(state.tabs)) {
    if (hasActiveRun(tab, runs)) {
      continue;
    }

    const closedByUser = !windows.has(tab.windowId);

    if (!closedByUser) {
      const repository = repositories.find(
        (candidate) => candidate.url === tab.pullRequest?.repository,
      );

      if (!repository) {
        continue;
      }

      const open = await repository.forge.openPullRequests();

      if (open.some((pull) => pull.number === tab.pullRequest?.number)) {
        continue;
      }

      await closeWindow(agent, tab.windowId);
    }

    const kept = [];

    for (const worktree of tab.worktrees) {
      const repository = repositories.find(
        (candidate) => candidate.url === worktree.repository,
      );

      const removed =
        repository !== undefined &&
        (await removeWorktree(repository, worktree.path, worktree.branch));

      if (!removed) {
        kept.push(worktree.path);
      }
    }

    if (kept.length > 0) {
      log(`kept ${kept.join(", ")}: uncommitted changes`);
    }

    delete state.tabs[key];
    log(`removed the tab ${tab.label}`);
  }
}
