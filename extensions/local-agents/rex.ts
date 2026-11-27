import { run } from "./exec.ts";

interface RexWindow {
  window_id: string;
  label: string;
}

async function sessionLabels(): Promise<string[]> {
  const { sessions } = JSON.parse(await run("rex", ["ls", "--json"])) as {
    sessions: { label: string }[];
  };

  return sessions.map((session) => session.label);
}

// The session's first window follows the agent's log, so the session shows what the checks are doing.
export async function ensureSession(
  session: string,
  logPath: string,
): Promise<void> {
  if ((await sessionLabels()).includes(session)) {
    return;
  }

  await run("rex", [
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
  const { windows } = JSON.parse(
    await run("rex", ["window", "ls", "-s", session, "--json"]),
  ) as { windows: RexWindow[] };

  return new Set(windows.map((window) => window.window_id));
}

export async function openTab(
  session: string,
  label: string,
  cwd: string,
  command: string[],
): Promise<string> {
  const created = JSON.parse(
    await run("rex", [
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
  await run("rex", [
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
  await run("rex", ["window", "close", "-s", session, windowId]);
}
