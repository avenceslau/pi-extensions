import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type CodeReviewResult = {
  approved: boolean;
  feedback?: string;
};

type PlannotatorResponse =
  | { status: "handled"; result: CodeReviewResult }
  | { status: "unavailable"; error?: string }
  | { status: "error"; error: string };

function listeningPorts(output: string): Set<number> {
  const ports = new Set<number>();

  for (const line of output.split("\n")) {
    const match = line.match(/^n(?:127\.0\.0\.1|localhost|\*):([0-9]+)$/);

    if (match) {
      ports.add(Number(match[1]));
    }
  }

  return ports;
}

async function currentListeningPorts(pi: ExtensionAPI): Promise<Set<number>> {
  const result = await pi.exec(
    "lsof",
    ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
    { timeout: 2_000 },
  );

  return result.code === 0 ? listeningPorts(result.stdout) : new Set();
}

async function waitForReviewUrl(pi: ExtensionAPI, previousPorts: Set<number>): Promise<string | undefined> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ports = await currentListeningPorts(pi);
    const newPort = [...ports].find((port) => !previousPorts.has(port));

    if (newPort !== undefined) {
      return `http://localhost:${newPort}`;
    }
  }

  return undefined;
}

function requestIncrementalReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<PlannotatorResponse> {
  return new Promise((resolve) => {
    pi.events.emit("plannotator:request", {
      requestId: randomUUID(),
      action: "code-review",
      payload: {
        cwd: ctx.cwd,
        defaultBranch: "HEAD",
        diffType: "since-base",
        vcsType: "git",
        useLocal: true,
      },
      respond: resolve,
    });
  });
}

async function runIncrementalReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.setStatus("plannotator-incremental", "Opening incremental review…");

  try {
    const previousPorts = await currentListeningPorts(pi);
    const responsePromise = requestIncrementalReview(pi, ctx);
    const reviewUrl = await waitForReviewUrl(pi, previousPorts);

    if (reviewUrl !== undefined) {
      const opened = await pi.exec("open", [reviewUrl], { timeout: 5_000 });
      ctx.ui.notify(
        opened.code === 0 ? `Incremental review opened: ${reviewUrl}` : `Open this URL to review: ${reviewUrl}`,
        "info",
      );
    }

    const response = await responsePromise;

    if (response.status !== "handled") {
      ctx.ui.notify(response.error ?? "Plannotator is unavailable", "error");

      return;
    }

    if (response.result.feedback) {
      pi.sendUserMessage(response.result.feedback, { deliverAs: "followUp" });

      return;
    }

    ctx.ui.notify(
      response.result.approved ? "Incremental review approved." : "Incremental review closed without feedback.",
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Incremental review failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    ctx.ui.setStatus("plannotator-incremental", undefined);
  }
}

export default function plannotatorIncremental(pi: ExtensionAPI): void {
  pi.registerCommand("review-incremental", {
    description: "Open only changes since the current HEAD in Plannotator",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /review-incremental", "warning");

        return;
      }

      const plannotatorAvailable = pi
        .getCommands()
        .some((command) => command.name === "plannotator-review" || command.name.startsWith("plannotator-review:"));

      if (!plannotatorAvailable) {
        ctx.ui.notify("Plannotator is not loaded in this session", "error");

        return;
      }

      void runIncrementalReview(pi, ctx);
    },
  });
}
