import { runProgram } from "./exec.ts";

interface RexWindow {
  window_id: string;
  label: string;
}

async function sessionLabels(): Promise<string[]> {
  // SAFETY: the shape `rex ls --json` prints.
  const { sessions } = JSON.parse(
    await runProgram("rex", ["ls", "--json"]),
  ) as {
    sessions: { label: string }[];
  };

  return sessions.map((session) => session.label);
}

export async function ensureSession(
  session: string,
  logPath: string,
): Promise<void> {
  if ((await sessionLabels()).includes(session)) {
    return;
  }

  await runProgram("rex", [
    "new",
    session,
    "--window",
    "log",
    "--",
    "tail",
    "-n",
    "200",
    "-F",
    logPath,
  ]);
}

export async function windowIds(session: string): Promise<Set<string>> {
  // SAFETY: the shape `rex window ls --json` prints.
  const { windows } = JSON.parse(
    await runProgram("rex", ["window", "ls", "-s", session, "--json"]),
  ) as { windows: RexWindow[] };

  return new Set(windows.map((window) => window.window_id));
}

export async function openTab(
  session: string,
  label: string,
  cwd: string,
  command: string[],
): Promise<string> {
  // SAFETY: the shape `rex window new --json` prints.
  const created = JSON.parse(
    await runProgram("rex", [
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
    ]),
  ) as { window_id: string };

  return created.window_id;
}

export async function addPane(
  session: string,
  windowId: string,
  label: string,
  cwd: string,
  command: string[],
): Promise<void> {
  await runProgram("rex", [
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
  await runProgram("rex", ["window", "close", "-s", session, windowId]);
}
