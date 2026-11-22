import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  AUDIT_MESSAGE_TYPE,
  renderAuditMessage,
  serializeAuditMessage,
  type AuditMessageInput,
} from "./audit-message.ts";
import {
  askClef,
  type ClefAnswers,
  type ClefQuestion,
} from "../shared/clef.ts";
import { loadConfig, type ClefConfig } from "../shared/config.ts";
import {
  AuditDecisionSchema,
  classifyResults,
  FindingsReportSchema,
  LedgerEntrySchema,
  type AuditorOutcome,
  type AuditorResult,
  type FindingsReport,
  type LedgerEntry,
} from "./findings.ts";
import { formatterRuns } from "./formatters.ts";
import { countLines, git, LITERAL_PATHSPECS, shellQuote } from "./git.ts";
import {
  collectContributions,
  type Auditor,
  type CorrectnessContext,
} from "./contributions.ts";
import { reviewComments } from "./comment-review.ts";
import { hygieneAudit, reportedSection, withoutRepeats } from "./hygiene.ts";
import { decideOptOut, startOptOutCheck, type OptOutCheck } from "./opt-out.ts";
import {
  checkoutPullRequest,
  linkedPullRequests,
  pullRequestInfo,
  pullRequestIntro,
  pullRequestStack,
  type PullRequest,
  type PullRequestCheckout,
  type PullRequestInfo,
  type StackFrame,
} from "./pr-review.ts";
import {
  auditBase,
  changedPaths,
  locateFile,
  snapshotPaths,
  worktreeState,
  type RepoChange,
} from "./tracking.ts";

const execFileAsync = promisify(execFile);

// Started once the hygiene linter has run: refactor-review is told what the linter already reported, comment-review
// judges the linter's comment candidates, and code-restraint-review stands in for the linter when Clef is unreachable.
interface LintedAuditors {
  refactor: Auditor;
  comment: Auditor;
  codeRestraint: Auditor;
}

const COMMENT_AUDITOR: Auditor = {
  type: "comment-review",
  title: "Comments",
  idPrefix: "CM",
  focus:
    "Judge each comment below against the comment rule. Do not edit files.",
};

// refactor-review always runs: on 20 recorded audits, a gate on the linter's diagnostics and the change size had to
// run it on 18 to catch 13 of the 15 with valid findings.
const AUDITORS: LintedAuditors = {
  refactor: {
    type: "refactor-review",
    title: "Refactoring",
    idPrefix: "R",
    focus: "Audit the changes with the refactoring skill.",
  },
  comment: COMMENT_AUDITOR,
  codeRestraint: {
    type: "code-restraint-review",
    title: "Code restraint",
    idPrefix: "CR",
    focus: "Audit the changes against the code-restraint skill.",
  },
};

// When Clef could not judge the hygiene candidates, code-restraint-review covers changes this large.
const FALLBACK_REVIEW_MIN_LINES = 50;

const AUDITOR_TYPES = new Set([
  "code-restraint-review",
  "comment-review",
  "refactor-review",
  "correctness-review",
]);

const AUDIT_DESCRIPTION = "Post-change audit";

// Subagent sessions load their own copy of this extension in the same process; this global lets them
// report the paths they change and their review findings to the root session, which audits all of the work at once.
const HUB_KEY = Symbol.for("post-change-audit:hub");

// A root session started before an update keeps its old hub while new subagents load the updated
// extension from disk, so bump this whenever AuditHub changes. Hubs from before versioning have no version.
const HUB_VERSION = 3;
const MAX_FIX_ROUNDS = 2;
const AUDITOR_MAX_TURNS = 30;
const AUTO_AUDIT_MIN_LINES = 50;
const CORRECTNESS_MIN_LINES = 100;

// /correctness and /review-mr reviewers may write and run tests, which costs turns.
const CORRECTNESS_MAX_TURNS = 150;
const SPAWN_TIMEOUT_MS = 5_000;
const STATUS_KEY = "post-change-audit";
const LEDGER_ENTRY_TYPE = "post-change-audit:ledger";
const LEDGER_LIMIT = 30;
const CLEF_RISK_THRESHOLD = 0.8;

const CLEF_RISK_QUESTION: ClefQuestion = {
  type: "noul",
  instructions: [
    "Does this diff change runtime behavior in a way that is easy to get subtly wrong and deserves a dedicated correctness review?",
    "Risky: concurrency, ordering of events or async work, retries, timers or alarms, caching, storage or persisted formats, state machines, error and failure paths, resource cleanup.",
    "Not risky: documentation, comments, formatting, renames, dependency bumps, test-only changes, tooling config, or plain additions with none of those concerns.",
  ].join(" "),
  criteria: {
    true: "Needs a correctness review",
    false: "Safe to skip a correctness review",
  },
};

const FORMAT_TIMEOUT_MS = 60_000;

const DIFF_SCOPE_RULE =
  "The diff commands above already compare against the right base. Never diff against origin/main or any other ref yourself.";

const AGENT_AUDIT_INTRO =
  "Audit only the changes an agent just made. Do not edit files.";
const AGENT_CORRECTNESS_INTRO =
  "Review the correctness of the changes an agent just made.";

const AUTOMATIC_CORRECTNESS_RULE =
  "Review by reading and reasoning only: do not write or run tests, and start no simulations. /correctness does those.";

const MANUAL_CORRECTNESS_INTRO =
  "The user ran /correctness to review the correctness of these changes.";

const REPORT_INSTRUCTIONS = [
  "Call report_findings exactly once at the end, with every finding or with clean set to true and no findings. Only that report is read; your final message is not.",
  "Give each finding's column, and its endLine when it spans several lines, whenever it points at a specific span.",
].join(" ");

const PR_AUDITORS: LintedAuditors = {
  refactor: {
    type: "refactor-review",
    title: "Refactorability and scope",
    idPrefix: "R",
    focus: [
      "Audit the changes with the refactoring skill: self-contained concerns worth extracting, hand-written logic repeated across sites, long or multi-path functions, and oversized test files.",
      "Also judge scope creep against the purpose stated in the title and description: list every separable change with why it is separable, then propose a split into reviewable steps.",
    ].join(" "),
  },
  comment: COMMENT_AUDITOR,
  codeRestraint: {
    type: "code-restraint-review",
    title: "Code restraint",
    idPrefix: "CR",
    focus:
      "Audit the changes against the code-restraint skill: comment density and duplication, premature abstraction and one-consumer modules, misplaced code, dense one-liners, and limits with no stated basis.",
  },
};

const PR_AUDITOR_MAX_TURNS = 60;

const PR_CORRECTNESS_EXPECTATIONS = [
  "Derive the safety invariants from the description and the code before hunting for bugs.",
  "In each finding's claim give the failure scenario and its proof (a reasoning chain, or a failing test's path with any test run URL).",
  "When a suite fails, run it on the base too, so failures that predate the change are not blamed on it.",
  "Put the doubts you disproved and the path of any worktree that holds your tests in notes, and every test run URL with its result in batches.",
].join("\n");

const PR_BRIEF_FORMAT = [
  "Write the review for the user to filter down:",
  "- Open with a two- or three-sentence verdict.",
  "- ## Correctness: each finding as **C1 (severity): one-line claim** with Where, What happens, Proof, How bad, and What to ask for. Before writing How bad, check whether production can reach it, for example by finding the real callers. Then the doubts disproved, then which failures predate the change.",
  "- ## Scope creep: a table of separable changes and why each is separable, then a proposed split.",
  "- ## Refactorability and ## Code restraint: numbered items (R1, HR1, CR1, CM1, ...) with file:line and the fix.",
  "- ## Where things are: worktrees holding new tests, and every test run URL with its result.",
  "When the review covers a stack, name the frame of every finding.",
  "Merge duplicates across reviewers and omit empty sections.",
].join("\n");

const MAX_LINKED_REVIEWS = 3;

const SubagentEventSchema = Type.Object({
  id: Type.String(),
  description: Type.Optional(Type.String()),
  result: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

interface AuditorRun {
  type: string;
  title: string;
  // Prepended to each finding's id, such as CR in CR1.
  idPrefix: string;
  prompt: string;
  // Unset leaves the agent definition's own max_turns in force.
  maxTurns?: number;
  // Unset leaves the agent definition's own thinking level in force.
  thinkingLevel?: "medium";
}

interface AuditHub {
  version: typeof HUB_VERSION;
  touchPaths(root: string, paths: string[]): void;
  // False when no audit is waiting for this agent.
  reportFindings(agentKey: string, report: FindingsReport): boolean;
  // Agent types other packages contributed as auditors, which get report_findings like the built-in ones.
  auditorTypes: Set<string>;
}

async function repoRoot(dir: string): Promise<string | undefined> {
  try {
    return await git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

function diffCommand(change: RepoChange, from: string): string {
  const command = `git -C ${shellQuote(change.root)} diff ${from} ${change.current}`;

  if (change.paths.length === 0) {
    return command;
  }

  return `${command} -- ${change.paths.map(shellQuote).join(" ")}`;
}

function totalLines(changes: RepoChange[]): number {
  return changes.reduce((sum, change) => sum + change.lines, 0);
}

async function correctnessRisk(
  changes: RepoChange[],
  clef: ClefConfig | undefined,
  signal: AbortSignal,
): Promise<ClefAnswers<"risky">> {
  const diffs = await Promise.all(
    changes.map(async (change) => {
      const diff = await git(
        change.root,
        ["diff", change.base, change.current, "--", ...change.paths],
        {
          env: LITERAL_PATHSPECS,
          signal,
        },
      );

      return `Repository: ${change.root}\n${diff}`;
    }),
  );

  return askClef(
    clef,
    diffs.join("\n\n"),
    { risky: CLEF_RISK_QUESTION },
    signal,
  );
}

function isAuditHub(value: unknown): value is AuditHub {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === HUB_VERSION
  );
}

function auditHub(): AuditHub | undefined {
  const value: unknown = Reflect.get(globalThis, HUB_KEY);

  return isAuditHub(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function repoSection(change: RepoChange): string[] {
  const lines = [
    `Repository: ${change.root}`,
    `Base: ${change.baseDescription}`,
    `Diff: ${diffCommand(change, change.base)}`,
    "Changed files:",
    change.files,
  ];

  if (change.previous) {
    lines.push(
      `New since the last audit: ${diffCommand(change, change.previous)}. Read the full diff for context, but report only on these hunks.`,
    );
  }

  if (change.formatters.length > 0) {
    lines.push(
      `Layout is owned by ${change.formatters.join(" and ")} and was applied before this audit. Do not report line wrapping, vertical/horizontal expansion, or brace placement the formatter controls.`,
    );
  }

  return lines;
}

function auditPrompt(
  focus: string,
  changes: RepoChange[],
  intro: string,
  reported?: string,
): string {
  return [
    intro,
    focus,
    ...changes.map((change) => repoSection(change).join("\n")),
    reported,
    DIFF_SCOPE_RULE,
    REPORT_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export default function postChangeAudit(pi: ExtensionAPI): void {
  // Repository root to the repository-relative paths this session and its subagents changed.
  const touched = new Map<string, Set<string>>();
  // Repositories whose worktree state is compared around each bash call.
  const watchedRoots = new Set<string>();
  const bashStates = new Map<string, Map<string, Map<string, string>>>();
  const waiters = new Map<string, (outcome: AuditorOutcome) => void>();
  // Keyed by the first 8 characters of the agent id, the part pi-subagents puts in the auditor's session name.
  const reports = new Map<string, FindingsReport>();
  const runningSubagents = new Set<string>();
  const shutdown = new AbortController();
  const pullRequestReviews = new Set<AbortController>();
  let role: "root" | "subagent" | undefined;
  let currentCtx: ExtensionContext | undefined;
  let enabled = true;
  let autoAudit = true;
  let userInputPending = false;
  // Set by a user message that asks for no review; lasts until the next user message.
  let auditOptOut: OptOutCheck = { keyword: false };
  let clefOptOutFailureShown = false;
  let ownHub: AuditHub | undefined;
  let fixRounds = 0;
  // Work left unaudited by an earlier run, such as after the fix-round limit, waits for the next run that edits files.
  let changedSinceLastSettle = false;
  let inFlight: AbortController | undefined;
  let correctnessReview: AbortController | undefined;
  // The audit's correctness review delivers on its own, so it never holds up the other auditors' findings.
  let automaticCorrectness: AbortController | undefined;
  // Repository root to the tree the last audit (or skipped audit) saw, so the next one can focus on what changed since.
  const lastAuditedTrees = new Map<string, string>();
  // Findings from the last delivered audit that have no audit_decision yet, by the id shown to the agent.
  const openFindings = new Map<string, { file: string; claim: string }>();
  // Kept for the whole session branch, so a decision holds across user messages until it ages out.
  let ledger: LedgerEntry[] = [];

  // Paths touched while the audit ran stay tracked for the next one.
  function markAudited(changes: RepoChange[]): void {
    for (const change of changes) {
      const paths = touched.get(change.root);

      for (const path of change.paths) {
        paths?.delete(path);
      }

      if (paths?.size === 0) {
        touched.delete(change.root);
      }
    }
  }

  function touchPaths(root: string, paths: string[]): void {
    if (paths.length === 0) {
      return;
    }

    watchedRoots.add(root);
    const tracked = touched.get(root) ?? new Set<string>();

    for (const path of paths) {
      tracked.add(path);
    }

    touched.set(root, tracked);
    changedSinceLastSettle = true;
  }

  function recordTouched(root: string, paths: string[]): void {
    if (role === "subagent") {
      watchedRoots.add(root);
      auditHub()?.touchPaths(root, paths);

      return;
    }

    touchPaths(root, paths);
  }

  async function recordStatesBeforeBash(
    toolCallId: string,
    cwd: string,
  ): Promise<void> {
    const cwdRoot = await repoRoot(cwd);

    if (cwdRoot) {
      watchedRoots.add(cwdRoot);
    }

    const states = new Map<string, Map<string, string>>();
    await Promise.all(
      [...watchedRoots].map(async (root) => {
        const state = await worktreeState(root).catch(() => undefined);

        if (state) {
          states.set(root, state);
        }
      }),
    );
    bashStates.set(toolCallId, states);
  }

  async function recordBashChanges(toolCallId: string): Promise<void> {
    const states = bashStates.get(toolCallId);
    bashStates.delete(toolCallId);

    for (const [root, before] of states ?? []) {
      const after = await worktreeState(root).catch(() => undefined);

      if (after) {
        recordTouched(root, changedPaths(before, after));
      }
    }
  }

  function runAuditor(
    run: AuditorRun,
    signal: AbortSignal,
  ): Promise<AuditorResult> {
    return new Promise((resolveResult) => {
      const finish = (outcome: AuditorOutcome) => {
        resolveResult({
          source: run.type,
          title: run.title,
          idPrefix: run.idPrefix,
          ...outcome,
        });
      };

      signal.addEventListener(
        "abort",
        () => finish({ ok: false, text: "aborted" }),
        { once: true },
      );
      const requestId = randomUUID();

      const timeout = setTimeout(() => {
        unsubscribe();
        finish({
          ok: false,
          text: "pi-subagents did not answer the spawn request",
        });
      }, SPAWN_TIMEOUT_MS);

      const unsubscribe = pi.events.on(
        `subagents:rpc:spawn:reply:${requestId}`,
        (data) => {
          clearTimeout(timeout);
          unsubscribe();
          const reply = data as {
            success?: boolean;
            data?: { id?: string };
            error?: string;
          };
          const id = reply.data?.id;

          if (!reply.success || !id) {
            finish({ ok: false, text: reply.error ?? "spawn failed" });

            return;
          }

          waiters.set(id, finish);
        },
      );

      pi.events.emit("subagents:rpc:spawn", {
        requestId,
        type: run.type,
        prompt: run.prompt,
        options: {
          description: `${AUDIT_DESCRIPTION}: ${run.title}`,
          isBackground: true,
          maxTurns: run.maxTurns,
          thinkingLevel: run.thinkingLevel,
          model: loadConfig(pi).models?.agents?.[run.type],
          signal,
        },
      });
    });
  }

  // Only a thorough review, from /correctness or /review-mr, asks other packages for context such as test worktrees.
  async function runCorrectness(
    changes: RepoChange[],
    signal: AbortSignal,
    intro: string,
    thorough: boolean,
  ): Promise<AuditorResult> {
    const providers = thorough
      ? collectContributions(pi).correctnessContexts
      : [];
    const notify = (message: string) => currentCtx?.ui.notify(message, "info");
    const prepared: CorrectnessContext[] = [];

    try {
      // Settles every repository first, so no context is prepared after the cleanup below runs.
      const settled = await Promise.allSettled(
        changes.map(async (change) => {
          const lines = repoSection(change);

          for (const provider of providers) {
            const context = await provider(change, { signal, notify });

            if (!context) {
              continue;
            }

            prepared.push(context);
            lines.push(...context.lines);
          }

          return lines.join("\n");
        }),
      );

      signal.throwIfAborted();

      const sections = settled.map((result) => {
        if (result.status === "rejected") {
          throw result.reason;
        }

        return result.value;
      });

      const instructions = new Set(
        prepared.flatMap((context) => context.instructions ?? []),
      );

      if (!thorough) {
        instructions.add(AUTOMATIC_CORRECTNESS_RULE);
      }

      const prompt = [
        intro,
        ...sections,
        DIFF_SCOPE_RULE,
        ...instructions,
        REPORT_INSTRUCTIONS,
      ]
        .filter(Boolean)
        .join("\n\n");

      return await runAuditor(
        {
          type: "correctness-review",
          title: "Correctness",
          idPrefix: "C",
          prompt,
          maxTurns: thorough ? CORRECTNESS_MAX_TURNS : AUDITOR_MAX_TURNS,
          thinkingLevel: thorough ? undefined : "medium",
        },
        signal,
      );
    } catch (error) {
      return {
        source: "correctness-review",
        title: "Correctness",
        idPrefix: "C",
        ok: false,
        text: String(error),
      };
    } finally {
      for (const context of prepared) {
        await context.release?.().catch((error) => {
          currentCtx?.ui.notify(
            `Correctness review context cleanup failed: ${String(error)}`,
            "warning",
          );
        });
      }
    }
  }

  async function needsCorrectness(
    changes: RepoChange[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const changedLines = totalLines(changes);

    if (changedLines < CORRECTNESS_MIN_LINES) {
      return false;
    }

    try {
      const { scores, truncated } = await correctnessRisk(
        changes,
        loadConfig(pi).clef,
        signal,
      );
      const needed = scores.risky >= CLEF_RISK_THRESHOLD;
      currentCtx?.ui.notify(
        `Correctness review ${needed ? "running" : "skipped"}: Clef rates the risk ${scores.risky.toFixed(2)}${truncated ? " from a truncated diff" : ""}.`,
        "info",
      );

      return needed;
    } catch (error) {
      if (signal.aborted) {
        return false;
      }

      currentCtx?.ui.notify(
        `Clef could not rate the change (${String(error)}); running the correctness review for its ${changedLines} changed lines.`,
        "warning",
      );

      return true;
    }
  }

  // Reads and reasons only; tests and other contributed context are left to /correctness.
  async function reviewCorrectnessInBackground(
    ctx: ExtensionContext,
    changes: RepoChange[],
  ): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, controller.signal]);
    const status = `${STATUS_KEY}:correctness`;
    automaticCorrectness = controller;

    try {
      if (!(await needsCorrectness(changes, signal))) {
        return;
      }

      ctx.ui.setStatus(status, "correctness:running");
      const intro = [AGENT_CORRECTNESS_INTRO, decisionsSection()]
        .filter(Boolean)
        .join("\n\n");
      const correctness = await runCorrectness(changes, signal, intro, false);

      if (signal.aborted) {
        return;
      }

      deliver(ctx, changes, [correctness], "automatic");
    } finally {
      if (automaticCorrectness === controller) {
        automaticCorrectness = undefined;
      }

      ctx.ui.setStatus(status, undefined);
    }
  }

  function recordDecision(entry: LedgerEntry): void {
    ledger = [...ledger, entry].slice(-LEDGER_LIMIT);
    pi.appendEntry(LEDGER_ENTRY_TYPE, entry);
  }

  function rebuildLedger(ctx: ExtensionContext): void {
    ledger = ctx.sessionManager
      .getBranch()
      .flatMap((entry) => {
        if (
          entry.type !== "custom" ||
          entry.customType !== LEDGER_ENTRY_TYPE ||
          !Value.Check(LedgerEntrySchema, entry.data)
        ) {
          return [];
        }

        return [entry.data];
      })
      .slice(-LEDGER_LIMIT);
  }

  function decisionsSection(): string {
    if (ledger.length === 0) {
      return "";
    }

    const lines = ledger.map(
      (entry) =>
        `- ${entry.decision}: ${entry.file}: ${entry.claim} (${entry.reason})`,
    );

    return ["Settled decisions — do not re-raise or reverse:", ...lines].join(
      "\n",
    );
  }

  // The hygiene report stands in for code-restraint-review, which runs only when Clef could not judge the candidates.
  async function lintedAuditors(
    changes: RepoChange[],
    signal: AbortSignal,
    auditors: LintedAuditors,
    intro: string,
    start: (auditor: Auditor, reported?: string) => Promise<AuditorResult>,
  ): Promise<Promise<AuditorResult>[]> {
    const hygiene = await hygieneAudit(changes, loadConfig(pi).clef, signal);
    const runs = hygiene.results.map((result) => Promise.resolve(result));

    // runAuditor only notices aborts that happen after it spawns.
    if (signal.aborted) {
      return runs;
    }

    runs.push(
      start(auditors.refactor, reportedSection(hygiene)).then((result) =>
        withoutRepeats(result, hygiene),
      ),
    );

    if (hygiene.comments.length > 0) {
      const { comment } = auditors;
      runs.push(
        reviewComments(hygiene.comments, comment, intro, (prompt) => {
          return runAuditor(
            {
              type: comment.type,
              title: comment.title,
              idPrefix: comment.idPrefix,
              prompt,
            },
            signal,
          );
        }),
      );
    }

    if (
      !hygiene.clefReachable &&
      totalLines(changes) >= FALLBACK_REVIEW_MIN_LINES
    ) {
      currentCtx?.ui.notify(
        "Clef could not judge the hygiene candidates, so code-restraint-review runs as well.",
        "warning",
      );
      runs.push(start(auditors.codeRestraint));
    }

    return runs;
  }

  async function runAuditors(
    changes: RepoChange[],
    signal: AbortSignal,
  ): Promise<AuditorResult[]> {
    // Findings the agent never answered with audit_decision are taken as fixed.
    for (const [id, finding] of openFindings) {
      recordDecision({
        id,
        ...finding,
        decision: "fixed",
        reason: "no decision was recorded",
      });
    }

    openFindings.clear();

    const auditIntro = [AGENT_AUDIT_INTRO, decisionsSection()]
      .filter(Boolean)
      .join("\n\n");

    const start = (auditor: Auditor, reported?: string) => {
      return runAuditor(
        {
          type: auditor.type,
          title: auditor.title,
          idPrefix: auditor.idPrefix,
          prompt: auditPrompt(auditor.focus, changes, auditIntro, reported),
          maxTurns: AUDITOR_MAX_TURNS,
        },
        signal,
      );
    };

    // Their subagent sessions learn from the hub that they are auditors, since they may not load the contributing package.
    const { auditors } = collectContributions(pi);

    for (const auditor of auditors) {
      ownHub?.auditorTypes.add(auditor.type);
    }

    const runs = auditors.map((auditor) => start(auditor));

    // Contributed auditors are already running while the linter decides.
    const linted = await lintedAuditors(
      changes,
      signal,
      AUDITORS,
      auditIntro,
      start,
    );

    runs.push(...linted);

    return Promise.all(runs);
  }

  // Safe to rewrite files here: the audit only runs once the main session and its subagents are idle.
  async function formatTouchedFiles(
    ctx: ExtensionContext,
  ): Promise<Map<string, string[]>> {
    const applied = new Map<string, string[]>();

    for (const [root, paths] of touched) {
      if (!existsSync(root)) {
        continue;
      }

      const names: string[] = [];

      for (const run of await formatterRuns(root, [...paths])) {
        try {
          await execFileAsync(run.command, run.args, {
            cwd: root,
            timeout: FORMAT_TIMEOUT_MS,
          });
          names.push(run.name);
        } catch (error) {
          const reason =
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "it is not installed"
              : String(error);

          ctx.ui.notify(
            `Post-change audit: skipped ${run.name} in ${root} because ${reason}.`,
            "warning",
          );
        }
      }

      applied.set(root, names);
    }

    return applied;
  }

  async function collectChanges(
    formatted: Map<string, string[]>,
    pathsByRoot = touched,
  ): Promise<RepoChange[]> {
    const changes: RepoChange[] = [];

    for (const [root, tracked] of pathsByRoot) {
      // An isolated subagent's worktree is removed once its changes are committed to a branch.
      if (!existsSync(root)) {
        pathsByRoot.delete(root);
        continue;
      }

      const paths = [...tracked];
      const base = await auditBase(root);
      const current = await snapshotPaths(root, paths);
      const previous = lastAuditedTrees.get(root);
      const range = [base.tree, current, "--", ...paths];
      const files = await git(root, ["diff", "--name-status", ...range], {
        env: LITERAL_PATHSPECS,
      });

      // The touched paths match the base again, so there is nothing to audit there.
      if (!files) {
        pathsByRoot.delete(root);
        continue;
      }

      changes.push({
        root,
        base: base.tree,
        baseDescription: base.description,
        current,
        previous: previous === current ? undefined : previous,
        paths,
        files,
        formatters: formatted.get(root) ?? [],
        lines: countLines(
          await git(root, ["diff", "--numstat", ...range], {
            env: LITERAL_PATHSPECS,
          }),
        ),
      });
    }

    return changes;
  }

  function deliver(
    ctx: ExtensionContext,
    changes: RepoChange[],
    results: AuditorResult[],
    trigger: "manual" | "automatic",
  ): void {
    const { failures, hasFindings, ...classified } = classifyResults(results);

    if (failures) {
      ctx.ui.notify(`Post-change audit: ${failures}`, "warning");
    }

    if (!hasFindings) {
      ctx.ui.notify("Post-change audit found no issues.", "info");

      return;
    }

    if (trigger === "automatic") {
      fixRounds += 1;
    }

    for (const diagnostic of classified.diagnostics) {
      openFindings.set(diagnostic.id, {
        file: diagnostic.file,
        claim: diagnostic.message,
      });
    }

    const rerun =
      trigger === "automatic"
        ? "fixes are re-audited automatically"
        : "the user re-runs it";

    const noReportInstruction = classified.reviewers.some(
      (reviewer) => reviewer.status === "no-report",
    )
      ? " Act on valid points in no-report text."
      : "";

    sendAuditMessage({
      round: trigger === "automatic" ? fixRounds : undefined,
      instructions: `Fix each valid diagnostic or say why it is wrong, and call audit_decision for every id.${noReportInstruction} Never reverse settledDecisions, add formatter-ignore comments, or start an audit (${rerun}).`,
      diffs: changes.map((change) => diffCommand(change, change.base)),
      ...classified,
      settledDecisions: ledger.map(({ id: _id, ...decision }) => decision),
    });
  }

  async function audit(
    ctx: ExtensionContext,
    trigger: "manual" | "automatic",
  ): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;

    // The user may have opted out while the changes were being collected, and Clef may read the message as an
    // opt-out that the keyword rule missed.
    async function skipForOptOut(ctx: ExtensionContext): Promise<boolean> {
      const optOut = await decideOptOut(auditOptOut);

      if (controller.signal.aborted) {
        return true;
      }

      if (optOut.clefError && !clefOptOutFailureShown) {
        clefOptOutFailureShown = true;
        ctx.ui.notify(
          `Clef could not check your message for an audit opt-out (${optOut.clefError}); only the keyword rule applied. Later Clef failures are not shown.`,
          "warning",
        );
      }

      if (!optOut.optedOut) {
        return false;
      }

      if (optOut.clefScore !== undefined) {
        ctx.ui.notify(
          `Audit skipped: your message reads as asking for no review (Clef ${optOut.clefScore.toFixed(2)}).`,
          "info",
        );
      }

      // Cleared first so the finally block keeps the skipped status.
      inFlight = undefined;
      await skipAudit(ctx);

      return true;
    }

    try {
      const changes = await collectChanges(await formatTouchedFiles(ctx));

      if (controller.signal.aborted) {
        return;
      }

      if (changes.length === 0) {
        if (trigger === "manual") {
          ctx.ui.notify("Post-change audit: no changes to audit.", "info");
        }

        return;
      }

      if (trigger === "automatic") {
        // Checked before the size rule so that, as with a keyword opt-out at settle, small changes are marked
        // audited instead of waiting for a later audit.
        if (await skipForOptOut(ctx)) {
          return;
        }

        if (totalLines(changes) < AUTO_AUDIT_MIN_LINES) {
          return;
        }

        if (fixRounds >= MAX_FIX_ROUNDS) {
          ctx.ui.notify(
            `Post-change audit: findings may remain after ${MAX_FIX_ROUNDS} fix rounds; run /audit to check again.`,
            "warning",
          );

          return;
        }
      }

      ctx.ui.setStatus(STATUS_KEY, "audit:running");
      // Started first because it records the open findings as settled decisions, which the correctness review lists.
      const auditorRuns = runAuditors(changes, controller.signal);

      // Fix rounds only re-check the fixes, so the correctness review runs once per user message.
      if (
        !automaticCorrectness &&
        !(trigger === "automatic" && fixRounds > 0)
      ) {
        void reviewCorrectnessInBackground(ctx, changes).catch((error) => {
          ctx.ui.notify(`Correctness review failed: ${String(error)}`, "error");
        });
      }

      const results = await auditorRuns;

      if (controller.signal.aborted) {
        return;
      }

      // Cleared before delivery because the triggered fix turn must not abort a finished audit.
      inFlight = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);

      for (const change of changes) {
        lastAuditedTrees.set(change.root, change.current);
      }

      markAudited(changes);
      deliver(ctx, changes, results, trigger);
    } finally {
      if (inFlight === controller) {
        inFlight = undefined;
        currentCtx?.ui.setStatus(STATUS_KEY, undefined);
      }
    }
  }

  function abortInFlight(): void {
    if (!inFlight) {
      return;
    }

    inFlight.abort();
    inFlight = undefined;
    currentCtx?.ui.setStatus(STATUS_KEY, undefined);
  }

  function settleWaiter(data: unknown, ok: boolean): void {
    if (!Value.Check(SubagentEventSchema, data)) {
      return;
    }

    const finish = waiters.get(data.id);

    if (!finish) {
      return;
    }

    waiters.delete(data.id);
    // Must run synchronously in this handler to suppress pi-subagents' completion nudge.
    pi.events.emit("subagents:rpc:consume", {
      requestId: randomUUID(),
      agentId: data.id,
    });
    const key = data.id.slice(0, 8);
    const report = reports.get(key);
    reports.delete(key);
    finish({
      ok,
      text: (ok ? data.result : data.error) ?? "No output.",
      report,
    });
  }

  function trackSubagent(data: unknown, running: boolean): void {
    if (!Value.Check(SubagentEventSchema, data)) {
      return;
    }

    if (data.description?.startsWith(AUDIT_DESCRIPTION)) {
      return;
    }

    if (running) {
      runningSubagents.add(data.id);
    } else {
      runningSubagents.delete(data.id);
    }
  }

  const unsubscribers = [
    pi.events.on("subagents:started", (data) => trackSubagent(data, true)),
    pi.events.on("subagents:completed", (data) => {
      trackSubagent(data, false);
      settleWaiter(data, true);
    }),
    pi.events.on("subagents:failed", (data) => {
      trackSubagent(data, false);
      settleWaiter(data, false);
    }),
    pi.events.on("manual-modes:changed", (data) => {
      const modes = data as {
        subagents?: boolean;
        review?: boolean;
        autoAudit?: boolean;
      };
      enabled = modes.subagents === true && modes.review === true;
      autoAudit = modes.autoAudit === true;

      if (!enabled) {
        abortInFlight();
        correctnessReview?.abort();
        automaticCorrectness?.abort();

        for (const review of pullRequestReviews) {
          review.abort();
        }
      }
    }),
  ];

  async function startManualAudit(ctx: ExtensionContext): Promise<void> {
    if (role !== "root") {
      return;
    }

    if (!ctx.isIdle() || runningSubagents.size > 0 || correctnessReview) {
      ctx.ui.notify(
        "Post-change audit: wait for the current turn, background agents, and /correctness to finish.",
        "warning",
      );

      return;
    }

    const uncommitted = await uncommittedPaths(ctx);

    if (uncommitted) {
      touchPaths(uncommitted.root, uncommitted.paths);
    }

    abortInFlight();
    void audit(ctx, "manual").catch((error) => {
      ctx.ui.notify(`Post-change audit failed: ${String(error)}`, "error");
    });
  }

  // When this session has changed nothing in its repository yet, /audit and /correctness review the uncommitted changes there.
  async function uncommittedPaths(
    ctx: ExtensionContext,
  ): Promise<{ root: string; paths: string[] } | undefined> {
    const root = await repoRoot(ctx.cwd);

    if (!root || touched.has(root)) {
      return undefined;
    }

    const state = await worktreeState(root).catch(
      () => new Map<string, string>(),
    );

    return { root, paths: [...state.keys()] };
  }

  // Unlike an audit, the review leaves the touched paths for the next audit, does not format them, and covers the
  // whole change rather than the hunks since the last audit.
  async function reviewCorrectness(
    focus: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, controller.signal]);
    const status = `${STATUS_KEY}:correctness`;
    correctnessReview = controller;

    try {
      const pathsByRoot = new Map(
        [...touched].map(([root, paths]) => [root, new Set(paths)]),
      );
      const uncommitted = await uncommittedPaths(ctx);

      if (uncommitted) {
        pathsByRoot.set(uncommitted.root, new Set(uncommitted.paths));
      }

      const collected = await collectChanges(new Map(), pathsByRoot);
      const changes = collected.map((change) => ({
        ...change,
        previous: undefined,
      }));

      if (changes.length === 0) {
        ctx.ui.notify("Correctness review: no changes to review.", "info");

        return;
      }

      ctx.ui.setStatus(status, "correctness:running");
      const request = focus ? `The user asked:\n/correctness ${focus}` : "";
      const intro = [MANUAL_CORRECTNESS_INTRO, request, decisionsSection()]
        .filter(Boolean)
        .join("\n\n");
      const correctness = await runCorrectness(changes, signal, intro, true);

      if (signal.aborted) {
        return;
      }

      deliver(ctx, changes, [correctness], "manual");
    } finally {
      if (correctnessReview === controller) {
        correctnessReview = undefined;
      }

      ctx.ui.setStatus(status, undefined);
    }
  }

  pi.registerMessageRenderer(AUDIT_MESSAGE_TYPE, renderAuditMessage);

  pi.registerCommand("audit", {
    description:
      "Run the post-change review agents on changes since the last message (or the last audit, while the automatic audit is on), regardless of size",
    handler: (_args, ctx) => startManualAudit(ctx),
  });

  pi.registerCommand("correctness", {
    description:
      "Run correctness-review on the changes /audit would cover: /correctness [what to focus on]",
    handler: async (args, ctx) => {
      if (role !== "root") {
        return;
      }

      if (!enabled) {
        ctx.ui.notify(
          "Correctness review: turn on /subagents and /review first.",
          "warning",
        );

        return;
      }

      if (inFlight || correctnessReview || automaticCorrectness) {
        ctx.ui.notify(
          "Correctness review: wait for the running audit or correctness review to finish.",
          "warning",
        );

        return;
      }

      if (!ctx.isIdle() || runningSubagents.size > 0) {
        ctx.ui.notify(
          "Correctness review: wait for the current turn and background agents to finish.",
          "warning",
        );

        return;
      }

      void reviewCorrectness(args.trim(), ctx).catch((error) => {
        ctx.ui.notify(`Correctness review failed: ${String(error)}`, "error");
      });
    },
  });

  pi.registerShortcut(Key.ctrlShift("r"), {
    description:
      "Run the post-change review agents on changes since the last message",
    handler: startManualAudit,
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      role = "root";
      currentCtx = ctx;
      ownHub = {
        version: HUB_VERSION,
        touchPaths,
        auditorTypes: new Set(),
        reportFindings: (key, report) => {
          if (![...waiters.keys()].some((id) => id.startsWith(key))) {
            return false;
          }

          reports.set(key, report);

          return true;
        },
      };
      Reflect.set(globalThis, HUB_KEY, ownHub);
      rebuildLedger(ctx);
      registerAuditDecision();

      return;
    }

    // pi-subagents names child sessions `<type>#<first 8 characters of the agent id>`;
    // auditors must not audit their own test edits.
    const [type = "", key] = (pi.getSessionName() ?? "").split("#");

    if (AUDITOR_TYPES.has(type) || auditHub()?.auditorTypes.has(type)) {
      registerReportFindings(key);

      return;
    }

    if (auditHub()) {
      role = "subagent";
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    if (role === "root") {
      rebuildLedger(ctx);
    }
  });

  function registerAuditDecision(): void {
    pi.registerTool({
      name: "audit_decision",
      label: "Audit Decision",
      description:
        "Record whether a post-change audit finding was fixed or declined, so later audits neither re-raise nor reverse it.",
      promptSnippet: "Record the outcome of a post-change audit finding",
      promptGuidelines: [
        "Use audit_decision once for every finding in an automatic post-change audit message.",
      ],
      parameters: AuditDecisionSchema,
      async execute(_toolCallId, params) {
        const finding = openFindings.get(params.id);

        if (!finding) {
          const open = [...openFindings.keys()].join(", ") || "none";
          throw new Error(
            `No open audit finding ${params.id}; open findings: ${open}.`,
          );
        }

        openFindings.delete(params.id);
        recordDecision({ ...params, ...finding });

        return {
          content: [
            {
              type: "text" as const,
              text: `Recorded ${params.id} as ${params.decision}.`,
            },
          ],
          details: undefined,
        };
      },
    });
  }

  function registerReportFindings(key: string | undefined): void {
    pi.registerTool({
      name: "report_findings",
      label: "Report Findings",
      description:
        "Report this review's findings to the session that requested it. Call it exactly once, at the end; a later call replaces the earlier report.",
      promptSnippet: "Report review findings to the requesting session",
      parameters: FindingsReportSchema,
      async execute(_toolCallId, params) {
        const notWaiting =
          "No post-change audit or /review-mr review is waiting for this report; return the findings as text instead.";

        if (!key || Reflect.get(globalThis, HUB_KEY) === undefined) {
          throw new Error(notWaiting);
        }

        const hub = auditHub();

        if (!hub) {
          throw new Error(
            "The session that requested this review runs an older post-change-audit extension that cannot receive report_findings. Return the findings as text instead, and tell the user to /reload that session.",
          );
        }

        if (!hub.reportFindings(key, params)) {
          throw new Error(notWaiting);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Reported ${params.findings.length} findings.`,
            },
          ],
          details: undefined,
        };
      },
    });
  }

  // The model reads the JSON; the TUI shows it through renderAuditMessage.
  function sendAuditMessage(message: AuditMessageInput): void {
    const { content, details } = serializeAuditMessage(message);
    pi.sendMessage(
      {
        customType: AUDIT_MESSAGE_TYPE,
        content,
        details,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  async function reviewPullRequest(
    pr: PullRequest,
    info: PullRequestInfo,
    frames: StackFrame[],
    request: string,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<void> {
    const status = `${STATUS_KEY}:${pr.url}`;
    let checkout: PullRequestCheckout | undefined;

    try {
      ctx.ui.setStatus(status, "pr-review:running");
      checkout = await checkoutPullRequest(pr, info, frames, signal);
      // runAuditor only notices aborts that happen after it spawns.
      signal.throwIfAborted();

      const changes = [checkout.change];
      const intro = pullRequestIntro(pr, info, request, frames, checkout);

      const correctness = runCorrectness(
        changes,
        signal,
        `${intro}\n\n${PR_CORRECTNESS_EXPECTATIONS}`,
        true,
      );

      const start = (auditor: Auditor, reported?: string) => {
        return runAuditor(
          {
            type: auditor.type,
            title: auditor.title,
            idPrefix: auditor.idPrefix,
            prompt: auditPrompt(auditor.focus, changes, intro, reported),
            maxTurns: PR_AUDITOR_MAX_TURNS,
          },
          signal,
        );
      };

      const runs = [
        correctness,
        ...(await lintedAuditors(changes, signal, PR_AUDITORS, intro, start)),
      ];

      const results = await Promise.all(runs);
      signal.throwIfAborted();

      const { failures, hasFindings, ...classified } = classifyResults(results);

      const incomplete = failures
        ? " The review is incomplete because a reviewer failed or did not report; say so."
        : "";

      const instructions = hasFindings
        ? `Write the user a review of these diagnostics; do not comment on the review or change code.${incomplete} ${PR_BRIEF_FORMAT}`
        : `Tell the user in a sentence or two that the automatic review found no issues.${incomplete}`;

      sendAuditMessage({
        pullRequest: pr.url,
        instructions,
        ...classified,
      });
    } finally {
      ctx.ui.setStatus(status, undefined);

      if (checkout) {
        const { repo, path } = checkout;
        await git(repo, ["worktree", "remove", "--force", path]).catch(
          (error) => {
            ctx.ui.notify(
              `Review of ${pr.url} could not remove its worktree ${path}: ${String(error)}`,
              "warning",
            );
          },
        );
      }
    }
  }

  async function startPullRequestReviews(
    prs: PullRequest[],
    request: string,
    ctx: ExtensionContext,
  ): Promise<string[]> {
    const resolved = await Promise.all(
      prs.map(async (pr) => {
        // Registered before the metadata lookup so turning a mode off cancels the whole review.
        const controller = new AbortController();
        const signal = AbortSignal.any([shutdown.signal, controller.signal]);
        pullRequestReviews.add(controller);

        try {
          const info = await pullRequestInfo(pr, signal);

          if (info.mine) {
            ctx.ui.notify(
              `Skipping ${pr.url}: you authored it, and /review-mr only reviews other people's changes.`,
              "warning",
            );
            pullRequestReviews.delete(controller);

            return undefined;
          }

          const frames = await pullRequestStack(pr, info, signal);

          return {
            pr,
            info,
            frames,
            controller,
            signal,
          };
        } catch (error) {
          if (!isAbortError(error)) {
            ctx.ui.notify(
              `Review of ${pr.url} failed: ${String(error)}`,
              "error",
            );
          }

          pullRequestReviews.delete(controller);

          return undefined;
        }
      }),
    );

    // Links into the same stack would review it twice.
    const reviewed = new Set<string>();
    const started: string[] = [];

    for (const review of resolved) {
      if (!review) {
        continue;
      }

      const { pr, info, frames, controller, signal } = review;
      const urls = frames.map((frame) => frame.pr.url);

      if (urls.some((url) => reviewed.has(url))) {
        ctx.ui.notify(
          `Skipping ${pr.url}: it is part of a stack already under review.`,
          "info",
        );
        pullRequestReviews.delete(controller);
        continue;
      }

      if (signal.aborted) {
        pullRequestReviews.delete(controller);
        continue;
      }

      for (const url of urls) {
        reviewed.add(url);
      }

      // The main agent was told to wait, so every outcome must reach it.
      void reviewPullRequest(pr, info, frames, request, ctx, signal)
        .catch((error) => {
          if (shutdown.signal.aborted) {
            return;
          }

          sendAuditMessage({
            pullRequest: pr.url,
            instructions:
              "Tell the user the automatic review did not complete because of error, and offer to review it yourself.",
            error: isAbortError(error)
              ? "cancelled because /review or /subagents was turned off"
              : String(error),
          });
        })
        .finally(() => pullRequestReviews.delete(controller));
      started.push(
        frames.length > 1 ? `${pr.url} (a stack of ${frames.length})` : pr.url,
      );
    }

    return started;
  }

  pi.on("input", async (event, ctx) => {
    // Retries, compaction, audit continuations, and extension wake-ups also start runs; only a user prompt carries new intent.
    if (event.source === "extension") {
      return undefined;
    }

    userInputPending = true;
    auditOptOut =
      role === "root"
        ? startOptOutCheck(event.text, loadConfig(pi).clef, shutdown.signal)
        : { keyword: false };

    if (!auditOptOut.keyword) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    return undefined;
  });

  // The skipped work is marked audited, so a later audit does not pick it up.
  async function skipAudit(ctx: ExtensionContext): Promise<void> {
    const skipped = [...touched];
    touched.clear();
    ctx.ui.setStatus(STATUS_KEY, "audit:skipped (opt-out)");

    for (const [root, paths] of skipped) {
      if (existsSync(root)) {
        lastAuditedTrees.set(root, await snapshotPaths(root, [...paths]));
      }
    }
  }

  pi.registerCommand("review-mr", {
    description:
      "Review someone else's GitHub PR or GitLab MR: /review-mr <link> [what to focus on]",
    handler: async (args, ctx) => {
      if (role !== "root") {
        return;
      }

      const linked = linkedPullRequests(args, loadConfig(pi).forges ?? {});

      if (linked.length === 0) {
        ctx.ui.notify(
          "Usage: /review-mr <GitHub PR or GitLab MR link> [what to focus on]",
          "warning",
        );

        return;
      }

      if (linked.length > MAX_LINKED_REVIEWS) {
        ctx.ui.notify(
          `Reviewing only the first ${MAX_LINKED_REVIEWS} of ${linked.length} linked reviews.`,
          "warning",
        );
      }

      const reviewing = await startPullRequestReviews(
        linked.slice(0, MAX_LINKED_REVIEWS),
        `/review-mr ${args.trim()}`,
        ctx,
      );

      if (reviewing.length > 0) {
        ctx.ui.notify(
          `Reviewing ${reviewing.join(", ")}; findings arrive as a follow-up.`,
          "info",
        );
      }
    },
  });

  pi.on("agent_start", async () => {
    if (role !== "root") {
      return;
    }

    // Extension pushes and subagent notifications also wake the agent; only a user prompt cancels the audit.
    if (userInputPending) {
      abortInFlight();
      userInputPending = false;
      fixRounds = 0;

      // The automatic audit covers everything since the last audit, so edits that background
      // subagents made before this prompt are still audited once they finish.
      if (!autoAudit) {
        touched.clear();
      }
    }
  });

  // A throwing tool_call handler blocks the tool, so every git failure here is swallowed.
  pi.on("tool_call", async (event, ctx) => {
    if (!role) {
      return;
    }

    if (event.toolName === "bash") {
      await recordStatesBeforeBash(event.toolCallId, ctx.cwd);

      return;
    }

    if (event.toolName !== "edit" && event.toolName !== "write") {
      return;
    }

    const path = event.input.path;

    if (typeof path !== "string") {
      return;
    }

    const file = resolve(
      ctx.cwd,
      path.replace(/^@/, "").replace(/^~(?=\/)/, homedir()),
    );
    const located = await locateFile(file);

    if (located) {
      recordTouched(located.root, [located.path]);
    }
  });

  pi.on("tool_result", async (event) => {
    if (bashStates.has(event.toolCallId)) {
      await recordBashChanges(event.toolCallId);
    }

    return undefined;
  });

  // Background subagents wake the root session when they finish, so the root settling with none
  // running means the main session and every subagent are done.
  pi.on("agent_settled", (event, ctx) => {
    if (
      role !== "root" ||
      event.aborted ||
      !enabled ||
      !autoAudit ||
      runningSubagents.size > 0 ||
      inFlight ||
      correctnessReview ||
      !changedSinceLastSettle
    ) {
      return;
    }

    changedSinceLastSettle = false;

    if (auditOptOut.keyword) {
      void skipAudit(ctx).catch((error) => {
        ctx.ui.notify(
          `Post-change audit could not mark the skipped work as audited: ${String(error)}`,
          "warning",
        );
      });

      return;
    }

    void audit(ctx, "automatic").catch((error) => {
      ctx.ui.notify(`Post-change audit failed: ${String(error)}`, "error");
    });
  });

  pi.on("session_shutdown", () => {
    abortInFlight();
    shutdown.abort();

    if (ownHub && auditHub() === ownHub) {
      Reflect.deleteProperty(globalThis, HUB_KEY);
    }

    role = undefined;
    currentCtx = undefined;

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });
}
