import type { HygieneDiagnostic, LintResult } from "./lint.ts";

function location(diagnostic: HygieneDiagnostic): string {
  const column = diagnostic.column ? `:${diagnostic.column}` : "";
  const end = diagnostic.endLine ? `-${diagnostic.endLine}` : "";

  return `${diagnostic.file}:${diagnostic.line}${column}${end}`;
}

export function formatReport(result: LintResult): string {
  const lines: string[] = [];

  for (const diagnostic of result.diagnostics) {
    const probability =
      diagnostic.probability === undefined
        ? ""
        : ` (${diagnostic.probability})`;
    lines.push(
      `${location(diagnostic)} ${diagnostic.severity} ${diagnostic.rule}${probability}: ${diagnostic.message}`,
      `  fix: ${diagnostic.fix}`,
    );
  }

  if (result.diagnostics.length === 0) {
    lines.push("No hygiene diagnostics.");
  }

  const stale = result.comments.filter(
    (comment) => comment.change === "stale",
  ).length;

  if (result.comments.length > 0) {
    lines.push(
      `Comments: ${result.comments.length - stale} added and ${stale} unchanged next to edited code are left to the post-change audit's comment-review agent.`,
    );
  }

  const scores = Object.entries(result.scores)
    .map(([category, score]) => `${category} ${score}`)
    .join(", ");

  const { stats } = result;
  lines.push(
    `Scores: ${scores}`,
    `Checked ${stats.files} files, ${stats.addedLines} added lines; Clef ${result.clef}, ${stats.clefCalls} calls, ${stats.cacheHits} of ${stats.questions} answers cached.`,
    ...result.notices.map((notice) => `Note: ${notice}`),
  );

  return lines.join("\n");
}
