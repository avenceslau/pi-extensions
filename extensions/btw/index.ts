import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../shared/config.ts";

type MergePayload = {
  id: string;
  createdAt: number;
  question: string;
  answer: string;
  sourceSessionPath?: string;
  targetPaneId: string;
  targetSessionId: string;
};

type ChildState = {
  childSessionId: string;
  parentSessionId: string;
};

type PaneSplitResponse = {
  result?: {
    pane?: { pane_id?: string };
  };
};

const HERDR_ENV = process.env.HERDR_ENV;
const HERDR_PANE_ID = process.env.HERDR_PANE_ID;
const BTW_PARENT_AGENT_DIR = process.env.BTW_PARENT_AGENT_DIR;
const BTW_PARENT_PANE_ID = process.env.BTW_PARENT_PANE_ID;
const BTW_PARENT_SESSION_ID = process.env.BTW_PARENT_SESSION_ID;
const BTW_QUESTION = process.env.BTW_QUESTION;

// Side questions always run on Opus 5.5, whatever the parent session uses.

const CHILD_SYSTEM_PROMPT = [
  "You are in a BTW side session forked from another Pi conversation.",
  "Answer the side question directly and concisely.",
  "Do not modify project files unless the user explicitly asks you to.",
  "The user can run /merge to add your answer back to the parent session.",
].join(" ");

export default function (pi: ExtensionAPI) {
  let inboxWatcher: FSWatcher | undefined;
  let rescanTimer: ReturnType<typeof setInterval> | undefined;
  let processingInbox = false;
  let processAgain = false;
  let sessionActive = false;
  let sessionGeneration = 0;
  let currentSessionId: string | undefined;
  let childState: ChildState | undefined;
  let merged = false;

  async function processInbox(ctx: ExtensionContext): Promise<void> {
    processAgain = true;

    if (processingInbox) {
      return;
    }

    const generation = sessionGeneration;
    const sessionId = currentSessionId;
    const paneId = HERDR_PANE_ID;

    if (!sessionActive || !sessionId || !paneId) {
      return;
    }

    processingInbox = true;

    try {
      while (
        processAgain &&
        sessionActive &&
        generation === sessionGeneration &&
        sessionId === currentSessionId
      ) {
        processAgain = false;

        if (!ctx.isIdle()) {
          return;
        }

        const inbox = join(
          getAgentDir(),
          "btw",
          encodeURIComponent(paneId),
          encodeURIComponent(sessionId),
        );

        const files = (await readdir(inbox))
          .filter((file) => file.endsWith(".json"))
          .sort();

        if (
          !sessionActive ||
          generation !== sessionGeneration ||
          sessionId !== currentSessionId
        ) {
          return;
        }

        for (const file of files) {
          if (
            !sessionActive ||
            generation !== sessionGeneration ||
            sessionId !== currentSessionId ||
            !ctx.isIdle()
          ) {
            processAgain = true;

            return;
          }

          const path = join(inbox, file);

          try {
            const rawPayload = await readFile(path, "utf8");

            if (
              !sessionActive ||
              generation !== sessionGeneration ||
              sessionId !== currentSessionId
            ) {
              return;
            }

            if (Buffer.byteLength(rawPayload, "utf8") > 1_000_000) {
              throw new Error("payload is too large");
            }

            const value: unknown = JSON.parse(rawPayload);

            if (!value || typeof value !== "object") {
              throw new Error("payload has an invalid shape");
            }

            const candidate = value as Partial<MergePayload>;

            if (
              typeof candidate.id !== "string" ||
              typeof candidate.createdAt !== "number" ||
              !Number.isFinite(candidate.createdAt) ||
              typeof candidate.question !== "string" ||
              !candidate.question.trim() ||
              typeof candidate.answer !== "string" ||
              !candidate.answer.trim() ||
              typeof candidate.targetPaneId !== "string" ||
              typeof candidate.targetSessionId !== "string" ||
              (candidate.sourceSessionPath !== undefined &&
                typeof candidate.sourceSessionPath !== "string")
            ) {
              throw new Error("payload has an invalid shape");
            }

            const payload = candidate as MergePayload;

            if (
              payload.targetPaneId !== paneId ||
              payload.targetSessionId !== sessionId
            ) {
              throw new Error("payload targets a different session");
            }

            if (
              !sessionActive ||
              generation !== sessionGeneration ||
              sessionId !== currentSessionId ||
              ctx.sessionManager.getSessionId() !== sessionId ||
              !ctx.isIdle()
            ) {
              processAgain = true;

              return;
            }

            const content = [
              "BTW side answer merged into this conversation.",
              "",
              `Question: ${payload.question}`,
              "",
              "Answer:",
              payload.answer,
            ].join("\n");

            pi.sendMessage({
              customType: "btw-merge",
              content,
              display: true,
              details: {
                question: payload.question,
                sourceSessionPath: payload.sourceSessionPath,
              },
            });
            await unlink(path).catch(() => undefined);
            ctx.ui.notify("Merged BTW answer", "info");
          } catch (error) {
            await unlink(path).catch(() => undefined);
            const message =
              error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Discarded BTW merge ${file}: ${message}`, "warning");
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not process BTW merge: ${message}`, "error");
    } finally {
      processingInbox = false;

      if (
        processAgain &&
        sessionActive &&
        generation === sessionGeneration &&
        sessionId === currentSessionId &&
        ctx.isIdle()
      ) {
        void processInbox(ctx);
      }
    }
  }

  pi.on("session_start", async (event, ctx) => {
    sessionGeneration += 1;
    currentSessionId = ctx.sessionManager.getSessionId();
    childState = undefined;
    merged = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        typeof entry.data !== "object" ||
        !entry.data
      ) {
        continue;
      }

      if (entry.customType === "btw-child") {
        const data = entry.data as Partial<ChildState>;

        if (
          data.childSessionId === currentSessionId &&
          typeof data.parentSessionId === "string"
        ) {
          childState = data as ChildState;
        }
      }

      if (
        entry.customType === "btw-merged" &&
        (entry.data as { childSessionId?: unknown }).childSessionId ===
          currentSessionId
      ) {
        merged = true;
      }
    }

    if (
      event.reason === "startup" &&
      BTW_PARENT_SESSION_ID &&
      currentSessionId &&
      !childState
    ) {
      childState = {
        childSessionId: currentSessionId,
        parentSessionId: BTW_PARENT_SESSION_ID,
      };
      pi.appendEntry("btw-child", childState);
    }

    if (ctx.mode !== "tui" || HERDR_ENV !== "1" || !HERDR_PANE_ID) {
      return;
    }

    sessionActive = true;

    const inbox = join(
      getAgentDir(),
      "btw",
      encodeURIComponent(HERDR_PANE_ID),
      encodeURIComponent(currentSessionId),
    );

    await mkdir(inbox, { recursive: true, mode: 0o700 });

    inboxWatcher = watch(inbox, () => {
      void processInbox(ctx);
    });
    inboxWatcher.on("error", (error) => {
      ctx.ui.notify(`BTW inbox watcher failed: ${error.message}`, "error");
    });
    rescanTimer = setInterval(() => {
      void processInbox(ctx);
    }, 5000);
    rescanTimer.unref?.();

    await processInbox(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (sessionActive) {
      await processInbox(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    sessionGeneration += 1;
    currentSessionId = undefined;
    inboxWatcher?.close();
    inboxWatcher = undefined;

    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = undefined;
    }
  });

  pi.registerCommand("btw", {
    description: "Ask a side question in a new right-hand Herdr pane",
    handler: async (args, ctx) => {
      const question = args.trim();

      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "warning");

        return;
      }

      if (question.includes("\0")) {
        ctx.ui.notify("BTW questions cannot contain null bytes", "error");

        return;
      }

      if (ctx.mode !== "tui" || HERDR_ENV !== "1" || !HERDR_PANE_ID) {
        ctx.ui.notify("/btw requires Pi to be running inside Herdr", "error");

        return;
      }

      const parentSessionPath = ctx.sessionManager.getSessionFile();

      if (!parentSessionPath) {
        ctx.ui.notify("/btw requires a persisted parent session", "error");

        return;
      }

      // The side session runs on the configured model, or on the parent's.
      const model =
        loadConfig(pi).models?.extensions?.btw ??
        (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);

      if (!model) {
        ctx.ui.notify(
          "/btw needs a model: select one, or set models.extensions.btw in ~/.pi/agent/pi-extensions.ts",
          "error",
        );

        return;
      }

      const title = question.replace(/\s+/g, " ").slice(0, 48);

      const env = {
        BTW_PARENT_AGENT_DIR: getAgentDir(),
        BTW_PARENT_PANE_ID: HERDR_PANE_ID,
        BTW_PARENT_SESSION_ID: ctx.sessionManager.getSessionId(),
        BTW_PARENT_SESSION_PATH: parentSessionPath,
        BTW_QUESTION: question,
        BTW_SESSION_NAME: `BTW: ${title}`,
        BTW_SYSTEM_PROMPT: CHILD_SYSTEM_PROMPT,
        BTW_MODEL: model,
        BTW_THINKING: pi.getThinkingLevel(),
      };

      const createArgs = [
        "pane",
        "split",
        "--pane",
        HERDR_PANE_ID,
        "--direction",
        "right",
        "--ratio",
        "0.5",
        "--cwd",
        ctx.cwd,
      ];

      for (const [name, value] of Object.entries(env)) {
        createArgs.push("--env", `${name}=${value}`);
      }

      createArgs.push("--no-focus");

      const created = await pi.exec("herdr", createArgs, { timeout: 5000 });

      if (created.code !== 0) {
        ctx.ui.notify(
          created.stderr.trim() || "Could not create BTW pane",
          "error",
        );

        return;
      }

      let response: PaneSplitResponse;

      try {
        response = JSON.parse(created.stdout) as PaneSplitResponse;
      } catch {
        ctx.ui.notify("Herdr returned an invalid pane-split response", "error");

        return;
      }

      const paneId = response.result?.pane?.pane_id;

      if (!paneId) {
        ctx.ui.notify("Herdr did not return the new BTW pane", "error");

        return;
      }

      const childCommand = [
        "exec pi",
        '--fork "$BTW_PARENT_SESSION_PATH"',
        '--name "$BTW_SESSION_NAME"',
        '--append-system-prompt "$BTW_SYSTEM_PROMPT"',
        '--model "$BTW_MODEL"',
        '--thinking "$BTW_THINKING"',
        '"$BTW_QUESTION"',
      ].join(" ");

      const started = await pi.exec(
        "herdr",
        ["pane", "run", paneId, childCommand],
        {
          timeout: 5000,
        },
      );

      if (started.code !== 0 && !started.killed) {
        await pi.exec("herdr", ["pane", "close", paneId], { timeout: 5000 });
        ctx.ui.notify(
          started.stderr.trim() || "Could not start BTW Pi session",
          "error",
        );
      } else if (started.killed) {
        ctx.ui.notify(
          "BTW pane was created, but Pi startup could not be confirmed",
          "warning",
        );
      }
    },
  });

  pi.registerCommand("merge", {
    description: "Merge this BTW answer into its parent Pi session",
    handler: async (args, ctx) => {
      if (
        !BTW_PARENT_AGENT_DIR ||
        !BTW_PARENT_PANE_ID ||
        !BTW_PARENT_SESSION_ID ||
        !BTW_QUESTION ||
        !childState ||
        childState.childSessionId !== ctx.sessionManager.getSessionId() ||
        childState.parentSessionId !== BTW_PARENT_SESSION_ID
      ) {
        ctx.ui.notify(
          "/merge is only available in a BTW child session",
          "error",
        );

        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the BTW answer to finish before merging",
          "warning",
        );

        return;
      }

      if (merged) {
        ctx.ui.notify("This BTW answer has already been merged", "warning");

        return;
      }

      let answer = args.trim();

      if (!answer) {
        const branch = ctx.sessionManager.getBranch();

        for (let index = branch.length - 1; index >= 0; index -= 1) {
          const entry = branch[index];

          if (entry.type !== "message") {
            continue;
          }

          if (entry.message.role === "user") {
            break;
          }

          if (
            entry.message.role !== "assistant" ||
            entry.message.stopReason !== "stop"
          ) {
            continue;
          }

          answer = entry.message.content
            .filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            )
            .map((part) => part.text)
            .join("\n")
            .trim();

          if (answer) {
            break;
          }
        }
      }

      if (!answer) {
        ctx.ui.notify(
          "No BTW answer found. Use /merge <text> to merge explicit text.",
          "error",
        );

        return;
      }

      const id = randomUUID();
      const createdAt = Date.now();

      const inbox = join(
        BTW_PARENT_AGENT_DIR,
        "btw",
        encodeURIComponent(BTW_PARENT_PANE_ID),
        encodeURIComponent(BTW_PARENT_SESSION_ID),
      );

      const temporaryPath = join(inbox, `.${id}.tmp`);
      const finalPath = join(inbox, `${createdAt}-${id}.json`);

      const payload: MergePayload = {
        id,
        createdAt,
        question: BTW_QUESTION,
        answer,
        sourceSessionPath: ctx.sessionManager.getSessionFile(),
        targetPaneId: BTW_PARENT_PANE_ID,
        targetSessionId: BTW_PARENT_SESSION_ID,
      };

      try {
        await mkdir(inbox, { recursive: true, mode: 0o700 });
        await writeFile(temporaryPath, JSON.stringify(payload), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporaryPath, finalPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not merge BTW answer: ${message}`, "error");

        return;
      }

      merged = true;
      pi.appendEntry("btw-merged", {
        childSessionId: ctx.sessionManager.getSessionId(),
        mergeId: id,
      });
    },
  });
}
