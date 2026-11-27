import type { Check, Repository, Tab, Trigger } from "../definition.ts";
import type { FailedJob, JobTiming, Pipeline } from "../forges/types.ts";
import { API_CONCURRENCY, mapWithLimit } from "../exec.ts";
import { shortHash, slug, truncate } from "../text.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// A failure with the same job and error starts one investigation a week.
const REPEAT_AFTER_MS = 7 * DAY_MS;
const GROUP_RETENTION_MS = 30 * DAY_MS;
// A failure that has not happened again for this long counts as addressed.
const FAILURE_ADDRESSED_AFTER_MS = 3 * DAY_MS;
const OCCURRENCES_KEPT = 10;
const LOG_TAIL_LINES = 150;
const LOG_TAIL_MAX_CHARACTERS = 15_000;
const SIGNATURE_MAX_CHARACTERS = 300;
const TAB_JOB_NAME_MAX_CHARACTERS = 60;

const PIPELINES_SAMPLED = 20;
const MINIMUM_PIPELINES = 5;
const SLOWEST_JOBS = 5;
const TABLE_JOBS = 15;
const REGRESSION_RATIO = 1.25;
const REGRESSION_MINIMUM_SECONDS = 60;
const SNAPSHOT_EVERY_MS = DAY_MS;
const SNAPSHOTS_KEPT = 14;
const REFERENCE_MINIMUM_AGE_MS = 5 * DAY_MS;
const RECENT_PIPELINES_SHOWN = 5;
const MEDIAN = 0.5;
const NINETIETH_PERCENTILE = 0.9;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const GITLAB_SECTION = /section_(?:start|end):\d+:[\w.-]+\r?/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;

// GitLab's timestamped logs mark each line with its stream, such as `01O` or `00E+`.
const GITLAB_STREAM = /^\d{2}[OE]\+?\s?/;
const GITLAB_COLLAPSED = /^\[collapsed=(?:true|false)\]/;

const ERROR_LINE =
  /\b(?:FAIL|FAILED|Error|ERROR|error|panicked|AssertionError|assert|Timeout|timed out|not ok)\b/;

const RUNNER_LINE =
  /^(?:ERROR: Job failed|Cleaning up|Uploading artifacts|##\[error\]Process completed with exit code|ELIFECYCLE|npm ERR! (?:code|path|command|A complete log))/;

export function logLines(log: string): string[] {
  return log
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(ANSI, "")
        .replace(GITLAB_SECTION, "")
        .replace(TIMESTAMP, "")
        .replace(GITLAB_STREAM, "")
        .replace(GITLAB_COLLAPSED, "")
        .trimEnd(),
    )
    .filter((line) => line.trim() !== "");
}

// The first error line near the end of the log, with numbers, hashes, and durations replaced, so the same failure in
// another run gets the same signature.
export function errorSignature(lines: string[]): string {
  const tail = lines.slice(-LOG_TAIL_LINES);

  const line =
    tail.find(
      (candidate) =>
        ERROR_LINE.test(candidate) && !RUNNER_LINE.test(candidate.trim()),
    ) ??
    tail.at(-1) ??
    "";

  return line
    .trim()
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hash>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .slice(0, SIGNATURE_MAX_CHARACTERS);
}

interface FailureGroup {
  handledAt?: string;
  occurrences: {
    url: string;
    finishedAt: string;
    where: string;
  }[];
}

interface FailureMemory {
  since?: Record<string, string>;
  groups?: Record<string, FailureGroup>;
}

function trunkWorktree(
  trunk: string,
  branch: string,
  extraFetch: string[] = [],
): Trigger["worktree"] {
  return {
    branch,
    fetch: [trunk, ...extraFetch],
    start: `origin/${trunk}`,
  };
}

function jobTab(repository: Repository, prefix: string, jobName: string): Tab {
  return {
    key: `${repository.url}:${prefix}:${jobName}`,
    label: `${prefix} - ${truncate(jobName, TAB_JOB_NAME_MAX_CHARACTERS)}`,
  };
}

async function failureTriggers(
  repository: Repository,
  memory: FailureMemory,
  now: Date,
): Promise<Trigger[]> {
  const since = (memory.since ??= {});
  const groups = (memory.groups ??= {});
  const { forge } = repository;
  const trunk = await forge.defaultBranch();
  const pulls = await forge.openPullRequests();
  // The first run only sets the cursor; failures from before the agent was installed are not investigated.
  const start = since[repository.url] ?? now.toISOString();

  const jobs = (await forge.failedJobs(new Date(start))).sort(
    (a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt),
  );

  const triggers: Trigger[] = [];
  const latest = jobs.at(-1)?.finishedAt ?? start;

  const pullFor = (job: FailedJob) =>
    pulls.find(
      (candidate) =>
        candidate.number === job.pullRequest ||
        (job.pullRequest === undefined &&
          candidate.sourceBranch === job.branch),
    );

  const relevant = jobs.filter(
    (job) => pullFor(job) !== undefined || job.branch === trunk,
  );

  const logs = await mapWithLimit(relevant, API_CONCURRENCY, (job) =>
    forge.jobLog(job),
  );

  for (const [index, job] of relevant.entries()) {
    const pull = pullFor(job);
    const lines = logLines(logs[index]);
    const signature = errorSignature(lines);
    const groupKey = `${repository.url}:${job.name}:${shortHash(signature)}`;
    const group = (groups[groupKey] ??= { occurrences: [] });
    const where = pull ? `${pull.url} (${pull.author})` : trunk;

    group.occurrences = [
      ...group.occurrences,
      {
        url: job.url,
        finishedAt: job.finishedAt,
        where,
      },
    ].slice(-OCCURRENCES_KEPT);

    const handledRecently =
      group.handledAt !== undefined &&
      now.getTime() - Date.parse(group.handledAt) < REPEAT_AFTER_MS;

    if (handledRecently) {
      continue;
    }

    group.handledAt = now.toISOString();
    triggers.push(
      failureTrigger(repository, {
        groupKey,
        job,
        trunk,
        where,
        signature,
        lines,
        group,
        pullHeadRef: pull?.headRef,
      }),
    );
  }

  since[repository.url] = latest;

  return triggers;
}

function forgetOldGroups(memory: FailureMemory, now: Date): void {
  for (const [key, group] of Object.entries(memory.groups ?? {})) {
    const last = group.occurrences.at(-1);

    if (
      !last ||
      now.getTime() - Date.parse(last.finishedAt) > GROUP_RETENTION_MS
    ) {
      delete memory.groups?.[key];
    }
  }
}

interface Failure {
  groupKey: string;
  job: FailedJob;
  trunk: string;
  // Where the job ran: the pull request and its author, or the default branch.
  where: string;
  signature: string;
  lines: string[];
  group: FailureGroup;
  pullHeadRef: string | undefined;
}

function failureTrigger(
  repository: Repository,
  {
    groupKey,
    job,
    trunk,
    where,
    signature,
    lines,
    group,
    pullHeadRef,
  }: Failure,
): Trigger {
  const occurrences = group.occurrences
    .map(
      (occurrence) =>
        `- ${occurrence.finishedAt} ${occurrence.url} on ${occurrence.where}`,
    )
    .join("\n");

  const allowed = job.allowedToFail
    ? " The job is allowed to fail, so it did not block the pipeline."
    : "";

  return {
    key: `ci:${repository.url}:${job.id}`,
    concern: `ci:${groupKey}`,
    playbook: "ci-failure",
    repository: repository.url,
    tab: jobTab(repository, "ci", job.name),
    worktree: trunkWorktree(
      trunk,
      `todai/ci-${slug(job.name)}`,
      pullHeadRef ? [pullHeadRef] : [],
    ),
    prompt: `The CI job \`${job.name}\` failed on ${where} at commit ${job.sha}: ${job.url}.${allowed}

The worktree is on \`origin/${trunk}\`.${
      pullHeadRef
        ? ` The pull request's head has been fetched; if \`git show ${job.sha}\` fails, the failing commit is a merge result, so run \`git fetch origin ${pullHeadRef.replace(/\/head$/, "/merge")}\` first.`
        : ""
    }

Error signature: \`${signature}\`

Failures with this signature seen recently:
${occurrences}

End of the job log:

\`\`\`
${truncate(lines.slice(-LOG_TAIL_LINES).join("\n"), LOG_TAIL_MAX_CHARACTERS)}
\`\`\``,
  };
}

export const ciFailuresCheck: Check = {
  name: "ci-failures",
  everyMinutes: 5,
  async run(context) {
    // SAFETY: only this check writes its memory, and only with this shape.
    const memory = context.memory as FailureMemory;
    const triggers: Trigger[] = [];

    for (const repository of context.repositories) {
      triggers.push(
        ...(await failureTriggers(repository, memory, context.now)),
      );
    }

    forgetOldGroups(memory, context.now);

    const recentGroups = Object.entries(memory.groups ?? {}).filter(
      ([, group]) => {
        const last = group.occurrences.at(-1);

        return (
          last !== undefined &&
          context.now.getTime() - Date.parse(last.finishedAt) <
            FAILURE_ADDRESSED_AFTER_MS
        );
      },
    );

    return {
      triggers,
      openConcerns: recentGroups.map(([groupKey]) => `ci:${groupKey}`),
    };
  },
};

interface JobSummary {
  name: string;
  median: number;
  p90: number;
  reference?: number;
}

interface Snapshot {
  at: string;
  medians: Record<string, number>;
}

interface SpeedMemory {
  snapshots?: Record<string, Snapshot[]>;
  handled?: Record<string, string>;
  // Job timings by repository and pipeline id, so each run fetches only new pipelines.
  jobs?: Record<string, Record<string, JobTiming[]>>;
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);

  return (
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ??
    0
  );
}

function jobSummaries(
  jobs: JobTiming[][],
  reference: Record<string, number> | undefined,
): JobSummary[] {
  const durations = new Map<string, number[]>();

  for (const job of jobs.flat()) {
    durations.set(job.name, [...(durations.get(job.name) ?? []), job.seconds]);
  }

  return [...durations.entries()]
    .map(([name, seconds]) => ({
      name,
      median: percentile(seconds, MEDIAN),
      p90: percentile(seconds, NINETIETH_PERCENTILE),
      reference: reference?.[name],
    }))
    .sort((a, b) => b.median - a.median);
}

function isRegression(timing: JobSummary): boolean {
  return (
    timing.reference !== undefined &&
    timing.median > timing.reference * REGRESSION_RATIO &&
    timing.median - timing.reference > REGRESSION_MINIMUM_SECONDS
  );
}

function formatSeconds(seconds: number | undefined): string {
  return seconds === undefined ? "-" : `${Math.round(seconds)}s`;
}

function speedTrigger(
  repository: Repository,
  trunk: string,
  pipelines: Pipeline[],
  timings: JobSummary[],
  chosen: JobSummary,
  now: Date,
): Trigger {
  const reason = isRegression(chosen)
    ? `its median went from ${formatSeconds(chosen.reference)} to ${formatSeconds(chosen.median)} in about a week`
    : `it is one of the ${SLOWEST_JOBS} slowest jobs`;

  const table = timings
    .slice(0, TABLE_JOBS)
    .map(
      (timing) =>
        `| ${timing.name} | ${formatSeconds(timing.median)} | ${formatSeconds(timing.p90)} | ${formatSeconds(timing.reference)} |`,
    )
    .join("\n");

  const pipelineMedian = percentile(
    pipelines.map((pipeline) => pipeline.seconds),
    MEDIAN,
  );

  const [date] = now.toISOString().split("T");

  return {
    key: `ci-speed:${repository.url}:${chosen.name}:${date}`,
    concern: `ci-speed:${repository.url}:${chosen.name}`,
    playbook: "ci-speed",
    repository: repository.url,
    tab: jobTab(repository, "ci speed", chosen.name),
    worktree: trunkWorktree(trunk, `todai/ci-speed-${slug(chosen.name)}`),
    prompt: `Make the CI job \`${chosen.name}\` faster: ${reason}.

Timings from the last ${pipelines.length} successful pipelines on ${trunk}; the median pipeline took ${formatSeconds(pipelineMedian)}. The reference column is the median about a week ago.

| Job | Median | p90 | Reference |
| --- | --- | --- | --- |
${table}

Recent pipelines:
${pipelines
  .slice(0, RECENT_PIPELINES_SHOWN)
  .map((pipeline) => `- ${pipeline.url} (${formatSeconds(pipeline.seconds)})`)
  .join("\n")}`,
  };
}

// Job timings for the pipelines, fetching only those not cached from earlier runs.
async function cachedPipelineJobs(
  repository: Repository,
  memory: SpeedMemory,
  pipelines: Pipeline[],
): Promise<Record<string, JobTiming[]>> {
  const cached = (memory.jobs ??= {})[repository.url] ?? {};
  const missing = pipelines.filter((pipeline) => !cached[pipeline.id]);

  const fetched = await mapWithLimit(missing, API_CONCURRENCY, (pipeline) =>
    repository.forge.pipelineJobs(pipeline),
  );

  const jobsByPipeline = Object.fromEntries(
    pipelines.map((pipeline) => [
      pipeline.id,
      cached[pipeline.id] ?? fetched[missing.indexOf(pipeline)],
    ]),
  );

  memory.jobs[repository.url] = jobsByPipeline;

  return jobsByPipeline;
}

// Adds today's medians unless a snapshot was taken in the last day.
function withSnapshot(
  snapshots: Snapshot[],
  timings: JobSummary[],
  now: Date,
): Snapshot[] {
  const latest = snapshots.at(-1);

  if (latest && now.getTime() - Date.parse(latest.at) < SNAPSHOT_EVERY_MS) {
    return snapshots;
  }

  return [
    ...snapshots,
    {
      at: now.toISOString(),
      medians: Object.fromEntries(
        timings.map((timing) => [timing.name, timing.median]),
      ),
    },
  ].slice(-SNAPSHOTS_KEPT);
}

async function speedTriggerFor(
  repository: Repository,
  memory: SpeedMemory,
  now: Date,
): Promise<Trigger | undefined> {
  const snapshotsByRepository = (memory.snapshots ??= {});
  const handled = (memory.handled ??= {});
  const trunk = await repository.forge.defaultBranch();

  const pipelines = await repository.forge.successfulPipelines(
    trunk,
    PIPELINES_SAMPLED,
  );

  if (pipelines.length < MINIMUM_PIPELINES) {
    return undefined;
  }

  const jobsByPipeline = await cachedPipelineJobs(
    repository,
    memory,
    pipelines,
  );

  const snapshots = snapshotsByRepository[repository.url] ?? [];

  const reference = snapshots.find(
    (snapshot) =>
      now.getTime() - Date.parse(snapshot.at) >= REFERENCE_MINIMUM_AGE_MS,
  );

  const timings = jobSummaries(
    Object.values(jobsByPipeline),
    reference?.medians,
  );

  snapshotsByRepository[repository.url] = withSnapshot(snapshots, timings, now);

  const slowdown = (timing: JobSummary) =>
    timing.median - (timing.reference ?? timing.median);

  const regressions = timings
    .filter(isRegression)
    .sort((a, b) => slowdown(b) - slowdown(a));

  const candidates = [...regressions, ...timings.slice(0, SLOWEST_JOBS)];

  const chosen = candidates.find((timing) => {
    const at = handled[`${repository.url}:${timing.name}`];

    return !at || now.getTime() - Date.parse(at) >= REPEAT_AFTER_MS;
  });

  if (!chosen) {
    return undefined;
  }

  handled[`${repository.url}:${chosen.name}`] = now.toISOString();

  return speedTrigger(repository, trunk, pipelines, timings, chosen, now);
}

// Starts at most one optimisation per run, so an hourly schedule cannot flood the session.
export const ciSpeedCheck: Check = {
  name: "ci-speed",
  everyMinutes: 60,
  actOnFirstRun: true,
  workingHours: {
    from: 10,
    to: 19,
  },
  async run(context) {
    // SAFETY: only this check writes its memory, and only with this shape.
    const memory = context.memory as SpeedMemory;

    // Each hour starts with a different repository, so one with many slow jobs cannot starve the others.
    const offset =
      context.now.getHours() % Math.max(1, context.repositories.length);

    const repositories = [
      ...context.repositories.slice(offset),
      ...context.repositories.slice(0, offset),
    ];

    for (const repository of repositories) {
      const trigger = await speedTriggerFor(repository, memory, context.now);

      if (trigger) {
        return { triggers: [trigger] };
      }
    }

    return { triggers: [] };
  },
};
