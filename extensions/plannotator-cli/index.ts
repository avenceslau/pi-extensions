import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

const MAX_OUTPUT_BYTES = 256 * 1024;
const STATUS_KEY = "plannotator-cli";
const LOCAL_EXECUTABLE = join(homedir(), ".local", "bin", "plannotator");

const INSTALL_INSTRUCTIONS =
  "Plannotator CLI was not found. Install it with: curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal";

const SpawnErrorType = Type.Object(
  { code: Type.Optional(Type.String()) },
  { additionalProperties: true },
);

const LastDecisionType = Type.Union([
  Type.Object({ decision: Type.Literal("approved") }),
  Type.Object({ decision: Type.Literal("dismissed") }),
  Type.Object({
    decision: Type.Literal("annotated"),
    feedback: Type.String(),
  }),
]);

type ReviewOutcome =
  | { kind: "approved" }
  | { kind: "dismissed" }
  | { kind: "feedback"; feedback: string };

type PlannotatorProcessOutput = {
  stdout: string;
  stderr: string;
};

type ProcessOptions = {
  cwd: string;
  input?: string;
  signal?: AbortSignal;
};

function executablePath(): string {
  return existsSync(LOCAL_EXECUTABLE) ? LOCAL_EXECUTABLE : "plannotator";
}

export function runPlannotatorProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<PlannotatorProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PLANNOTATOR_CWD: options.cwd,
        PLANNOTATOR_ORIGIN: "pi",
      },
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputExceeded = false;
    let settled = false;

    const append = (chunk: Buffer, target: "stdout" | "stderr") => {
      outputBytes += chunk.byteLength;

      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();

        return;
      }

      if (target === "stdout") {
        stdout += chunk.toString("utf8");
      } else {
        stderr += chunk.toString("utf8");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;

      if (Check(SpawnErrorType, error) && error.code === "ENOENT") {
        reject(new Error(INSTALL_INSTRUCTIONS));

        return;
      }

      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;

      if (outputExceeded) {
        reject(new Error("Plannotator produced more than 256 KiB of output"));

        return;
      }

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`Plannotator failed: ${detail}`));

        return;
      }

      resolve({ stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

type ConversationEntry = ReturnType<
  ExtensionContext["sessionManager"]["getBranch"]
>[number];

export function lastAssistantText(
  branch: readonly ConversationEntry[],
  excludedToolCallId?: string,
): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];

    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    if (
      excludedToolCallId !== undefined &&
      entry.message.content.some(
        (content) =>
          content.type === "toolCall" && content.id === excludedToolCallId,
      )
    ) {
      continue;
    }

    const text: string[] = [];

    for (const content of entry.message.content) {
      if (content.type === "text" && content.text.trim()) {
        text.push(content.text);
      }
    }

    if (text.length > 0) {
      return text.join("\n");
    }
  }

  return undefined;
}

export function parseLastDecision(output: string): ReviewOutcome {
  const text = output.trim();

  if (!text) {
    return { kind: "dismissed" };
  }

  let decision: unknown;

  try {
    decision = JSON.parse(text);
  } catch {
    throw new Error(`Plannotator returned invalid JSON: ${text}`);
  }

  if (!Check(LastDecisionType, decision)) {
    throw new Error("Plannotator returned an invalid last-message decision");
  }

  if (decision.decision === "annotated") {
    return decision.feedback.trim()
      ? { kind: "feedback", feedback: decision.feedback }
      : { kind: "dismissed" };
  }

  return { kind: decision.decision };
}

function parseReviewFeedback(output: string): ReviewOutcome {
  const feedback = output.trim();

  if (!feedback || feedback === "Review session closed without feedback.") {
    return { kind: "dismissed" };
  }

  return { kind: "feedback", feedback };
}

async function reviewLastMessage(
  context: ExtensionContext,
  signal?: AbortSignal,
  excludedToolCallId?: string,
): Promise<ReviewOutcome> {
  const message = lastAssistantText(
    context.sessionManager.getBranch(),
    excludedToolCallId,
  );

  if (!message) {
    throw new Error("No earlier assistant message is available to annotate");
  }

  const processOutput = await runPlannotatorProcess(
    executablePath(),
    ["last", "--stdin", "--json"],
    {
      cwd: context.cwd,
      input: message,
      signal,
    },
  );

  return parseLastDecision(processOutput.stdout);
}

async function reviewChanges(
  context: ExtensionContext,
  url?: string,
  signal?: AbortSignal,
): Promise<ReviewOutcome> {
  const args = url ? ["review", url] : ["review"];

  const processOutput = await runPlannotatorProcess(executablePath(), args, {
    cwd: context.cwd,
    signal,
  });

  return parseReviewFeedback(processOutput.stdout);
}

async function withReviewStatus<Output>(
  context: ExtensionContext,
  review: () => Promise<Output>,
): Promise<Output> {
  context.ui.setStatus(STATUS_KEY, "Waiting for Plannotator feedback…");

  try {
    return await review();
  } finally {
    context.ui.setStatus(STATUS_KEY, undefined);
  }
}

function deliverCommandOutcome(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
  outcome: ReviewOutcome,
): void {
  if (outcome.kind === "feedback") {
    pi.sendUserMessage(outcome.feedback, { deliverAs: "followUp" });

    return;
  }

  context.ui.notify(
    outcome.kind === "approved"
      ? "Plannotator review approved."
      : "Plannotator review closed without feedback.",
    "info",
  );
}

function toolResult(outcome: ReviewOutcome) {
  if (outcome.kind === "feedback") {
    return {
      content: [
        {
          type: "text" as const,
          text: `Plannotator feedback:\n${outcome.feedback}`,
        },
      ],
      details: outcome,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text:
          outcome.kind === "approved"
            ? "Plannotator review approved; no changes were requested."
            : "Plannotator review closed without feedback.",
      },
    ],
    details: outcome,
  };
}

export default function plannotatorCli(pi: ExtensionAPI): void {
  pi.registerCommand("plannotator-last", {
    description: "Annotate the last assistant message in Plannotator",
    handler: async (args, context) => {
      if (args.trim()) {
        context.ui.notify("Usage: /plannotator-last", "warning");

        return;
      }

      try {
        const outcome = await withReviewStatus(context, () =>
          reviewLastMessage(context),
        );

        deliverCommandOutcome(pi, context, outcome);
      } catch (error) {
        context.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerCommand("plannotator-review", {
    description: "Review current changes or a pull request in Plannotator",
    handler: async (args, context) => {
      const url = args.trim() || undefined;

      if (url !== undefined && /\s/.test(url)) {
        context.ui.notify("Usage: /plannotator-review [PR URL]", "warning");

        return;
      }

      try {
        const outcome = await withReviewStatus(context, () =>
          reviewChanges(context, url),
        );

        deliverCommandOutcome(pi, context, outcome);
      } catch (error) {
        context.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerTool({
    name: "plannotator_last",
    label: "Review Last Message",
    description:
      "Open the latest prior assistant message in Plannotator and return the user's annotations. Call this tool without sending a commentary preamble first.",
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, _onUpdate, context) {
      const outcome = await withReviewStatus(context, () =>
        reviewLastMessage(context, signal, toolCallId),
      );

      return toolResult(outcome);
    },
  });

  pi.registerTool({
    name: "plannotator_review",
    label: "Review Changes",
    description:
      "Open current changes or a pull request in Plannotator and return review comments to this session.",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({
          maxLength: 2_048,
          description:
            "GitHub pull request or GitLab merge request URL; omit to review current changes",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const outcome = await withReviewStatus(context, () =>
        reviewChanges(context, params.url, signal),
      );

      return toolResult(outcome);
    },
  });
}
