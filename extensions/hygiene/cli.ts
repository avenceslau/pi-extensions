// node --experimental-strip-types extensions/hygiene/cli.ts [--diff file|-] [--root dir] [paths...]
//   [--json] [--check] [--fail-on error|warning|info] [--no-clef]
// Outside pi only ~/.pi/agent/pi-extensions.ts can configure Clef; packages contribute config only inside pi.
import { readFileSync } from "node:fs";
import { readUserConfig } from "../shared/config.ts";
import { formatReport } from "./format.ts";
import { lint, type Severity } from "./lint.ts";
import { repositoryRoot } from "./source.ts";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

const VALUE_FLAGS = new Set(["--diff", "--root", "--fail-on"]);

function parseArgs(args: string[]): { flags: Map<string, string>; paths: string[] } {
  const flags = new Map<string, string>();
  const paths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (VALUE_FLAGS.has(arg)) {
      flags.set(arg, args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--")) {
      flags.set(arg, "");
    } else {
      paths.push(arg);
    }
  }

  return { flags, paths };
}

const { flags, paths } = parseArgs(process.argv.slice(2));
const diffFile = flags.get("--diff");
const failOn = (flags.get("--fail-on") || "warning") as Severity;

if (!(failOn in SEVERITY_RANK)) {
  console.error(`hygiene: --fail-on must be error, warning, or info, not ${failOn}`);
  process.exit(2);
}

if (diffFile === undefined && paths.length === 0) {
  console.error("hygiene: pass --diff <file|-> or the paths to lint");
  process.exit(2);
}

const result = await lint({
  root: flags.get("--root") || (await repositoryRoot(process.cwd())),
  diffText: diffFile === undefined ? undefined : readFileSync(diffFile === "-" ? 0 : diffFile, "utf8"),
  paths,
  clef: flags.has("--no-clef") ? undefined : (await readUserConfig()).clef,
});

if (flags.has("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatReport(result));
}

if (flags.has("--check")) {
  const failing = result.diagnostics.some((diagnostic) => SEVERITY_RANK[diagnostic.severity] >= SEVERITY_RANK[failOn]);
  process.exit(failing ? 1 : 0);
}
