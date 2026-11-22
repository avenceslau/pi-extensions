import { highlightCode, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DiagnosticSchema,
  LedgerEntrySchema,
  ReviewerStatusSchema,
  type Diagnostic,
  type LedgerEntry,
  type ReviewerStatus,
} from "./findings.ts";

export const AUDIT_MESSAGE_TYPE = "post-change-audit";
const MAX_FIX_LINES = 5;
const COLLAPSED_LINES = 15;

const SEVERITY_LETTERS = {
  error: "e",
  warning: "w",
  info: "i",
} as const;

const SEVERITY_COLORS = {
  error: "error",
  warning: "warning",
  info: "muted",
} as const;

const COLUMNS = [
  "id",
  "line",
  "sev",
  "rule",
  "msg",
  "fix",
];

// The message the main agent reads, kept small because it stays in context for every later turn:
// diagnostics are rows under one header, grouped by file, and empty fields are left out.
export const AuditMessageSchema = Type.Object({
  type: Type.Literal(AUDIT_MESSAGE_TYPE),
  round: Type.Optional(Type.Number({ description: "Automatic fix round, starting at 1" })),
  pullRequest: Type.Optional(Type.String()),
  instructions: Type.String(),
  error: Type.Optional(Type.String({ description: "Why the review did not complete" })),
  cols: Type.Optional(Type.Array(Type.String(), { description: "Names of the cells in each row of d" })),
  d: Type.Optional(
    Type.Record(Type.String(), Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()]), { minItems: 5 })), {
      description: "Diagnostic rows by file; line is a number or line:column-endLine, sev is e, w, or i; trailing unset cells are left out",
    }),
  ),
  clean: Type.Optional(Type.Array(Type.String(), { description: "Reviewers that reported no findings" })),
  reviewers: Type.Optional(Type.Array(ReviewerStatusSchema, { description: "Reviewers with more to say than their diagnostics" })),
  settledDecisions: Type.Optional(Type.Array(Type.Omit(LedgerEntrySchema, ["id"]))),
});

// Only renderers see details.
const AuditDetailsSchema = Type.Object({
  // Sorted as in the message, with fixes in full.
  diagnostics: Type.Array(DiagnosticSchema),
  diffs: Type.Array(Type.String()),
});

export type AuditMessage = Static<typeof AuditMessageSchema>;

type AuditDetails = Static<typeof AuditDetailsSchema>;

export interface AuditMessageInput {
  round?: number;
  pullRequest?: string;
  instructions: string;
  error?: string;
  diffs?: string[];
  diagnostics?: Diagnostic[];
  clean?: string[];
  reviewers?: ReviewerStatus[];
  settledDecisions?: Omit<LedgerEntry, "id">[];
}

function nonEmpty<T>(items: T[] | undefined): T[] | undefined {
  return items?.length ? items : undefined;
}

function lineCell({ line, column, endLine }: Diagnostic): number | string {
  if (
    column === undefined &&
    endLine === undefined
  ) {
    return line;
  }

  return `${line}${column === undefined ? "" : `:${column}`}${endLine === undefined ? "" : `-${endLine}`}`;
}

function trimFix(fix: string): string {
  const lines = fix.split("\n");

  if (lines.length <= MAX_FIX_LINES) {
    return fix;
  }

  return [...lines.slice(0, MAX_FIX_LINES), `… ${lines.length - MAX_FIX_LINES} more lines`].join("\n");
}

export function serializeAuditMessage(input: AuditMessageInput): {
  content: string;
  details: AuditDetails;
} {
  const diagnostics = input.diagnostics ?? [];
  const inStack = diagnostics.some((diagnostic) => diagnostic.frame !== undefined);
  const rows: Record<string, (string | number)[][]> = {};

  for (const diagnostic of diagnostics) {
    const cells = [
      diagnostic.id,
      lineCell(diagnostic),
      SEVERITY_LETTERS[diagnostic.severity],
      diagnostic.rule,
      diagnostic.message,
      trimFix(diagnostic.fix ?? ""),
      ...(inStack ? [diagnostic.frame ?? ""] : []),
    ];

    // Unset trailing cells are dropped; every cell before fix is always set.
    while (
      cells.length > COLUMNS.length - 1 &&
      cells.at(-1) === ""
    ) {
      cells.pop();
    }

    (rows[diagnostic.file] ??= []).push(cells);
  }

  const columns = inStack ? [...COLUMNS, "frame"] : COLUMNS;

  const message: AuditMessage = {
    type: AUDIT_MESSAGE_TYPE,
    round: input.round,
    pullRequest: input.pullRequest,
    instructions: input.instructions,
    error: input.error,
    cols: diagnostics.length === 0 ? undefined : columns,
    d: diagnostics.length === 0 ? undefined : rows,
    clean: nonEmpty(input.clean),
    reviewers: nonEmpty(input.reviewers),
    settledDecisions: nonEmpty(input.settledDecisions),
  };

  return {
    content: JSON.stringify(message),
    details: {
      diagnostics,
      diffs: input.diffs ?? [],
    },
  };
}

function parseAuditMessage(content: unknown): AuditMessage | undefined {
  if (typeof content !== "string") {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(content);

    return Value.Check(AuditMessageSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function location(diagnostic: Diagnostic): string {
  const column = diagnostic.column === undefined ? "" : `:${diagnostic.column}`;
  const frame = diagnostic.frame === undefined ? "" : ` (frame ${diagnostic.frame})`;

  return `${diagnostic.file}:${diagnostic.line}${column}${frame}`;
}

function diagnosticLines(
  diagnostics: Diagnostic[],
  expanded: boolean,
  theme: Theme,
): string[] {
  const width = Math.max(...diagnostics.map((diagnostic) => location(diagnostic).length));
  const lines: string[] = [];
  diagnostics.forEach((diagnostic, i) => {
    if (
      i > 0 &&
      diagnostics[i - 1]?.file !== diagnostic.file
    ) {
      lines.push("");
    }

    const severity = theme.fg(SEVERITY_COLORS[diagnostic.severity], diagnostic.severity.padEnd(7));
    lines.push(
      `${location(diagnostic).padEnd(width)}  ${severity}  ${diagnostic.message}  ${theme.fg("dim", `${diagnostic.rule} ${diagnostic.id}`)}`,
    );

    if (!diagnostic.fix) {
      return;
    }

    // Collapsed, the fix is cut as the model saw it.
    const fix = expanded ? diagnostic.fix : trimFix(diagnostic.fix);

    for (const fixLine of fix.split("\n")) {
      lines.push(theme.fg("dim", `    ${fixLine}`));
    }
  });

  return lines;
}

function reviewerLines(reviewer: ReviewerStatus, theme: Theme): string[] {
  const status = reviewer.status === "reported" && !reviewer.clean
    ? "not clean"
    : reviewer.status;

  const details = [
    ...(reviewer.text?.split("\n") ?? []),
    ...(reviewer.batches?.map((batch) => `batch: ${batch}`) ?? []),
    ...(reviewer.notes ? `notes: ${reviewer.notes}`.split("\n") : []),
  ];

  return [
    `${theme.bold(reviewer.name)} ${theme.fg("dim", status)}`,
    ...details.map((line) => theme.fg("dim", `  ${line}`)),
  ];
}

function summaryLine(
  audit: AuditMessage,
  diagnostics: Diagnostic[],
  theme: Theme,
): string {
  if (audit.error) {
    return theme.fg("error", `✖ did not complete: ${audit.error}`);
  }

  const unreported = audit.reviewers?.filter((reviewer) => reviewer.status !== "reported").length ?? 0;
  const suffix = unreported === 0 ? "" : `, ${unreported} reviewer${unreported === 1 ? "" : "s"} without a report`;

  if (diagnostics.length === 0) {
    return unreported === 0
      ? theme.fg("success", "✔ no problems")
      : theme.fg("warning", `⚠ no structured problems${suffix}`);
  }

  const counts = (["error", "warning", "info"] as const).flatMap((severity) => {
    const count = diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;

    if (count === 0) {
      return [];
    }

    return [`${count} ${severity}${count === 1 || severity === "info" ? "" : "s"}`];
  });

  const color = diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "warning";
  const total = diagnostics.length;

  return theme.fg(color, `✖ ${total} problem${total === 1 ? "" : "s"} (${counts.join(", ")})${suffix}`);
}

function messageTitle(audit: AuditMessage): string {
  if (audit.pullRequest) {
    return `Review of ${audit.pullRequest}`;
  }

  if (audit.round === undefined) {
    return "Post-change audit";
  }

  return `Post-change audit, round ${audit.round}`;
}

// Returning undefined falls back to pi's default rendering of the raw content, which older sessions need.
export const renderAuditMessage: MessageRenderer = (message, options, theme) => {
  const audit = parseAuditMessage(message.content);

  if (
    !audit ||
    !Value.Check(AuditDetailsSchema, message.details)
  ) {
    return undefined;
  }

  const { diagnostics, diffs } = message.details;
  const body = diagnosticLines(diagnostics, options.expanded, theme);

  if (audit.clean?.length) {
    body.push(theme.fg("dim", `clean: ${audit.clean.join(", ")}`));
  }

  body.push(...(audit.reviewers ?? []).flatMap((reviewer) => reviewerLines(reviewer, theme)));

  const lines = [theme.fg("customMessageLabel", theme.bold(messageTitle(audit)))];

  if (options.expanded) {
    lines.push(
      ...body,
      "",
      summaryLine(audit, diagnostics, theme),
      ...diffs.map((diff) => theme.fg("dim", diff)),
      "",
      ...highlightCode(JSON.stringify(audit, null, 2), "json"),
    );
  } else {
    const hidden = body.length - COLLAPSED_LINES;

    const hint = hidden > 0
      ? `${theme.fg("dim", `… ${hidden} more lines, `)}${options.keyHint("app.tools.expand", "to expand")}`
      : options.keyHint("app.tools.expand", "to show the JSON");

    lines.push(...body.slice(0, COLLAPSED_LINES), hint, "", summaryLine(audit, diagnostics, theme));
  }

  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(lines.join("\n"), 0, 0));

  return box;
};
