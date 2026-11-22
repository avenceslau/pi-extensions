import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type StatusState = "working" | "blocked" | "done" | "error" | "clear";

type BlockedKind = "permission" | "question";

const TITLE = Buffer.from("Pi", "utf8").toString("base64");

function statusSequence(
  state: StatusState,
  message?: string,
  kind?: BlockedKind,
): string {
  const fields = [`state=${state}`, "id=pi"];

  if (state !== "clear") {
    fields.push("app=pi", `title=${TITLE}`);
  }

  if (kind) {
    fields.push(`kind=${kind}`);
  }

  if (message) {
    fields.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
  }

  return `\u001b]7501;${fields.join(":")}\u001b\\`;
}

export default function (pi: ExtensionAPI) {
  if (!process.env.REX_SESSION || !process.env.REX_BLOCK) {
    return;
  }

  let started = false;
  let active = false;
  let blocked = false;
  let lastStopReason: string | undefined;
  let lastSequence: string | undefined;

  function publish(
    state: StatusState,
    message?: string,
    kind?: BlockedKind,
  ): void {
    const sequence = statusSequence(state, message, kind);

    if (sequence === lastSequence) {
      return;
    }

    lastSequence = sequence;
    process.stdout.write(sequence);
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }

    started = true;
    blocked = false;
    lastStopReason = undefined;
    lastSequence = undefined;
    active = ctx.isIdle() === false;

    if (active) {
      publish("working", "Pi is working");
    } else {
      publish("clear");
    }
  });

  pi.on("agent_start", () => {
    if (!started) {
      return;
    }

    active = true;
    blocked = false;
    lastStopReason = undefined;
    publish("working", "Pi is working");
  });

  pi.on("message_end", (event) => {
    if (!started || event.message.role !== "assistant") {
      return;
    }

    lastStopReason = event.message.stopReason;
  });

  pi.on("ui_prompt_start", (event) => {
    if (!started || !active) {
      return;
    }

    blocked = true;

    if (event.kind === "confirm") {
      publish("blocked", "Pi needs confirmation", "permission");
    } else {
      publish("blocked", "Pi needs input", "question");
    }
  });

  pi.on("ui_prompt_end", () => {
    if (!started || !blocked) {
      return;
    }

    blocked = false;

    if (active) {
      publish("working", "Pi is working");
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!started || ctx.isIdle() !== true) {
      return;
    }

    active = false;
    blocked = false;

    if (lastStopReason === "error") {
      publish("error", "Pi stopped with an error");
    } else if (lastStopReason === "aborted") {
      publish("clear");
    } else {
      publish("done", "Pi finished");
    }
  });

  pi.on("session_shutdown", () => {
    started = false;
    active = false;
    blocked = false;
  });
}
