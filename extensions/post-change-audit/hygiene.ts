import { lint, type HygieneDiagnostic, type LintResult } from "../hygiene/lint.ts";
import type { ClefConfig } from "../shared/config.ts";
import type { ReviewedComment } from "./comment-review.ts";
import type { AuditorResult, FindingsReport } from "./findings.ts";
import { git, LITERAL_PATHSPECS } from "./git.ts";
import type { RepoChange } from "./tracking.ts";

const FINDING_SEVERITIES = {
  error: "high",
  warning: "medium",
  info: "low",
} as const;

const REFACTOR_RULE = /^refactor\//;

// A reviewer finding whose rule names one of these families repeats a hygiene finding of the family on the same lines.
const REPEAT_FAMILIES = [
  {
    reviewerRule: /nest|tangl|cognitive|complex|responsibilit|long (?:function|method)/i,
    hygieneRules: new Set([
      "refactor/tangled-branching",
      "refactor/mixed-responsibilities",
      "code-restraint/deep-nesting",
    ]),
  },
  {
    reviewerRule: /duplicat|repeated|copied|copy-paste/i,
    hygieneRules: new Set(["refactor/duplication"]),
  },
];

const COMMENT_FAMILY = /comment/i;

export interface HygieneAudit {
  // Code-restraint rules as CR1, CR2, ..., and refactor rules as HR1, HR2, ...
  results: AuditorResult[];
  diagnostics: HygieneDiagnostic[];
  // For comment-review, which judges every comment hygiene found.
  comments: ReviewedComment[];
  // False when a Clef call failed (or the linter did), so some judgment rules did not run.
  clefReachable: boolean;
}

interface Span {
  file: string;
  line: number;
  endLine: number;
}

// Fix rounds are linted on the hunks since the previous audit only, the hunks the reviewers are told to report on.
async function lintChange(change: RepoChange, clef: ClefConfig | undefined, signal: AbortSignal): Promise<LintResult> {
  const from = change.previous ?? change.base;
  const pathspec = change.paths.length > 0 ? ["--", ...change.paths] : [];

  const diffText = await git(
    change.root,
    ["diff", "--no-color", "--no-ext-diff", from, change.current, ...pathspec],
    {
      env: LITERAL_PATHSPECS,
      signal,
    },
  );

  return lint({
    root: change.root,
    ref: change.current,
    diffText,
    clef,
    formatted: change.formatters.length > 0,
    signal,
  });
}

function toReport(diagnostics: HygieneDiagnostic[], notices: string[]): FindingsReport {
  const findings = diagnostics.map((diagnostic, index) => {
    const judged = diagnostic.probability === undefined ? "" : ` (Clef ${diagnostic.probability.toFixed(2)})`;

    return {
      id: String(index + 1),
      severity: FINDING_SEVERITIES[diagnostic.severity],
      file: diagnostic.file,
      line: diagnostic.line,
      column: diagnostic.column,
      endLine: diagnostic.endLine,
      rule: diagnostic.rule,
      claim: `${diagnostic.message}${judged}`,
      fix: diagnostic.fix,
    };
  });

  return {
    clean: findings.length === 0,
    findings,
    notes: notices.length > 0 ? [...new Set(notices)].join(" ") : undefined,
  };
}

function hygieneResult(idPrefix: string, diagnostics: HygieneDiagnostic[], notices: string[]): AuditorResult {
  return {
    source: "hygiene",
    title: "Hygiene",
    idPrefix,
    ok: true,
    text: `${diagnostics.length} hygiene diagnostics`,
    report: toReport(diagnostics, notices),
  };
}

export async function hygieneAudit(
  changes: RepoChange[],
  clef: ClefConfig | undefined,
  signal: AbortSignal,
): Promise<HygieneAudit> {
  let results: LintResult[];

  try {
    results = await Promise.all(changes.map((change) => lintChange(change, clef, signal)));
  } catch (error) {
    return {
      results: [
        {
          source: "hygiene",
          title: "Hygiene",
          idPrefix: "CR",
          ok: false,
          text: String(error),
        },
      ],
      diagnostics: [],
      comments: [],
      clefReachable: false,
    };
  }

  const diagnostics = results.flatMap((result) => result.diagnostics);

  return {
    results: [
      hygieneResult(
        "CR",
        diagnostics.filter((diagnostic) => !REFACTOR_RULE.test(diagnostic.rule)),
        results.flatMap((result) => result.notices),
      ),
      hygieneResult(
        "HR",
        diagnostics.filter((diagnostic) => REFACTOR_RULE.test(diagnostic.rule)),
        [],
      ),
    ],
    diagnostics,
    comments: results.flatMap((result, index) => {
      return result.comments.map((comment) => ({ ...comment, root: changes[index].root }));
    }),
    clefReachable: results.every((result) => result.clef === "ok"),
  };
}

function lineList(spans: { line: number; endLine: number; rule?: string }[]): string {
  return spans
    .map((span) => {
      const lines = span.endLine > span.line ? `${span.line}-${span.endLine}` : `${span.line}`;

      return span.rule ? `${lines} ${span.rule}` : lines;
    })
    .join(", ");
}

function byFile<Entry extends { file: string }>(entries: Entry[]): Map<string, Entry[]> {
  const files = new Map<string, Entry[]>();

  for (const entry of entries) {
    files.set(entry.file, [...(files.get(entry.file) ?? []), entry]);
  }

  return files;
}

// Told to refactor-review so it neither repeats the linter's findings nor reviews comments.
export function reportedSection(hygiene: HygieneAudit): string {
  const diagnostics = byFile(
    hygiene.diagnostics.map((diagnostic) => ({
      file: diagnostic.file,
      line: diagnostic.line,
      endLine: diagnostic.endLine ?? diagnostic.line,
      rule: diagnostic.rule,
    })),
  );

  const comments = byFile(hygiene.comments.map((comment) => ({ ...comment, file: comment.path })));
  const lines = ["Do not review comments at all: comment-review judges every comment this change added or left next to edited code."];

  if (diagnostics.size > 0) {
    lines.push(
      "Already reported by the hygiene linter; do not repeat these, or report the same problem on the same lines:",
      ...[...diagnostics].map(([file, spans]) => `- ${file}: ${lineList(spans)}`),
    );
  }

  if (comments.size > 0) {
    lines.push(
      "Comments already sent to comment-review:",
      ...[...comments].map(([file, spans]) => `- ${file}: ${lineList(spans)}`),
    );
  }

  return lines.join("\n");
}

function overlaps(span: Span, other: Span): boolean {
  return span.file === other.file && span.line <= other.endLine && other.line <= span.endLine;
}

function repeatedSpans(rule: string, hygiene: HygieneAudit): Span[] {
  if (COMMENT_FAMILY.test(rule)) {
    return hygiene.comments.map((comment) => ({ ...comment, file: comment.path }));
  }

  const family = REPEAT_FAMILIES.find((entry) => entry.reviewerRule.test(rule));

  return hygiene.diagnostics
    .filter((diagnostic) => family?.hygieneRules.has(diagnostic.rule))
    .map((diagnostic) => ({ ...diagnostic, endLine: diagnostic.endLine ?? diagnostic.line }));
}

// Drops refactor-review findings about complexity, duplication or comments on lines where hygiene already reported the same family.
export function withoutRepeats(result: AuditorResult, hygiene: HygieneAudit): AuditorResult {
  if (!result.report) {
    return result;
  }

  const dropped: string[] = [];

  const findings = result.report.findings.filter((finding) => {
    const span = {
      file: finding.file,
      line: finding.line,
      endLine: finding.endLine ?? finding.line,
    };

    const repeated = repeatedSpans(finding.rule, hygiene).some((other) => overlaps(span, other));

    if (repeated) {
      dropped.push(`${finding.file}:${finding.line} ${finding.rule}`);
    }

    return !repeated;
  });

  if (dropped.length === 0) {
    return result;
  }

  const note = `Dropped ${dropped.length} findings that repeat hygiene's: ${dropped.join("; ")}.`;

  return {
    ...result,
    report: {
      ...result.report,
      findings,
      notes: [result.report.notes, note].filter(Boolean).join(" "),
    },
  };
}
