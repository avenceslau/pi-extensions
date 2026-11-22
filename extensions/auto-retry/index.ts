import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isForbiddenForSubagents, loadConfig, modelChainFromEnv, type ModelsConfig } from "../shared/config.ts";

// Replaces pi's built-in auto-retry: retries transient provider errors indefinitely with
// capped exponential backoff and fails over to the next model when a provider is broken.
// Requires `retry.enabled: false` in settings.json so pi's built-in retry does not race with it.

// Failures that hold for every model of the provider: credentials and account spending limits.
const PROVIDER_UNAVAILABLE_PATTERN =
  /\b401\b|unauthorized|invalid_token|api key auth failed|failed to resolve api key|spending limit/i;

const TRANSIENT_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|bad gateway|gateway.?time-?out|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?reset|connection.?lost|econnreset|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|operation was aborted|retry delay|stream ended|unexpected end of stream|premature close/i;

// pi-subagents names child sessions `<agentType>#<first 8 hex chars of the agent id>` before
// their extensions bind.
export const SUBAGENT_SESSION_NAME = /^(.+)#[0-9a-f]{8}$/;

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 120_000;
const TRANSIENT_FAILURES_BEFORE_FAILOVER = 3;
const UNAVAILABLE_TTL_MS = 10 * 60_000;
const PENDING_INPUT_POLL_MS = 250;

// Kept as "auto-retry-kick" so the context filter also strips retry messages persisted by
// older versions of this extension.
const RETRY_MESSAGE_TYPE = "auto-retry-kick";
const STATUS_KEY = "auto-retry";
const WIDGET_KEY = "auto-retry";

// Subagent sessions run in the parent's process, so a provider or model one session found
// unavailable is skipped by every other session too. Keys are providers or `provider/modelId`.
const UNAVAILABLE_SINCE_KEY = Symbol.for("pi-extensions/auto-retry/unavailable-since");

export type FailureKind = "transient" | "model-unavailable" | "provider-unavailable" | "fatal";

// `modelUnavailable` matches errors tied to the upstream behind one model, such as a gateway's 526, so other models
// of the same provider may still work.
export function classifyFailure(
  message: AssistantMessage,
  contextWindow: number | undefined,
  modelUnavailable?: RegExp,
): FailureKind {
  if (
    message.stopReason !== "error" ||
    !message.errorMessage
  ) {
    return "fatal";
  }

  // Context overflow needs compaction, not a retry.
  if (isContextOverflow(message, contextWindow)) {
    return "fatal";
  }

  if (PROVIDER_UNAVAILABLE_PATTERN.test(message.errorMessage)) {
    return "provider-unavailable";
  }

  if (modelUnavailable?.test(message.errorMessage)) {
    return "model-unavailable";
  }

  if (TRANSIENT_PATTERN.test(message.errorMessage)) {
    return "transient";
  }

  return "fatal";
}

// Subagents never use a forbidden model, even when an env override lists it.
export function failoverChain(models: ModelsConfig | undefined, isSubagent: boolean): string[] {
  if (!isSubagent) {
    return modelChainFromEnv(process.env.PI_FAILOVER_MODELS) ?? models?.primary ?? [];
  }

  const chain = modelChainFromEnv(process.env.PI_SUBAGENT_FAILOVER_MODELS) ?? models?.subagent ?? [];

  return chain.filter((modelRef) => !isForbiddenForSubagents(models, modelRef));
}

function modelUnavailablePattern(models: ModelsConfig | undefined): RegExp | undefined {
  return models?.unavailable === undefined ? undefined : new RegExp(models.unavailable);
}

export function providerOf(modelRef: string): string {
  return modelRef.slice(0, modelRef.indexOf("/"));
}

function modelIdOf(modelRef: string): string {
  return modelRef.slice(modelRef.indexOf("/") + 1);
}

// Models after the current one in chain order, wrapping around; the whole chain when the
// current model is not part of it.
export function failoverCandidates(
  chain: string[],
  currentModelRef: string | undefined,
  isUnavailable: (modelRef: string) => boolean,
): string[] {
  const currentIndex = currentModelRef === undefined ? -1 : chain.indexOf(currentModelRef);
  const rotated = [...chain.slice(currentIndex + 1), ...chain.slice(0, currentIndex + 1)];

  return rotated.filter((modelRef) => modelRef !== currentModelRef && !isUnavailable(modelRef));
}

export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

function unavailableSince(): Map<string, number> {
  const store = globalThis as typeof globalThis & { [UNAVAILABLE_SINCE_KEY]?: Map<string, number> };
  store[UNAVAILABLE_SINCE_KEY] ??= new Map();

  return store[UNAVAILABLE_SINCE_KEY];
}

function markUnavailable(providerOrModelRef: string): void {
  unavailableSince().set(providerOrModelRef, Date.now());
}

function isMarkedUnavailable(providerOrModelRef: string): boolean {
  const markedAt = unavailableSince().get(providerOrModelRef);

  return markedAt !== undefined && Date.now() - markedAt < UNAVAILABLE_TTL_MS;
}

function isUnavailable(modelRef: string): boolean {
  return isMarkedUnavailable(providerOf(modelRef)) || isMarkedUnavailable(modelRef);
}

function modelRefOf(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function shortError(errorMessage: string): string {
  const firstLine = errorMessage.split("\n")[0].trim();

  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

interface RetryState {
  attempt: number;
  transientFailureProvider: string | undefined;
  transientFailureCount: number;
}

export default function (pi: ExtensionAPI) {
  let state: RetryState | null = null;
  let lastAssistantMessage: AssistantMessage | undefined;
  let cancelRetryWait: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;

  const reset = (ctx: ExtensionContext) => {
    cancelRetryWait?.();
    state = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  // Resolves true once the delay elapses, false when Esc, a queued user message, or session
  // shutdown cancels it. The run sits between turns here, so ctx.signal is undefined and a
  // queued message is the only sign of new user input.
  const waitBeforeRetry = (delayMs: number, ctx: ExtensionContext): Promise<boolean> => {
    return new Promise((resolve) => {
      const finish = (elapsed: boolean) => {
        clearTimeout(timer);
        clearInterval(inputPoll);
        cancelRetryWait = undefined;
        resolve(elapsed);
      };

      const timer = setTimeout(() => finish(true), delayMs);

      const inputPoll = setInterval(() => {
        if (ctx.hasPendingMessages()) {
          ctx.ui.notify("Cancelled pending auto-retry (new user message).", "info");
          finish(false);
        }
      }, PENDING_INPUT_POLL_MS);

      cancelRetryWait = () => finish(false);
    });
  };

  const switchToHealthyModel = async (ctx: ExtensionContext): Promise<Model<Api> | undefined> => {
    const isSubagent = SUBAGENT_SESSION_NAME.test(pi.getSessionName() ?? "");
    const chain = failoverChain(loadConfig(pi).models, isSubagent);

    for (const modelRef of failoverCandidates(chain, modelRefOf(ctx.model), isUnavailable)) {
      // setModel failures below can mark a later candidate's provider.
      if (isUnavailable(modelRef)) {
        continue;
      }

      const model = ctx.modelRegistry.find(providerOf(modelRef), modelIdOf(modelRef));

      if (!model) {
        continue;
      }

      // setModel throws instead of returning false when the provider's API key cannot be resolved.
      if (await pi.setModel(model).catch(() => false)) {
        return model;
      }

      markUnavailable(model.provider);
    }

    return undefined;
  };

  const retryInSameRun = (entries: SessionBoundaryDraft[]): BoundaryResult => {
    return {
      entries: [
        ...entries,
        {
          type: "custom_message",
          customType: RETRY_MESSAGE_TYPE,
          content: "",
          display: false,
          details: { attempt: state?.attempt },
        },
      ],
      continue: true,
    };
  };

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") {
      return;
    }

    lastAssistantMessage = event.message;

    if (
      event.message.stopReason === "error" ||
      !state
    ) {
      return;
    }

    if (event.message.stopReason !== "aborted") {
      const attempts = state.attempt;
      ctx.ui.notify(`Recovered after ${attempts} retr${attempts === 1 ? "y" : "ies"}.`, "info");
    }

    reset(ctx);
  });

  // Retrying here instead of from a timer keeps the retry inside the same run, so
  // session.prompt() does not return until the retry finishes. Subagent callers rely on that:
  // a retry scheduled after prompt() returned kept a "failed" child running.
  pi.on("agent_before_settle", async (event, ctx) => {
    const failed = lastAssistantMessage;
    lastAssistantMessage = undefined;

    if (failed?.stopReason !== "error") {
      return;
    }

    const errorMessage = failed.errorMessage ?? "unknown error";
    const kind = classifyFailure(failed, ctx.model?.contextWindow, modelUnavailablePattern(loadConfig(pi).models));

    if (kind === "fatal") {
      if (state) {
        ctx.ui.notify(`Stopping auto-retry: error is not transient (${errorMessage}).`, "error");
        reset(ctx);
      }

      return;
    }

    state ??= {
      attempt: 0,
      transientFailureProvider: undefined,
      transientFailureCount: 0,
    };
    state.attempt += 1;

    const failedModelRef = modelRefOf(ctx.model);
    const failedProvider = ctx.model?.provider;

    switch (kind) {
      case "provider-unavailable":
        if (failedProvider) {
          markUnavailable(failedProvider);
        }

        break;
      case "model-unavailable":
        if (failedModelRef) {
          markUnavailable(failedModelRef);
        }

        break;
      case "transient":
        if (state.transientFailureProvider !== failedProvider) {
          state.transientFailureProvider = failedProvider;
          state.transientFailureCount = 0;
        }

        state.transientFailureCount += 1;
        break;
    }

    const shouldFailOver =
      kind !== "transient" ||
      state.transientFailureCount >= TRANSIENT_FAILURES_BEFORE_FAILOVER;

    if (shouldFailOver) {
      const model = await switchToHealthyModel(ctx);

      if (model) {
        ctx.ui.notify(
          `${failedModelRef ?? "The current model"} failed (${shortError(errorMessage)}); switched to ${model.provider}/${model.id}.`,
          "warning",
        );
        state.transientFailureProvider = undefined;
        state.transientFailureCount = 0;

        return retryInSameRun(event.entries);
      }
    }

    if (kind !== "transient") {
      ctx.ui.notify(
        `Stopping auto-retry: ${failedModelRef ?? "the current model"} failed (${shortError(errorMessage)}) and no fallback model is healthy.`,
        "error",
      );
      reset(ctx);

      return;
    }

    const backoffMs = retryDelayMs(state.transientFailureCount);
    // Half fixed and half random, so sessions that failed together do not retry in lockstep.
    const delayMs = backoffMs / 2 + Math.random() * (backoffMs / 2);
    const capped = backoffMs >= MAX_DELAY_MS ? " (capped)" : "";
    ctx.ui.notify(
      `Transient error: ${errorMessage}. Retrying in ${formatSeconds(delayMs)} (attempt ${state.attempt}${capped}).`,
      "warning",
    );
    ctx.ui.setStatus(STATUS_KEY, `↻ retry #${state.attempt} in ${formatSeconds(delayMs)}${capped}`);
    ctx.ui.setWidget(WIDGET_KEY, [
      "↻ Transient provider error — auto-retry",
      `   attempt ${state.attempt} · waiting ${formatSeconds(delayMs)}${capped} · ${errorMessage}`,
    ]);

    const elapsed = await waitBeforeRetry(delayMs, ctx);

    if (!elapsed) {
      reset(ctx);

      return;
    }

    ctx.ui.setStatus(STATUS_KEY, `↻ retrying… (#${state.attempt})`);
    ctx.ui.setWidget(WIDGET_KEY, undefined);

    return retryInSameRun(event.entries);
  });

  // Hide retry messages and the failed responses they replaced, as pi's built-in retry does.
  pi.on("context", async (event, ctx) => {
    const contextWindow = ctx.model?.contextWindow;
    const modelUnavailable = modelUnavailablePattern(loadConfig(pi).models);

    const messages = event.messages.filter((message) => {
      if (
        message.role === "custom" &&
        message.customType === RETRY_MESSAGE_TYPE
      ) {
        return false;
      }

      if (message.role === "assistant" && message.stopReason === "error") {
        return classifyFailure(message, contextWindow, modelUnavailable) === "fatal";
      }

      return true;
    });

    return { messages };
  });

  // Esc is consumed only while a retry is waiting, so pi's own Esc handling is untouched otherwise.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }

    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (!cancelRetryWait || !matchesKey(data, "escape")) {
        return undefined;
      }

      ctx.ui.notify("Auto-retry cancelled.", "info");
      cancelRetryWait();

      return { consume: true };
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    reset(ctx);
  });
}
