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
  Check,
  LocalAgentDefinition,
  Repository,
  Trigger,
} from "./definition.ts";
import { errorCode, errorMessage } from "./errors.ts";
import { runProgram } from "./exec.ts";
import { forgeClient } from "./forges/index.ts";
import { parseRunStatus, type RunStatusFile } from "./guard/policy.ts";
import { prepareLaunch } from "./launch.ts";
import { followOpenedReviews } from "./opened-reviews.ts";
import { expandHome } from "./paths.ts";
import {
  addPane,
  closeWindow,
  ensureSession,
  openTab,
  windowIds,
} from "./rex.ts";
import { isDue } from "./schedule.ts";
import {
  hasActiveRun,
  isAddressed,
  lastActivity,
  updateConcerns,
} from "./tabs.ts";
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
const MILLISECONDS_PER_SECOND = 1000;
const STATUS_SUFFIX = ".status.json";

// An addressed tab stays open this long after its last activity, so it does not vanish while the user reads it.
const ADDRESSED_TAB_IDLE_MS = 30 * 60 * 1000;

export interface TickOptions {
  // Print the triggers instead of starting runs, and save nothing.
  dryRun: boolean;
  // When set, runs only these checks, now, regardless of their schedule.
  onlyChecks: string[];
}

export interface TickContext {
  definition: LocalAgentDefinition;
  agentConfig: LocalAgentConfig;
  config: PiExtensionsConfig;
  state: AgentState;
  repositoryByUrl: Map<string, Repository>;
  runsDirectory: string;
  now: Date;
  log(message: string): void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function acquireLock(directory: string): (() => void) | undefined {
  const path = join(directory, "tick.lock");

  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
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
    name.endsWith(STATUS_SUFFIX),
  );

  for (const name of names) {
    const path = join(runsDirectory, name);
    const status = parseRunStatus(readFileSync(path, "utf8"));

    if (status && isAlive(status.pid)) {
      runs.set(name.slice(0, -STATUS_SUFFIX.length), status);
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
    setup: repository.setup ?? [],
    forge: forgeClient(repository.url, config.forges ?? {}, isBot),
  }));
}

async function notify(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  // A notification is a courtesy; the run has started either way.
  await runProgram("osascript", [
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

interface CheckOutcome {
  triggers: Trigger[];
  baseline: Trigger[];
  // Open concerns by check, for the checks that ran and report them.
  openConcerns: Map<string, Set<string>>;
}

async function runCheck(
  context: TickContext,
  check: Check,
): Promise<CheckOutcome> {
  const { state, now, log } = context;
  const memory = structuredClone(state.checks[check.name]?.memory ?? {});
  const firstRun = state.checks[check.name]?.lastRunAt === undefined;
  const started = Date.now();

  try {
    const checkResult = await check.run({
      agent: context.definition.name,
      repositories: [...context.repositoryByUrl.values()],
      config: context.config,
      now,
      firstRun,
      memory,
      log: (message) => log(`${check.name}: ${message}`),
    });

    const triggers = checkResult.triggers.map((trigger) => ({
      ...trigger,
      check: check.name,
    }));

    const openConcerns = new Map(
      checkResult.openConcerns
        ? [[check.name, new Set(checkResult.openConcerns)]]
        : [],
    );

    const seconds = Math.round(
      (Date.now() - started) / MILLISECONDS_PER_SECOND,
    );

    state.checks[check.name] = {
      lastRunAt: now.toISOString(),
      memory,
    };
    log(`${check.name}: ${triggers.length} trigger(s) in ${seconds}s`);

    return firstRun && !check.actOnFirstRun
      ? { triggers: [], baseline: triggers, openConcerns }
      : { triggers, baseline: [], openConcerns };
  } catch (error) {
    log(`${check.name} failed: ${errorMessage(error)}`);

    return {
      triggers: [],
      baseline: [],
      openConcerns: new Map(),
    };
  }
}

async function runDueChecks(
  context: TickContext,
  onlyChecks: string[],
): Promise<CheckOutcome> {
  const due = context.definition.checks.filter((check) =>
    onlyChecks.length > 0
      ? onlyChecks.includes(check.name)
      : isDue(check, context.state.checks[check.name]?.lastRunAt, context.now),
  );

  const outcomes = await Promise.all(
    due.map((check) => runCheck(context, check)),
  );

  return {
    triggers: outcomes.flatMap((outcome) => outcome.triggers),
    baseline: outcomes.flatMap((outcome) => outcome.baseline),
    openConcerns: new Map(
      outcomes.flatMap((outcome) => [...outcome.openConcerns]),
    ),
  };
}

function printDryRun(
  context: TickContext,
  triggers: Trigger[],
  baseline: Trigger[],
): void {
  const fresh = triggers.filter(
    (trigger) => context.state.handled[trigger.key] === undefined,
  );

  for (const trigger of fresh) {
    console.log(
      `\n## ${trigger.tab.label} · ${trigger.playbook}\n${trigger.key}\n\n${trigger.prompt}`,
    );
  }

  context.log(`${triggers.length - fresh.length} trigger(s) already handled`);

  for (const trigger of baseline) {
    console.log(
      `\n## ${trigger.tab.label} · ${trigger.playbook} (first run: recorded, not started)\n${trigger.key}`,
    );
  }
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

    const context: TickContext = {
      definition,
      agentConfig,
      config,
      state,
      repositoryByUrl: new Map(
        repositories.map((repository) => [repository.url, repository]),
      ),
      runsDirectory,
      now,
      log,
    };

    const { triggers, baseline, openConcerns } = await runDueChecks(
      context,
      options.onlyChecks,
    );

    if (options.dryRun) {
      printDryRun(context, triggers, baseline);

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

    updateConcerns(state, openConcerns);

    const added = enqueue(state, triggers);

    if (added > 0) {
      log(`queued ${added} trigger(s)`);
    }

    await ensureSession(agent, join(directory, "tick.log"));
    await followOpenedReviews(context);
    await removeFinishedTabs(context);
    await launchQueued(context);
    writeState(agent, state, now);
  } finally {
    release();
  }
}

// Prepares the worktree and starts the run in the trigger's tab, opening the tab when it is not open; returns the
// tab's record with the run added.
async function startRun(
  context: TickContext,
  trigger: Trigger,
  repository: Repository,
  openRecord: TabRecord | undefined,
): Promise<TabRecord> {
  const agent = context.definition.name;

  const worktree = await prepareWorktree(
    repository,
    trigger.worktree,
    context.definition.playbooks[trigger.playbook]?.runsRepositoryCode === true,
  );

  const launch = await prepareLaunch(
    context.definition,
    context.agentConfig,
    trigger,
    repository,
    worktree,
    context.now,
  );

  let record = openRecord;

  if (record) {
    await addPane(
      agent,
      record.windowId,
      trigger.playbook,
      worktree.path,
      launch.command,
    );
  } else {
    record = {
      ...trigger.tab,
      windowId: await openTab(
        agent,
        trigger.tab.label,
        worktree.path,
        launch.command,
      ),
      worktrees: [],
      runIds: [],
    };
  }

  if (!record.worktrees.some((known) => known.path === worktree.path)) {
    record.worktrees.push({
      repository: repository.url,
      path: worktree.path,
      branch: trigger.worktree.branch,
    });
  }

  record.runIds.push(launch.runId);

  const concern = record.concerns?.find(
    (known) => known.id === trigger.concern,
  );

  if (concern) {
    concern.addressed = false;
  } else {
    record.concerns = [
      ...(record.concerns ?? []),
      {
        check: trigger.check ?? "",
        id: trigger.concern,
        addressed: false,
      },
    ];
  }

  record.lastActivityAt = context.now.toISOString();

  return record;
}

async function launchQueued(context: TickContext): Promise<void> {
  const { state, now, log } = context;
  const agent = context.definition.name;
  const runs = liveRuns(context.runsDirectory);

  const capacity =
    context.agentConfig.maxRunningAgents ?? DEFAULT_MAX_RUNNING_AGENTS;

  let working = [...runs.values()].filter(
    (run) => run.status === "working",
  ).length;

  const windows = await windowIds(agent);
  const waiting: Trigger[] = [];
  // Tabs that got a run in this tick; their status files may not exist yet.
  const startedTabs = new Set<string>();

  for (const trigger of state.queue) {
    const tab = state.tabs[trigger.tab.key];

    const openRecord =
      tab !== undefined && windows.has(tab.windowId) ? tab : undefined;

    const tabBusy =
      startedTabs.has(trigger.tab.key) ||
      (openRecord !== undefined && hasActiveRun(openRecord, runs));

    // Runs in one tab share a worktree, so a second one waits until the first has finished.
    if (working >= capacity || tabBusy) {
      waiting.push(trigger);
      continue;
    }

    const repository = context.repositoryByUrl.get(trigger.repository);

    if (!repository) {
      log(`dropping ${trigger.key}: ${trigger.repository} is not configured`);
      continue;
    }

    try {
      const record = await startRun(context, trigger, repository, openRecord);

      state.tabs[trigger.tab.key] = record;
      windows.add(record.windowId);
      startedTabs.add(trigger.tab.key);
      state.handled[trigger.key] = now.toISOString();
      working += 1;
      log(`started ${trigger.playbook} for ${trigger.tab.label}`);
    } catch (error) {
      const attempts = (state.attempts[trigger.key] ?? 0) + 1;

      state.attempts[trigger.key] = attempts;
      log(
        `could not start ${trigger.key} (attempt ${attempts}): ${errorMessage(error)}`,
      );

      if (attempts < LAUNCH_ATTEMPTS) {
        waiting.push(trigger);
      } else {
        state.handled[trigger.key] = now.toISOString();
      }

      continue;
    }

    if (trigger.notify) {
      await notify(agent, trigger.notify);
    }
  }

  state.queue = waiting;
}

// A tab without a pull request, or whose repository is no longer configured, counts as open: only the user closes it.
async function pullRequestStillOpen(
  context: TickContext,
  tab: TabRecord,
): Promise<boolean> {
  const repository =
    tab.pullRequest && context.repositoryByUrl.get(tab.pullRequest.repository);

  if (!tab.pullRequest || !repository) {
    return true;
  }

  const open = await repository.forge.openPullRequests();

  return open.some((pull) => pull.number === tab.pullRequest?.number);
}

async function shouldClose(
  context: TickContext,
  tab: TabRecord,
  runs: Map<string, RunStatusFile>,
): Promise<boolean> {
  if (!(await pullRequestStillOpen(context, tab))) {
    return true;
  }

  const idleFor = context.now.getTime() - lastActivity(tab, runs);

  return isAddressed(tab) && idleFor >= ADDRESSED_TAB_IDLE_MS;
}

// Removes tabs the user closed, tabs whose pull request is no longer open, and tabs whose concerns are all addressed
// and that have been idle for a while, with their clean worktrees. A tab with an active run is kept; closing a tab ends
// its idle sessions, whose transcripts stay in pi's session files.
async function removeFinishedTabs(context: TickContext): Promise<void> {
  const agent = context.definition.name;
  const windows = await windowIds(agent);
  const runs = liveRuns(context.runsDirectory);

  for (const [key, tab] of Object.entries(context.state.tabs)) {
    const windowOpen = windows.has(tab.windowId);

    if (hasActiveRun(tab, runs)) {
      continue;
    }

    if (windowOpen && !(await shouldClose(context, tab, runs))) {
      continue;
    }

    if (windowOpen) {
      await closeWindow(agent, tab.windowId);
    }

    const kept: string[] = [];

    for (const worktree of tab.worktrees) {
      const repository = context.repositoryByUrl.get(worktree.repository);

      const removed =
        repository !== undefined &&
        (await removeWorktree(repository, worktree.path, worktree.branch));

      if (!removed) {
        kept.push(worktree.path);
      }
    }

    if (kept.length > 0) {
      context.log(`kept ${kept.join(", ")}: uncommitted changes`);
    }

    delete context.state.tabs[key];
    context.log(`removed the tab ${tab.label}`);
  }
}
