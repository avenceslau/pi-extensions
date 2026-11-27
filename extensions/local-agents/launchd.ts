import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProgram } from "../shared/exec.ts";
import { agentDirectory } from "./state.ts";

const TICK_SECONDS = 300;

function label(agent: string): string {
  return `pi.local-agents.${agent}`;
}

function plistPath(agent: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label(agent)}.plist`);
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plist(agent: string, programArguments: string[]): string {
  const log = join(agentDirectory(agent), "tick.log");

  const strings = (texts: string[]) =>
    texts.map((text) => `    <string>${escapeXml(text)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label(agent)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(programArguments)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(process.env.PATH ?? "")}</string>
    <key>HOME</key>
    <string>${escapeXml(homedir())}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${TICK_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

// The job runs `tick` with the PATH of the shell that installed it, so it finds the same pi, rex, shirei, git, gh,
// and glab.
export async function install(
  agent: string,
  programArguments: string[],
): Promise<string> {
  const path = plistPath(agent);

  mkdirSync(agentDirectory(agent), { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  // bootout fails when the job is not loaded yet, which is the state install wants.
  await runProgram("launchctl", ["bootout", domain(), path]).catch(
    () => undefined,
  );
  writeFileSync(path, plist(agent, programArguments));
  await runProgram("launchctl", ["bootstrap", domain(), path]);

  return path;
}

export async function uninstall(agent: string): Promise<void> {
  const path = plistPath(agent);

  // bootout fails when the job is not loaded, which is the state uninstall wants.
  await runProgram("launchctl", ["bootout", domain(), path]).catch(
    () => undefined,
  );
  rmSync(path, { force: true });
}
