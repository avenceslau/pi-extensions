import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  cleanWorktree,
  currentHead,
  discoverReviews,
  retryCiTarget,
  retryTargets,
  worktreeBlockedReason,
  worktreeFingerprint,
} from "./forges.ts";
import { loadConfig } from "../shared/config.ts";
import { chooseReview, selectReviews } from "./selector.ts";
import type {
  ActiveRun,
  Review,
  ReviewCycle,
  SavedShepherdState,
  ShepherdPhase,
} from "./types.ts";

const STATE_TYPE = "shepherd-state";
const POLL_INTERVAL_MS = 90_000;
const MAX_RETRY_ATTEMPTS = 2;
const MAX_CORRECTION_LOOPS = 3;
const REFACTOR_REVIEWER = "shepherd-refactor-review";

interface SpawnReply {
  success: boolean;
  data?: { id?: string };
  error?: string;
}

interface SubagentManagerRegistry {
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: Record<string, unknown>,
  ): string;
}

interface AgentPreview {
  reviewKey: string;
  description: string;
  activeTools: string[];
  toolUses: number;
  responseText: string;
  turnCount: number;
}

function workerPrompt(review: Review, instructions?: string): string {
  const extra = instructions?.trim()
    ? `\nAdditional instructions from the coordinator:\n${instructions.trim()}\n`
    : "";

  return `You are tending ${review.key}: ${review.title}
Review URL: ${review.url}
Worktree: ${review.worktree}
Target branch: ${review.baseBranch}
Current review state: ${review.summary}
${extra}
Inspect the current PR/MR state, CI failures, and review feedback. If a rebase is already in progress, resume it and resolve its conflicts. Otherwise, when the branch is behind or conflicts with its target, fetch origin and automatically rebase it onto origin/${review.baseBranch}. Resolve conflicts by preserving the intended changes from both sides, then finish the rebase. Make only justified source changes, run focused validation, and commit completed changes locally following repository conventions. Do not merge the target into the branch, cherry-pick, reset, push, reply to review threads, resolve discussions, mark the review ready, or merge the review. If no code change is warranted, explain why and recommend the next deterministic action.`;
}

function correctnessPrompt(review: Review): string {
  return `Adversarially review the complete current diff for ${review.key} against ${review.baseBranch}.

Do not trust the implementation summary. Independently inspect changed code, call sites, tests, and relevant repository guidance. Look specifically for correctness regressions, races, edge cases, error-handling gaps, compatibility risks, incomplete requirements, and misleading or missing tests. Run focused read-only checks when useful. Do not edit files, commit, push, or post review comments.

Return only material findings with severity, file:line evidence, impact, and a concrete direction. Return exactly \`[]\` when there are no material findings.`;
}

function refactorPrompt(review: Review): string {
  return `Adversarially review the complete current diff for ${review.key} against ${review.baseBranch} using the preloaded refactoring and code-restraint skills.

Focus on unnecessary nesting, duplicated conditions, mixed responsibilities, unclear ownership or data flow, premature abstractions, trivial wrappers, and noise comments. Prefer flattening before extraction and distinguish structural suggestions from behavior changes. Do not edit files, commit, push, or post review comments.

Return only material findings with severity, file:line evidence, and the smallest behavior-preserving improvement. Return exactly \`[]\` when the implementation is already clear and restrained.`;
}

export default function shepherd(pi: ExtensionAPI): void {
  let active = false;
  let selected = new Set<string>();
  let retryAttempts: Record<string, number> = {};
  let correctionLoops: Record<string, number> = {};
  let reviews = new Map<string, Review>();
  let phases = new Map<string, ShepherdPhase>();
  let activeRuns = new Map<string, ActiveRun>();
  let reviewCycles = new Map<string, ReviewCycle>();
  let reviewedFingerprints = new Map<string, string>();
  let agentPreviews = new Map<string, AgentPreview>();
  let refreshPromise: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let currentCtx: ExtensionContext | undefined;

  function savedState(): SavedShepherdState {
    return {
      active,
      selected: [...selected],
      retryAttempts,
      correctionLoops,
    };
  }

  function persist(): void {
    pi.appendEntry(STATE_TYPE, savedState());
  }

  function restore(ctx: ExtensionContext): void {
    let state: SavedShepherdState | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        state = entry.data as SavedShepherdState | undefined;
      }
    }

    active = state?.active === true;
    selected = new Set(state?.selected ?? []);
    retryAttempts = state?.retryAttempts ?? {};
    correctionLoops = state?.correctionLoops ?? {};
  }

  function selectedReviews(): Review[] {
    return [...selected]
      .map((key) => reviews.get(key))
      .filter((review): review is Review => review !== undefined);
  }

  function displayKey(review: Review): string {
    const separator = review.forge === "github" ? "#" : "!";
    const repository = review.repository.split("/").slice(-2).join("/");

    return `${repository}${separator}${review.number}`;
  }

  function phaseSummary(review: Review): string {
    const phase = phases.get(review.key) ?? "idle";
    const loop = correctionLoops[review.key] ?? 0;

    if (phase === "working") {
      return loop > 0
        ? `corrective worker ${loop}/${MAX_CORRECTION_LOOPS}`
        : "worker running";
    }

    if (phase === "reviewing") {
      const cycle = reviewCycles.get(review.key);
      const completed = cycle ? 2 - cycle.pending.size : 0;
      const correction =
        loop > 0 ? ` · loop ${loop}/${MAX_CORRECTION_LOOPS}` : "";

      return `adversarial review ${completed}/2${correction}`;
    }

    if (phase === "reviewed") {
      return "adversarial review complete";
    }

    if (phase === "blocked") {
      return "blocked";
    }

    return review.summary;
  }

  function hasMaterialFindings(result: string): boolean {
    const normalized = result
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    return normalized !== "[]";
  }

  function reportToCoordinator(
    review: Review,
    title: string,
    results: Array<{ kind: string; result: string }>,
  ): void {
    const findings = results
      .map(({ kind, result }) => {
        const text = result.trim();
        const bounded =
          text.length > 4_000 ? `${text.slice(0, 4_000)}\n[truncated]` : text;

        return `## ${kind}\n${bounded || "No output."}`;
      })
      .join("\n\n");

    pi.sendMessage(
      {
        customType: "shepherd-report",
        content: `${title}\nReview: ${review.key}\n\n${findings}`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function previewText(preview: AgentPreview): string {
    if (preview.activeTools.length > 0) {
      return `running ${[...new Set(preview.activeTools)].join(", ")}`;
    }

    const response = preview.responseText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (response) {
      return response.length > 100 ? `${response.slice(0, 97)}...` : response;
    }

    return `starting · turn ${preview.turnCount}`;
  }

  function updateUi(ctx: ExtensionContext): void {
    if (!active) {
      ctx.ui.setStatus("shepherd", undefined);
      ctx.ui.setWidget("shepherd", undefined);

      return;
    }

    const flock = selectedReviews();
    ctx.ui.setStatus("shepherd", `shepherd:${flock.length}`);
    const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Shepherd"))];

    for (const review of flock.slice(0, 8)) {
      const phase = phases.get(review.key) ?? "idle";
      let color: "muted" | "success" | "warning" = "muted";

      if (phase === "blocked" || review.status === "actionable") {
        color = "warning";
      } else if (phase === "reviewed" || review.status === "ready") {
        color = "success";
      }

      lines.push(
        `${ctx.ui.theme.fg(color, "●")} ${displayKey(review)} · ${phaseSummary(review)}`,
      );

      const previews = [...agentPreviews.values()]
        .filter((preview) => preview.reviewKey === review.key)
        .slice(0, 2);

      for (const preview of previews) {
        lines.push(
          ctx.ui.theme.fg(
            "dim",
            `  ⎿ ${preview.description}: ${previewText(preview)} · ${preview.toolUses} tools`,
          ),
        );
      }
    }

    if (flock.length > 8) {
      lines.push(ctx.ui.theme.fg("dim", `… ${flock.length - 8} more`));
    }

    if (flock.length === 0) {
      lines.push(
        ctx.ui.theme.fg("muted", "No selected reviews are currently available"),
      );
    }

    ctx.ui.setWidget("shepherd", lines);
  }

  async function invalidateStaleReviews(): Promise<void> {
    await Promise.all(
      selectedReviews().map(async (review) => {
        const expected = reviewedFingerprints.get(review.key);

        if (!expected) {
          return;
        }

        const current = await worktreeFingerprint(pi, review.worktree);

        if (current === expected) {
          return;
        }

        reviewedFingerprints.delete(review.key);
        phases.set(review.key, "idle");
      }),
    );
  }

  async function doRefresh(
    ctx: ExtensionContext,
    notify = false,
  ): Promise<void> {
    const previous = reviews;
    const result = await discoverReviews(pi, selected);
    reviews = new Map(result.reviews.map((review) => [review.key, review]));
    await invalidateStaleReviews();

    if (notify && result.warnings.length > 0) {
      ctx.ui.notify(
        `Shepherd refresh completed with ${result.warnings.length} warning(s)`,
        "warning",
      );
    }

    for (const review of selectedReviews()) {
      const old = previous.get(review.key);

      if (old && old.summary !== review.summary) {
        ctx.ui.notify(
          `${displayKey(review)}: ${review.summary}`,
          review.status === "actionable" ? "warning" : "info",
        );
      }
    }

    updateUi(ctx);
  }

  async function refresh(ctx: ExtensionContext, notify = false): Promise<void> {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = doRefresh(ctx, notify).finally(() => {
      refreshPromise = undefined;
    });

    return refreshPromise;
  }

  function startPolling(ctx: ExtensionContext): void {
    if (pollTimer) {
      clearInterval(pollTimer);
    }

    pollTimer = setInterval(() => {
      void refresh(ctx).catch((error) => {
        ctx.ui.notify(`Shepherd refresh failed: ${String(error)}`, "warning");
      });
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function resolveReview(value: string): Review | undefined {
    const query = value.trim();

    if (!query) {
      return undefined;
    }

    const exact = reviews.get(query);

    if (exact && selected.has(exact.key)) {
      return exact;
    }

    const matches = selectedReviews().filter((review) => {
      return review.key.endsWith(query) || displayKey(review) === query;
    });

    return matches.length === 1 ? matches[0] : undefined;
  }

  async function spawnAgent(
    type: string,
    review: Review,
    description: string,
    prompt: string,
  ): Promise<string> {
    const preview: AgentPreview = {
      reviewKey: review.key,
      description,
      activeTools: [],
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    };

    const refreshPreview = () => {
      if (currentCtx) {
        updateUi(currentCtx);
      }
    };

    // pi-subagents' manager takes a resolved model, while its RPC also accepts one.
    const modelRef = loadConfig(pi).models?.agents?.[type];
    const separator = modelRef?.indexOf("/") ?? -1;

    const model =
      modelRef && separator > 0
        ? currentCtx?.modelRegistry.find(
            modelRef.slice(0, separator),
            modelRef.slice(separator + 1),
          )
        : undefined;

    const options = {
      cwd: review.worktree,
      description,
      model,
      isBackground: true,
      maxTurns: type === "review" ? 35 : type === REFACTOR_REVIEWER ? 20 : 80,
      onToolActivity: (activity: {
        type: "start" | "end";
        toolName: string;
      }) => {
        if (activity.type === "start") {
          preview.activeTools.push(activity.toolName);
        } else {
          const index = preview.activeTools.indexOf(activity.toolName);

          if (index >= 0) {
            preview.activeTools.splice(index, 1);
          }

          preview.toolUses += 1;
        }

        refreshPreview();
      },
      onTextDelta: (_delta: string, fullText: string) => {
        preview.responseText = fullText;
        refreshPreview();
      },
      onTurnEnd: (turnCount: number) => {
        preview.turnCount = turnCount;
        refreshPreview();
      },
    };

    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")] as
      | SubagentManagerRegistry
      | undefined;

    if (registry && currentCtx) {
      const id = registry.spawn(pi, currentCtx, type, prompt, options);
      agentPreviews.set(id, preview);
      updateUi(currentCtx);

      return id;
    }

    const requestId = randomUUID();

    return new Promise<string>((resolve, reject) => {
      const channel = `subagents:rpc:spawn:reply:${requestId}`;

      const unsubscribe = pi.events.on(channel, (data) => {
        clearTimeout(timeout);
        unsubscribe();
        const reply = data as SpawnReply;
        const id = reply.data?.id;

        if (!reply.success || !id) {
          reject(new Error(reply.error ?? "Subagent spawn failed"));

          return;
        }

        agentPreviews.set(id, preview);
        refreshPreview();
        resolve(id);
      });

      const timeout = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(
            "Subagent extension is unavailable in this process; restart Pi and resume the session",
          ),
        );
      }, 5_000);

      pi.events.emit("subagents:rpc:spawn", {
        requestId,
        type,
        prompt,
        options,
      });
    });
  }

  async function dispatchWorker(
    ctx: ExtensionContext,
    review: Review,
    instructions?: string,
    continuation = false,
  ): Promise<string> {
    const phase = phases.get(review.key) ?? "idle";

    if (phase === "working" || phase === "reviewing") {
      throw new Error(`${displayKey(review)} already has active Shepherd work`);
    }

    if (!continuation) {
      correctionLoops[review.key] = 0;
      persist();
    }

    const blockedReason = await worktreeBlockedReason(pi, review.worktree);
    const resumingRebase =
      blockedReason?.startsWith("rebase in progress") === true;

    if (!resumingRebase && !(await cleanWorktree(pi, review.worktree))) {
      phases.set(review.key, "blocked");
      updateUi(ctx);
      throw new Error(
        `${displayKey(review)} has local changes; Shepherd requires a clean worktree before dispatch`,
      );
    }

    const baseline = await worktreeFingerprint(pi, review.worktree);

    const id = await spawnAgent(
      "general-purpose",
      review,
      `Tend ${displayKey(review)}`,
      workerPrompt(review, instructions),
    );

    activeRuns.set(id, { kind: "worker", reviewKey: review.key, baseline });
    phases.set(review.key, "working");
    reviewedFingerprints.delete(review.key);
    updateUi(ctx);

    return id;
  }

  async function spawnAdversarialReviews(
    ctx: ExtensionContext,
    review: Review,
  ): Promise<void> {
    const fingerprint = await worktreeFingerprint(pi, review.worktree);

    const cycle: ReviewCycle = {
      pending: new Set(),
      failed: false,
      fingerprint,
      results: [],
    };

    reviewCycles.set(review.key, cycle);
    phases.set(review.key, "reviewing");
    updateUi(ctx);

    const requests = [
      {
        kind: "correctness" as const,
        type: "review",
        description: `Challenge ${displayKey(review)}`,
        prompt: correctnessPrompt(review),
      },
      {
        kind: "refactor" as const,
        type: REFACTOR_REVIEWER,
        description: `Simplify ${displayKey(review)}`,
        prompt: refactorPrompt(review),
      },
    ];

    const results = await Promise.allSettled(
      requests.map(async (request) => {
        const id = await spawnAgent(
          request.type,
          review,
          request.description,
          request.prompt,
        );
        activeRuns.set(id, { kind: request.kind, reviewKey: review.key });
        cycle.pending.add(id);
      }),
    );

    if (results.every((result) => result.status === "rejected")) {
      phases.set(review.key, "blocked");
      cycle.failed = true;
      updateUi(ctx);
      throw new Error(
        `Unable to start adversarial reviewers for ${displayKey(review)}`,
      );
    }

    if (results.some((result) => result.status === "rejected")) {
      cycle.failed = true;
      ctx.ui.notify(
        `${displayKey(review)} started only one adversarial reviewer`,
        "warning",
      );
    }

    updateUi(ctx);
  }

  async function handleRunFinished(
    data: unknown,
    failed: boolean,
  ): Promise<void> {
    const value = data as
      | { id?: string; result?: string; error?: string }
      | undefined;
    const id = value?.id;
    const ctx = currentCtx;

    if (!id || !ctx) {
      return;
    }

    const run = activeRuns.get(id);

    if (!run) {
      return;
    }

    activeRuns.delete(id);
    agentPreviews.delete(id);
    const review = reviews.get(run.reviewKey);

    if (!review) {
      return;
    }

    if (run.kind === "worker") {
      const fingerprint = await worktreeFingerprint(pi, review.worktree);

      if (fingerprint !== run.baseline) {
        const blockedReason = await worktreeBlockedReason(pi, review.worktree);

        if (blockedReason) {
          phases.set(review.key, "blocked");
          reportToCoordinator(
            review,
            `Shepherd stopped with ${blockedReason}.`,
            [
              {
                kind: "worker",
                result: value?.result ?? value?.error ?? "No output.",
              },
            ],
          );
          updateUi(ctx);

          return;
        }

        await spawnAdversarialReviews(ctx, review);

        return;
      }

      const loop = correctionLoops[review.key] ?? 0;

      if (failed || loop > 0) {
        phases.set(review.key, "blocked");
        reportToCoordinator(
          review,
          failed
            ? "Shepherd worker failed before resolving the review findings."
            : "Shepherd worker made no changes for unresolved review findings.",
          [
            {
              kind: "worker",
              result: value?.error ?? value?.result ?? "No output.",
            },
          ],
        );
      } else {
        phases.set(review.key, "idle");
      }

      updateUi(ctx);

      return;
    }

    const cycle = reviewCycles.get(review.key);

    if (!cycle) {
      return;
    }

    cycle.pending.delete(id);
    cycle.failed ||= failed;
    cycle.results.push({
      kind: run.kind,
      result: value?.result ?? value?.error ?? "No output.",
    });

    if (cycle.pending.size > 0) {
      updateUi(ctx);

      return;
    }

    reviewCycles.delete(review.key);

    if (cycle.failed) {
      phases.set(review.key, "blocked");
      reportToCoordinator(
        review,
        "Shepherd adversarial review was incomplete and needs attention.",
        cycle.results,
      );
      updateUi(ctx);

      return;
    }

    const correctness = cycle.results.filter(
      (result) => result.kind === "correctness",
    );
    const refactoring = cycle.results.filter(
      (result) => result.kind === "refactor",
    );
    const correctnessFindings = correctness.filter((result) =>
      hasMaterialFindings(result.result),
    );
    const refactoringFindings = refactoring.filter((result) =>
      hasMaterialFindings(result.result),
    );

    if (correctnessFindings.length > 0) {
      const loop = correctionLoops[review.key] ?? 0;

      if (loop >= MAX_CORRECTION_LOOPS) {
        phases.set(review.key, "blocked");
        reportToCoordinator(
          review,
          `Shepherd stopped after ${MAX_CORRECTION_LOOPS} corrective loops with unresolved findings.`,
          correctnessFindings,
        );
        updateUi(ctx);

        return;
      }

      correctionLoops[review.key] = loop + 1;
      persist();
      phases.set(review.key, "idle");

      const findings = correctnessFindings
        .map((result) => result.result)
        .join("\n\n")
        .slice(0, 8_000);

      try {
        await dispatchWorker(
          ctx,
          review,
          `Correct the following adversarial findings from loop ${loop + 1}/${MAX_CORRECTION_LOOPS}. Add focused regression coverage, validate, and commit locally. Do not push.\n\n${findings}`,
          true,
        );
        ctx.ui.notify(
          `${displayKey(review)} started corrective loop ${loop + 1}/${MAX_CORRECTION_LOOPS}`,
          "warning",
        );
      } catch (error) {
        phases.set(review.key, "blocked");
        reportToCoordinator(
          review,
          "Shepherd could not start the next corrective loop.",
          [{ kind: "dispatch", result: String(error) }, ...correctnessFindings],
        );
      }

      updateUi(ctx);

      return;
    }

    phases.set(review.key, "reviewed");
    reviewedFingerprints.set(review.key, cycle.fingerprint);

    if (refactoringFindings.length > 0) {
      reportToCoordinator(
        review,
        "Correctness review is clean; refactoring proposals require approval.",
        refactoringFindings,
      );
    } else {
      ctx.ui.notify(`${displayKey(review)} adversarial review clean`, "info");
    }

    updateUi(ctx);
  }

  function retryAttemptKey(review: Review, target: { name: string }): string {
    return `${review.key}:${review.headSha}:${target.name}`;
  }

  async function retryReviewCi(
    ctx: ExtensionContext,
    review: Review,
  ): Promise<number> {
    await refresh(ctx);
    const currentReview = reviews.get(review.key);

    if (!currentReview) {
      throw new Error(`${displayKey(review)} is no longer open`);
    }

    review = currentReview;

    const head = await currentHead(pi, review.worktree);

    if (head !== review.headSha) {
      throw new Error(
        `${displayKey(review)} local HEAD does not match the review HEAD; refresh or push the branch before retrying CI`,
      );
    }

    const targets = await retryTargets(pi, review);

    const available = targets.filter((target) => {
      const key = retryAttemptKey(review, target);

      return (retryAttempts[key] ?? 0) < MAX_RETRY_ATTEMPTS;
    });

    if (available.length === 0) {
      throw new Error(`${displayKey(review)} has no retryable failed CI jobs`);
    }

    if (!ctx.hasUI) {
      throw new Error("Shepherd CI retry requires interactive confirmation");
    }

    const confirmed = await ctx.ui.confirm(
      `Retry CI for ${displayKey(review)}?`,
      available
        .map((target) => {
          const key = retryAttemptKey(review, target);

          return `${target.name} (${target.status}, attempt ${(retryAttempts[key] ?? 0) + 1}/${MAX_RETRY_ATTEMPTS})`;
        })
        .join("\n"),
    );

    if (!confirmed) {
      return 0;
    }

    let retried = 0;

    for (const target of available) {
      const key = retryAttemptKey(review, target);
      await retryCiTarget(pi, review, target);
      retryAttempts[key] = (retryAttempts[key] ?? 0) + 1;
      retried += 1;
    }

    persist();
    review.status = "waiting";
    review.summary = `CI retry submitted for ${retried} job${retried === 1 ? "" : "s"}`;
    updateUi(ctx);

    return retried;
  }

  async function start(ctx: ExtensionCommandContext): Promise<void> {
    await refresh(ctx, true);
    const candidates = [...reviews.values()];

    if (candidates.length === 0) {
      ctx.ui.notify(
        "No open reviews with Shirei worktrees were found",
        "warning",
      );

      return;
    }

    const chosen = await selectReviews(ctx, candidates, selected);

    if (!chosen || chosen.size === 0) {
      ctx.ui.notify("Shepherd start cancelled: no reviews selected", "info");

      return;
    }

    selected = chosen;
    active = true;
    persist();
    startPolling(ctx);
    updateUi(ctx);
    ctx.ui.notify(
      `Shepherd started with ${selected.size} review${selected.size === 1 ? "" : "s"}`,
      "info",
    );
  }

  async function selectFlock(ctx: ExtensionCommandContext): Promise<void> {
    await refresh(ctx, true);
    const chosen = await selectReviews(ctx, [...reviews.values()], selected);

    if (!chosen) {
      return;
    }

    selected = chosen;

    if (selected.size === 0) {
      active = false;
      stopPolling();
    }

    persist();
    updateUi(ctx);
  }

  function stop(ctx: ExtensionContext): void {
    active = false;
    stopPolling();
    persist();
    updateUi(ctx);
    ctx.ui.notify("Shepherd stopped", "info");
  }

  function statusText(): string {
    if (!active) {
      return "Shepherd is stopped.";
    }

    const flock = selectedReviews();

    if (flock.length === 0) {
      return "Shepherd is active, but none of its selected reviews are currently available.";
    }

    return flock
      .map((review) => `${review.key}: ${phaseSummary(review)}`)
      .join("\n");
  }

  async function commandReview(
    ctx: ExtensionCommandContext,
    value: string,
    title: string,
  ): Promise<Review | undefined> {
    const resolved = resolveReview(value);

    if (resolved) {
      return resolved;
    }

    if (value.trim()) {
      ctx.ui.notify(`Selected review not found: ${value.trim()}`, "warning");

      return undefined;
    }

    return chooseReview(ctx, selectedReviews(), title);
  }

  pi.registerCommand("shepherd", {
    description: "Select and tend open PRs/MRs with Shirei worktrees",
    getArgumentCompletions: (prefix) => {
      const commands = [
        {
          value: "start",
          label: "start",
          description: "Select reviews and start monitoring",
        },
        {
          value: "select",
          label: "select",
          description: "Change the selected reviews",
        },
        {
          value: "status",
          label: "status",
          description: "Show the current flock",
        },
        {
          value: "refresh",
          label: "refresh",
          description: "Refresh forge and CI state",
        },
        {
          value: "dispatch",
          label: "dispatch",
          description: "Start a worker for a selected review",
        },
        {
          value: "retry",
          label: "retry",
          description: "Retry failed CI for a selected review",
        },
        { value: "stop", label: "stop", description: "Stop monitoring" },
      ];

      const normalized = prefix.trimStart();
      const separator = normalized.indexOf(" ");

      if (separator < 0) {
        const matches = commands.filter((command) =>
          command.value.startsWith(normalized),
        );

        return matches.length > 0 ? matches : null;
      }

      const action = normalized.slice(0, separator);

      if (action !== "dispatch" && action !== "retry") {
        return null;
      }

      const matches = selectedReviews()
        .map((review) => ({
          value: `${action} ${review.key}`,
          label: `${action} ${displayKey(review)}`,
          description: `${review.title} · ${phaseSummary(review)}`,
        }))
        .filter((item) => item.value.startsWith(normalized));

      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const [action = active ? "status" : "start", ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      if (action === "start") {
        await start(ctx);

        return;
      }

      if (action === "select") {
        await selectFlock(ctx);

        return;
      }

      if (action === "stop") {
        stop(ctx);

        return;
      }

      if (action === "status") {
        ctx.ui.notify(statusText(), "info");

        return;
      }

      if (action === "refresh") {
        await refresh(ctx, true);
        ctx.ui.notify("Shepherd refreshed", "info");

        return;
      }

      if (action === "dispatch") {
        const review = await commandReview(
          ctx,
          rest[0] ?? "",
          "Dispatch Shepherd worker",
        );

        if (!review) {
          return;
        }

        const instructions = rest.slice(1).join(" ");
        const id = await dispatchWorker(ctx, review, instructions);
        ctx.ui.notify(
          `Started Shepherd worker ${id} for ${displayKey(review)}`,
          "info",
        );

        return;
      }

      if (action === "retry") {
        const review = await commandReview(
          ctx,
          rest.join(" "),
          "Retry CI for review",
        );

        if (!review) {
          return;
        }

        const count = await retryReviewCi(ctx, review);

        if (count > 0) {
          ctx.ui.notify(
            `Retried ${count} CI job${count === 1 ? "" : "s"}`,
            "info",
          );
        }

        return;
      }

      ctx.ui.notify(
        "Usage: /shepherd start|select|status|refresh|dispatch [review] [instructions]|retry [review]|stop",
        "warning",
      );
    },
  });

  pi.registerTool({
    name: "shepherd_status",
    label: "Shepherd Status",
    description: "Show the selected review fleet and current Shepherd activity",
    promptSnippet: "Inspect the current Shepherd PR/MR fleet",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text" as const, text: statusText() }],
        details: savedState(),
      };
    },
  });

  pi.registerTool({
    name: "shepherd_dispatch",
    label: "Shepherd Dispatch",
    description: "Dispatch a background worker for a selected Shepherd review",
    promptSnippet: "Dispatch work for a selected Shepherd PR or MR",
    promptGuidelines: [
      "Shepherd workers automatically rebase review branches onto their declared target branch and may resume an interrupted Shepherd rebase; they must not merge, reset, cherry-pick, or push.",
    ],
    parameters: Type.Object({
      review: Type.String({
        description:
          "Selected review key, such as owner/repo#123 or group/repo!456",
      }),
      instructions: Type.Optional(
        Type.String({
          description: "Additional focused instructions for the worker",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const review = resolveReview(params.review);

      if (!active || !review) {
        throw new Error(
          `Shepherd review is not active or selected: ${params.review}`,
        );
      }

      const id = await dispatchWorker(ctx, review, params.instructions);

      return {
        content: [
          {
            type: "text" as const,
            text: `Started worker ${id} for ${review.key}.`,
          },
        ],
        details: { review: review.key, agentId: id },
      };
    },
  });

  pi.registerTool({
    name: "shepherd_retry_ci",
    label: "Shepherd Retry CI",
    description:
      "Confirm and retry failed CI jobs for a selected Shepherd review",
    promptSnippet: "Retry failed CI jobs for a selected Shepherd PR or MR",
    promptGuidelines: [
      "Use shepherd_retry_ci only when the user explicitly asks to restart failed CI jobs.",
    ],
    parameters: Type.Object({
      review: Type.String({
        description:
          "Selected review key, such as owner/repo#123 or group/repo!456",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const review = resolveReview(params.review);

      if (!active || !review) {
        throw new Error(
          `Shepherd review is not active or selected: ${params.review}`,
        );
      }

      const count = await retryReviewCi(ctx, review);

      return {
        content: [
          {
            type: "text" as const,
            text:
              count > 0 ? `Retried ${count} CI job(s).` : "CI retry cancelled.",
          },
        ],
        details: { review: review.key, retried: count },
      };
    },
  });

  const unsubscribeCompleted = pi.events.on("subagents:completed", (data) => {
    void handleRunFinished(data, false).catch((error) => {
      currentCtx?.ui.notify(
        `Shepherd completion handling failed: ${String(error)}`,
        "error",
      );
    });
  });

  const unsubscribeFailed = pi.events.on("subagents:failed", (data) => {
    void handleRunFinished(data, true).catch((error) => {
      currentCtx?.ui.notify(
        `Shepherd failure handling failed: ${String(error)}`,
        "error",
      );
    });
  });

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    restore(ctx);

    if (active) {
      startPolling(ctx);
      void refresh(ctx).catch((error) => {
        ctx.ui.notify(
          `Unable to restore Shepherd: ${String(error)}`,
          "warning",
        );
      });
    }

    updateUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    currentCtx = undefined;
    unsubscribeCompleted();
    unsubscribeFailed();
  });
}
