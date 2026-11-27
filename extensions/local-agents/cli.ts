// node --experimental-strip-types extensions/local-agents/cli.ts <command> <agent> [--config file]...
//   tick [--dry-run] [--check name]...  run the due checks, or only the named ones, and start runs for new triggers
//   install                             run `tick` every five minutes with launchd
//   uninstall                           remove the launchd job
// Config files are merged in order, then ~/.pi/agent/pi-extensions.ts on top. Outside pi, packages cannot
// contribute config through the event bus, so pass their config modules with --config.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiExtensionsConfig } from "../shared/config-types.ts";
import { mergeConfig, readUserConfig } from "../shared/config.ts";
import type { LocalAgentDefinition } from "./definition.ts";
import { install, uninstall } from "./launchd.ts";
import { tick } from "./tick.ts";

const USAGE_ERROR_EXIT_CODE = 2;

const AGENTS: Record<string, () => Promise<LocalAgentDefinition>> = {
  todai: async () => (await import("./todai/index.ts")).default,
};

function flagValues(args: string[], flagName: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flagName && args[index + 1] ? [args[index + 1]] : [],
  );
}

async function loadConfig(configPaths: string[]): Promise<PiExtensionsConfig> {
  const configs = await Promise.all(
    configPaths.map((path) => readUserConfig(resolve(path))),
  );

  return [...configs, await readUserConfig()].reduce(mergeConfig, {});
}

const [command, agent, ...rest] = process.argv.slice(2);
const loadDefinition = AGENTS[agent ?? ""];

if (!command || !loadDefinition) {
  console.error(
    `usage: cli.ts tick|install|uninstall <${Object.keys(AGENTS).join("|")}> [--config file]... [--dry-run] [--check name]...`,
  );
  process.exit(USAGE_ERROR_EXIT_CODE);
}

const configPaths = flagValues(rest, "--config").map((path) => resolve(path));

if (command === "tick") {
  await tick(await loadDefinition(), await loadConfig(configPaths), {
    dryRun: rest.includes("--dry-run"),
    onlyChecks: flagValues(rest, "--check"),
  });
} else if (command === "install") {
  const path = await install(agent, [
    process.execPath,
    "--experimental-strip-types",
    fileURLToPath(import.meta.url),
    "tick",
    agent,
    ...configPaths.flatMap((path) => ["--config", path]),
  ]);

  console.log(`Installed ${path}`);
} else if (command === "uninstall") {
  await uninstall(agent);
  console.log(`Uninstalled ${agent}`);
} else {
  console.error(`unknown command ${command}`);
  process.exit(USAGE_ERROR_EXIT_CODE);
}
