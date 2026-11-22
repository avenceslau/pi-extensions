import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rexAgentStatus from "./index.ts";

type Handler = (event: unknown, context: unknown) => unknown;

test("reports the Pi lifecycle through Rex program status", async () => {
  const previousSession = process.env.REX_SESSION;
  const previousBlock = process.env.REX_BLOCK;
  const previousWrite = process.stdout.write;
  const handlers = new Map<string, Handler[]>();
  let output = "";

  process.env.REX_SESSION = "session:test";
  process.env.REX_BLOCK = "block:test";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();

    return true;
  }) as typeof process.stdout.write;

  try {
    const pi = {} as ExtensionAPI;
    pi.on = ((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }) as typeof pi.on;
    rexAgentStatus(pi);

    const emit = async (
      name: string,
      event: unknown = {},
      context: unknown = {},
    ) => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, context);
      }
    };

    const idleContext = { mode: "tui", isIdle: () => true };

    await emit("session_start", {}, idleContext);
    assert.match(output, /state=clear:id=pi/);

    output = "";
    await emit("agent_start");
    assert.match(output, /state=working:id=pi:app=pi/);

    output = "";
    await emit("ui_prompt_start", { kind: "confirm" });
    assert.match(output, /state=blocked:id=pi:app=pi/);
    assert.match(output, /kind=permission/);

    output = "";
    await emit("ui_prompt_end");
    assert.match(output, /state=working:id=pi:app=pi/);

    output = "";
    await emit("message_end", {
      message: { role: "assistant", stopReason: "stop" },
    });
    await emit("agent_settled", {}, idleContext);
    assert.match(output, /state=done:id=pi:app=pi/);

    output = "";
    await emit("agent_start");
    await emit("message_end", {
      message: { role: "assistant", stopReason: "error" },
    });
    await emit("agent_settled", {}, idleContext);
    assert.match(output, /state=error:id=pi:app=pi/);

    output = "";
    await emit("agent_start");
    await emit("message_end", {
      message: { role: "assistant", stopReason: "aborted" },
    });
    await emit("agent_settled", {}, idleContext);
    assert.match(output, /state=clear:id=pi/);
  } finally {
    process.stdout.write = previousWrite;

    if (previousSession === undefined) {
      delete process.env.REX_SESSION;
    } else {
      process.env.REX_SESSION = previousSession;
    }

    if (previousBlock === undefined) {
      delete process.env.REX_BLOCK;
    } else {
      process.env.REX_BLOCK = previousBlock;
    }
  }
});
