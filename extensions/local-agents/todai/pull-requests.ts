import { formatReport } from "../../hygiene/format.ts";
import { lint } from "../../hygiene/lint.ts";
import type {
  Check,
  CheckContext,
  Repository,
  Tab,
  Trigger,
} from "../definition.ts";
import { runProgram } from "../../shared/exec.ts";
import { API_CONCURRENCY, mapWithLimit } from "../exec.ts";
import type { PullRequest, Thread } from "../forges/types.ts";
import { errorMessage } from "../errors.ts";
import { shortHash, truncate } from "../text.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAIN_COMMENT_MAX_AGE_MS = 7 * DAY_MS;
const REVIEW_WARNINGS_MAX_COUNT = 10;
const REPORT_MAX_CHARACTERS = 20_000;
const NOTE_MAX_CHARACTERS = 2_000;
const LINT_CONCURRENCY = 4;
const TAB_TITLE_MAX_CHARACTERS = 60;

export function pullRequestTab(repository: Repository, pull: PullRequest): Tab {
  const prefix = repository.forge.reviewPrefix;

  return {
    key: `${repository.url}${prefix}${pull.number}`,
    label: `${prefix}${pull.number} - ${truncate(pull.title, TAB_TITLE_MAX_CHARACTERS)}`,
    pullRequest: {
      repository: repository.url,
      number: pull.number,
    },
  };
}

function pullRequestWorktree(
  repository: Repository,
  pull: PullRequest,
): Trigger["worktree"] {
  return {
    branch: `todai/${repository.forge.reviewKind}-${pull.number}`,
    fetch: [pull.headRef],
    start: pull.headSha,
  };
}

function describe(pull: PullRequest): string {
  return `"${pull.title}" (${pull.url}) by ${pull.author}, from ${pull.sourceBranch} into ${pull.targetBranch}`;
}

function pullRequestTrigger(
  repository: Repository,
  pull: PullRequest,
  fields: Pick<
    Trigger,
    "key" | "concern" | "playbook" | "prompt" | "push" | "notify"
  >,
): Trigger {
  return {
    ...fields,
    repository: repository.url,
    tab: pullRequestTab(repository, pull),
    worktree: pullRequestWorktree(repository, pull),
    review: {
      number: pull.number,
      url: pull.url,
    },
  };
}

async function ownPullRequests(repository: Repository): Promise<PullRequest[]> {
  const username = await repository.forge.currentUser();

  return (await repository.forge.openPullRequests()).filter(
    (pull) => pull.author === username,
  );
}

function rebaseTrigger(repository: Repository, pull: PullRequest): Trigger {
  return pullRequestTrigger(repository, pull, {
    key: `rebase:${repository.url}:${pull.number}:${pull.headSha}`,
    concern: `conflicts:${pullRequestTab(repository, pull).key}`,
    playbook: "rebase",
    push: {
      branch: pull.sourceBranch,
      expectedSha: pull.headSha,
      askFirst: false,
    },
    prompt: `Your ${describe(pull)} has conflicts with ${pull.targetBranch}.

The worktree is at its head ${pull.headSha} on the local branch \`${pullRequestWorktree(repository, pull).branch}\`. Run \`git fetch origin ${pull.targetBranch}\` and rebase onto \`origin/${pull.targetBranch}\`, resolve the conflicts, run the checks that cover what you touched, and push with push_branch.`,
  });
}

export const conflictsCheck: Check = {
  name: "conflicts",
  everyMinutes: 5,
  async run(context) {
    const triggers: Trigger[] = [];
    const openConcerns: string[] = [];

    for (const repository of context.repositories) {
      const pulls = (await ownPullRequests(repository)).filter(
        (pull) => !pull.fromFork,
      );

      const statuses = await mapWithLimit(pulls, API_CONCURRENCY, (pull) =>
        repository.forge.conflictStatus(pull),
      );

      for (const [index, pull] of pulls.entries()) {
        // A status the forge is still computing is not proof the conflicts are gone.
        if (statuses[index] !== "mergeable") {
          openConcerns.push(
            `conflicts:${pullRequestTab(repository, pull).key}`,
          );
        }

        if (statuses[index] === "conflicting") {
          triggers.push(rebaseTrigger(repository, pull));
        }
      }
    }

    return {
      triggers,
      openConcerns,
    };
  },
};

function needsAttention(
  thread: Thread,
  username: string,
  seen: Set<string>,
  now: Date,
): boolean {
  const last = thread.notes.at(-1);

  if (!last || last.author === username || last.authorIsBot) {
    return false;
  }

  if (thread.resolvable) {
    return !thread.resolved;
  }

  return (
    !seen.has(last.id) &&
    now.getTime() - Date.parse(last.createdAt) < PLAIN_COMMENT_MAX_AGE_MS
  );
}

// A reviewer is still waiting: an unresolved review thread where someone else spoke last, or a plain comment by
// someone else newer than the user's latest note.
export function awaitsReply(threads: Thread[], username: string): boolean {
  const notes = threads.flatMap((thread) => thread.notes);

  const lastOwnNote = Math.max(
    0,
    ...notes.flatMap((note) =>
      note.author === username ? [Date.parse(note.createdAt)] : [],
    ),
  );

  return threads.some((thread) => {
    const last = thread.notes.at(-1);

    if (!last || last.author === username || last.authorIsBot) {
      return false;
    }

    return thread.resolvable
      ? !thread.resolved
      : Date.parse(last.createdAt) > lastOwnNote;
  });
}

function formatThread(thread: Thread, seen: Set<string>): string {
  const location = thread.path
    ? `${thread.path}${thread.line ? `:${thread.line}` : ""}`
    : "General comment";

  const notes = thread.notes.map((note) => {
    const marker = seen.has(note.id) ? "" : " (new)";

    return `- ${note.author}${marker}, ${note.createdAt}, ${note.url ?? ""}\n  ${truncate(note.body, NOTE_MAX_CHARACTERS).replaceAll("\n", "\n  ")}`;
  });

  return `### ${location}\n${notes.join("\n")}`;
}

function commentsTrigger(
  repository: Repository,
  pull: PullRequest,
  attention: Thread[],
  fresh: Thread[],
  seen: Set<string>,
): Trigger {
  const tab = pullRequestTab(repository, pull);

  const freshIds = fresh.flatMap((thread) =>
    thread.notes.map((note) => note.id),
  );

  return pullRequestTrigger(repository, pull, {
    key: `comments:${tab.key}:${shortHash(freshIds.sort().join(","))}`,
    concern: `comments:${tab.key}`,
    playbook: "comments",
    notify: `${tab.label}: ${fresh.length} comment thread(s) need you`,
    push: {
      branch: pull.sourceBranch,
      expectedSha: pull.headSha,
      askFirst: true,
    },
    prompt: `Your ${describe(pull)} has comments waiting for you. The worktree is at its head ${pull.headSha}.

${attention.map((thread) => formatThread(thread, seen)).join("\n\n")}`,
  });
}

// A record of the check's memory by tab key, created on first use.
function memoryRecord<T>(
  memory: Record<string, unknown>,
  name: string,
): Record<string, T> {
  // SAFETY: only this file's checks write their memory, and each name always holds a record of one value type.
  return (memory[name] ??= {}) as Record<string, T>;
}

// Drops the memory of tabs whose pull request is no longer open.
function forgetClosedTabs(
  openTabs: Set<string>,
  ...records: Record<string, unknown>[]
): void {
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!openTabs.has(key)) {
        delete record[key];
      }
    }
  }
}

export const commentsCheck: Check = {
  name: "comments",
  everyMinutes: 5,
  async run(context) {
    const triggers: Trigger[] = [];
    const seenByTab = memoryRecord<string[]>(context.memory, "seen");

    const updatedByTab = memoryRecord<string>(context.memory, "updatedAt");

    const awaitingByTab = memoryRecord<boolean>(
      context.memory,
      "awaitingReply",
    );

    const openTabs = new Set<string>();

    for (const repository of context.repositories) {
      const username = await repository.forge.currentUser();
      const own = await ownPullRequests(repository);

      const tabKey = (pull: PullRequest) =>
        pullRequestTab(repository, pull).key;

      for (const pull of own) {
        openTabs.add(tabKey(pull));
      }

      // A new comment changes the merge request's update time, so unchanged ones need no thread fetch.
      const pulls = own.filter(
        (pull) => updatedByTab[tabKey(pull)] !== pull.updatedAt,
      );

      const threadsByPull = await mapWithLimit(pulls, API_CONCURRENCY, (pull) =>
        repository.forge.threads(pull),
      );

      for (const [index, pull] of pulls.entries()) {
        const key = tabKey(pull);
        const seen = new Set(seenByTab[key] ?? []);
        const threads = threadsByPull[index];

        const attention = threads.filter((thread) =>
          needsAttention(thread, username, seen, context.now),
        );

        const fresh = attention.filter((thread) =>
          thread.notes.some((note) => !seen.has(note.id)),
        );

        updatedByTab[key] = pull.updatedAt;
        awaitingByTab[key] = awaitsReply(threads, username);
        seenByTab[key] = threads.flatMap((thread) =>
          thread.notes.map((note) => note.id),
        );

        if (fresh.length > 0) {
          triggers.push(
            commentsTrigger(repository, pull, attention, fresh, seen),
          );
        }
      }
    }

    forgetClosedTabs(openTabs, seenByTab, updatedByTab, awaitingByTab);

    return {
      triggers,
      openConcerns: Object.entries(awaitingByTab).flatMap(([key, awaiting]) =>
        awaiting ? [`comments:${key}`] : [],
      ),
    };
  },
};

async function reviewDiff(
  repository: Repository,
  pull: PullRequest,
): Promise<string> {
  const git = (...args: string[]) =>
    runProgram("git", args, { cwd: repository.path });

  const base = await git(
    "merge-base",
    `origin/${pull.targetBranch}`,
    pull.headSha,
  );

  return git("diff", base, pull.headSha);
}

async function hygieneTrigger(
  context: CheckContext,
  repository: Repository,
  pull: PullRequest,
): Promise<Trigger | undefined> {
  const report = await lint({
    root: repository.path,
    ref: pull.headSha,
    diffText: await reviewDiff(repository, pull),
    clef: context.config.clef,
  });

  const errors = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;

  const warnings = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  ).length;

  context.log(
    `${repository.url} ${pull.number}: ${errors} error(s), ${warnings} warning(s)`,
  );

  if (errors === 0 && warnings < REVIEW_WARNINGS_MAX_COUNT) {
    return undefined;
  }

  const tab = pullRequestTab(repository, pull);

  return pullRequestTrigger(repository, pull, {
    key: `review:${tab.key}:${pull.headSha}`,
    concern: `hygiene:${tab.key}`,
    playbook: "review",
    notify: `${tab.label}: ${errors} hygiene error(s), ${warnings} warning(s)`,
    prompt: `The hygiene linter flagged ${describe(pull)} at ${pull.headSha}: ${errors} error(s) and ${warnings} warning(s). The worktree is checked out at that commit.

Hygiene report:

${truncate(formatReport(report), REPORT_MAX_CHARACTERS)}`,
  });
}

export const hygieneCheck: Check = {
  name: "hygiene",
  everyMinutes: 5,
  async run(context) {
    const triggers: Trigger[] = [];

    const lintedByTab = memoryRecord<string>(context.memory, "linted");

    const flaggedByTab = memoryRecord<boolean>(context.memory, "flagged");

    const openTabs = new Set<string>();

    for (const repository of context.repositories) {
      const username = await repository.forge.currentUser();

      const pulls = (await repository.forge.openPullRequests()).filter(
        (pull) => pull.author !== username && !pull.authorIsBot && !pull.draft,
      );

      const tabKey = (pull: PullRequest) =>
        pullRequestTab(repository, pull).key;

      const unlinted = pulls.filter(
        (pull) => lintedByTab[tabKey(pull)] !== pull.headSha,
      );

      for (const pull of pulls) {
        openTabs.add(tabKey(pull));
      }

      // The first run records the current heads without linting them, since its triggers would not start anyway.
      if (context.firstRun) {
        for (const pull of pulls) {
          lintedByTab[tabKey(pull)] = pull.headSha;
        }

        continue;
      }

      if (unlinted.length === 0) {
        continue;
      }

      // One fetch for every merge request, since parallel fetches into one clone contend for its ref locks.
      await runProgram(
        "git",
        [
          "fetch",
          "origin",
          ...new Set(
            unlinted.flatMap((pull) => [pull.headRef, pull.targetBranch]),
          ),
        ],
        { cwd: repository.path },
      );

      const lintTriggers = await mapWithLimit(
        unlinted,
        LINT_CONCURRENCY,
        (pull) =>
          hygieneTrigger(context, repository, pull).then(
            (trigger) => {
              lintedByTab[tabKey(pull)] = pull.headSha;
              flaggedByTab[tabKey(pull)] = trigger !== undefined;

              return trigger;
            },
            (error: unknown) => {
              context.log(`could not lint ${pull.url}: ${errorMessage(error)}`);

              return undefined;
            },
          ),
      );

      triggers.push(...lintTriggers.filter((trigger) => trigger !== undefined));
    }

    forgetClosedTabs(openTabs, lintedByTab, flaggedByTab);

    return {
      triggers,
      openConcerns: Object.entries(flaggedByTab).flatMap(([key, flagged]) =>
        flagged ? [`hygiene:${key}`] : [],
      ),
    };
  },
};
