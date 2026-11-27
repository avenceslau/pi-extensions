import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { runProgram } from "./exec.ts";

// Rex accepts a session's label or ID wherever these functions take `session`. Labels need not be unique, so pass the
// ID when another session could share the label.

const REX_TIMEOUT_MS = 10_000;

const SessionListSchema = Type.Object({
  sessions: Type.Array(
    Type.Object({
      session_id: Type.String(),
      label: Type.Optional(Type.String()),
    }),
  ),
});

const WindowSchema = Type.Object({
  window_id: Type.String(),
});

const WindowListSchema = Type.Object({
  windows: Type.Array(WindowSchema),
});

const CreatedSessionSchema = Type.Object({
  session_id: Type.String(),
  initial_windows: Type.Array(WindowSchema, { minItems: 1 }),
});

export interface CreatedSession {
  sessionId: string;
  windowId: string;
}

async function runRex(args: string[]): Promise<string> {
  return runProgram("rex", args, { timeoutMs: REX_TIMEOUT_MS });
}

async function runRexJson<Schema extends TSchema>(
  args: string[],
  schema: Schema,
): Promise<Static<Schema>> {
  const stdout = await runRex(args);
  let output: unknown;

  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error(`rex ${args[0]} printed invalid JSON`);
  }

  if (!Value.Check(schema, output)) {
    throw new Error(`rex ${args[0]} printed an unexpected response`);
  }

  return output;
}

// Returns the ID of the first session with this label.
export async function findSession(label: string): Promise<string | undefined> {
  const { sessions } = await runRexJson(["ls", "--json"], SessionListSchema);

  return sessions.find((session) => session.label === label)?.session_id;
}

// Creates a session whose first tab runs `command`.
export async function createSession(
  label: string,
  windowLabel: string,
  cwd: string,
  command: string[],
): Promise<CreatedSession> {
  const created = await runRexJson(
    [
      "new",
      label,
      "--window",
      windowLabel,
      "--cwd",
      cwd,
      "--json",
      "--",
      ...command,
    ],
    CreatedSessionSchema,
  );

  return {
    sessionId: created.session_id,
    windowId: created.initial_windows[0].window_id,
  };
}

export async function windowIds(session: string): Promise<Set<string>> {
  const { windows } = await runRexJson(
    ["window", "ls", "-s", session, "--json"],
    WindowListSchema,
  );

  return new Set(windows.map((window) => window.window_id));
}

export async function openTab(
  session: string,
  label: string,
  cwd: string,
  command: string[],
): Promise<string> {
  const created = await runRexJson(
    [
      "window",
      "new",
      "-s",
      session,
      label,
      "--focus=false",
      "--cwd",
      cwd,
      "--json",
      "--",
      ...command,
    ],
    WindowSchema,
  );

  return created.window_id;
}

export async function addPane(
  session: string,
  windowId: string,
  label: string,
  cwd: string,
  command: string[],
): Promise<void> {
  await runRex([
    "run",
    "-s",
    session,
    "-w",
    windowId,
    "--split=right",
    "--focus=false",
    "--label",
    label,
    "--cwd",
    cwd,
    "--",
    ...command,
  ]);
}

export async function closeWindow(
  session: string,
  windowId: string,
): Promise<void> {
  await runRex(["window", "close", "-s", session, windowId]);
}
