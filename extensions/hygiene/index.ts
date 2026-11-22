import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, type ClefConfig } from "../shared/config.ts";
import { formatReport } from "./format.ts";
import { lint, type LintResult } from "./lint.ts";
import { git, repositoryRoot } from "./source.ts";

const MESSAGE_TYPE = "hygiene";

const HygieneLintSchema = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Files to lint as wholly new, relative to the working directory",
    }),
  ),
  diff: Type.Optional(
    Type.String({
      description: "A unified git diff; only its added lines are linted",
    }),
  ),
  base: Type.Optional(
    Type.String({
      description:
        "Lint the working tree's changes against this git ref, plus untracked files; default HEAD",
    }),
  ),
  clef: Type.Optional(
    Type.Boolean({
      description:
        "Ask Clef about the judgment rules (default true); false runs only the exact local rules",
    }),
  ),
});

interface LintRequest {
  paths?: string[];
  diff?: string;
  base?: string;
  clef?: boolean;
}

async function runLint(
  cwd: string,
  request: LintRequest,
  clef: ClefConfig | undefined,
  signal?: AbortSignal,
): Promise<LintResult> {
  // git prints the real path, which differs from cwd under a symlink such as macOS /tmp.
  const realCwd = realpathSync(cwd);
  const root = await repositoryRoot(realCwd, signal);
  let diffText = request.diff;
  let paths = request.paths?.map((path) =>
    relative(root, resolve(realCwd, path)),
  );

  if (diffText === undefined && paths === undefined) {
    diffText = await git(
      root,
      ["diff", "--no-color", "--no-ext-diff", request.base ?? "HEAD"],
      signal,
    );
    const untracked = await git(
      root,
      ["ls-files", "--others", "--exclude-standard"],
      signal,
    );
    paths = untracked.split("\n").filter(Boolean);
  }

  const wantsClef = request.clef !== false;

  const result = await lint({
    root,
    diffText,
    paths,
    clef: wantsClef ? clef : undefined,
    signal,
  });

  if (wantsClef && !clef) {
    result.notices.push("Clef is not configured, so only the local rules ran.");
  }

  return result;
}

// /hygiene [ref | paths...]: arguments that name existing files are linted whole; otherwise the first is the base ref.
function commandRequest(args: string, cwd: string): LintRequest {
  const words = args.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return {};
  }

  if (words.every((word) => existsSync(resolve(cwd, word)))) {
    return { paths: words };
  }

  return { base: words[0] };
}

export default function hygiene(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "hygiene_lint",
    label: "Hygiene Lint",
    description: [
      "Lint code against the code-restraint and refactoring rules: exact local checks (same-line bodies, deep nesting, swallowed errors, short and ceremony names, magic offsets, duplication, forwarding chains, flat file clusters, dense lines)",
      "plus Clef judgments on parser-built candidates (coined names, speculative knobs, one-use helpers, trivial wrappers, tangled branching, mixed responsibilities, tests that pass either way).",
      "Comments are not judged here: added ones, and unchanged ones next to edited code, are counted and left to the post-change audit's comment-review agent.",
      "Pass paths, a diff, or a base ref; with none it lints the uncommitted changes. Returns diagnostics sorted by file and line, with a fix for each.",
    ].join(" "),
    promptSnippet:
      "Lint changed code against the code-restraint and refactoring rules",
    parameters: HygieneLintSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runLint(
        ctx.cwd,
        params,
        loadConfig(pi).clef,
        signal,
      );

      return {
        content: [{ type: "text" as const, text: formatReport(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("hygiene", {
    description:
      "Lint the uncommitted changes, the changes since a ref, or the given files: /hygiene [ref | paths...]",
    handler: async (args, ctx) => {
      try {
        const result = await runLint(
          ctx.cwd,
          commandRequest(args, ctx.cwd),
          loadConfig(pi).clef,
        );
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: formatReport(result),
          display: true,
          details: result,
        });
      } catch (error) {
        ctx.ui.notify(`Hygiene lint failed: ${String(error)}`, "error");
      }
    },
  });
}
