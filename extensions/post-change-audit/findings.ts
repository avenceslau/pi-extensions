import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// Long enough for a reviewer that wrote its findings as prose, short enough not to flood the main context.
const MAX_REVIEWER_TEXT_CHARS = 4_000;
const MAX_RULE_WORDS = 6;

// Rules the linter and comment-review name themselves, such as refactor/tangled-branching, are kept as they are.
const NAMESPACED_RULE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

const SEVERITIES = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "info",
} as const;

const FindingSchema = Type.Object({
  id: Type.String({ description: "Sequence number of the finding in this report: 1, 2, 3, ..." }),
  severity: StringEnum(["critical", "high", "medium", "low"] as const),
  file: Type.String({ description: "Path relative to the repository root" }),
  line: Type.Number({ description: "Line on the new side of the diff" }),
  column: Type.Optional(Type.Number({ description: "Column where the problem starts, when it is a specific span" })),
  endLine: Type.Optional(Type.Number({ description: "Last line of the problem, when it spans several lines" })),
  rule: Type.String({
    description: "Short name of the rule, RFC, or invariant the code breaks, such as \"one-use helper\" or \"RFC-009 no any\"",
  }),
  claim: Type.String({ description: "One sentence on what is wrong and why it matters" }),
  fix: Type.String({ description: "The smallest concrete fix" }),
  frame: Type.Optional(Type.Number({ description: "Stack frame number the finding belongs to, when the review covers a stack" })),
});

export const FindingsReportSchema = Type.Object({
  clean: Type.Boolean({ description: "True when there are no findings and every simulation you relied on passed" }),
  findings: Type.Array(FindingSchema),
  batches: Type.Optional(Type.Array(Type.String(), { description: "Every test run or simulation URL with its result" })),
  notes: Type.Optional(Type.String({ description: "Anything else the reader needs, such as disproved doubts or worktrees holding new tests" })),
});

export const AuditDecisionSchema = Type.Object({
  id: Type.String({ description: "Diagnostic id from the audit message, such as CR1" }),
  decision: StringEnum(["fixed", "declined"] as const),
  reason: Type.String({ description: "One sentence on what was changed or why the finding is wrong" }),
});

export const LedgerEntrySchema = Type.Object({
  ...AuditDecisionSchema.properties,
  file: Type.String(),
  claim: Type.String(),
});

export const DiagnosticSchema = Type.Object({
  id: Type.String(),
  file: Type.String(),
  line: Type.Number(),
  column: Type.Optional(Type.Number()),
  endLine: Type.Optional(Type.Number()),
  severity: Type.Enum(["error", "warning", "info"]),
  rule: Type.String(),
  message: Type.String(),
  fix: Type.Optional(Type.String()),
  frame: Type.Optional(Type.Number()),
});

export const ReviewerStatusSchema = Type.Object({
  name: Type.String({ description: "Reviewer, as in the rule prefix" }),
  status: Type.Enum(["reported", "no-report", "failed"]),
  clean: Type.Optional(Type.Boolean()),
  batches: Type.Optional(Type.Array(Type.String())),
  notes: Type.Optional(Type.String()),
  text: Type.Optional(Type.String({ description: "Final message or error of a reviewer that did not report" })),
});

export type FindingsReport = Static<typeof FindingsReportSchema>;

export type LedgerEntry = Static<typeof LedgerEntrySchema>;

export type Diagnostic = Static<typeof DiagnosticSchema>;

export type ReviewerStatus = Static<typeof ReviewerStatusSchema>;

type Finding = Static<typeof FindingSchema>;

export interface AuditorOutcome {
  ok: boolean;
  text: string;
  report?: FindingsReport;
}

export interface AuditorResult extends AuditorOutcome {
  // The subagent type, such as code-restraint-review.
  source: string;
  title: string;
  idPrefix: string;
}

function truncate(text: string): string {
  if (text.length <= MAX_REVIEWER_TEXT_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_REVIEWER_TEXT_CHARS)}… (truncated)`;
}

// Also the rule namespace, so a rule id names the reviewer that raised it.
function reviewerName(source: string): string {
  return source.replace(/-(review|enforcer)$/, "");
}

function ruleId(name: string, rule: string): {
  id: string;
  truncated: boolean;
} {
  if (NAMESPACED_RULE.test(rule)) {
    return {
      id: rule,
      truncated: false,
    };
  }

  const words = rule
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (words.join("-").startsWith(`${name}-`)) {
    words.splice(0, name.split("-").length);
  }

  const kept = words.slice(0, MAX_RULE_WORDS);

  return {
    id: `${name}/${kept.join("-") || "unspecified"}`,
    truncated: kept.length < words.length,
  };
}

function toDiagnostic(
  name: string,
  idPrefix: string,
  finding: Finding,
  index: number,
): Diagnostic {
  const rule = ruleId(name, finding.rule);
  // Reviewers asked for 1, 2, 3 sometimes write CR1 themselves, which must not become CRCR1. Each prefix is matched
  // whole, so refactor-review's R does not keep an HR id it wrote and hygiene's HR does not keep a CR one.
  const prefixed = new RegExp(`^${idPrefix}\\d+$`).test(finding.id);

  return {
    id: prefixed ? finding.id : `${idPrefix}${index + 1}`,
    file: finding.file,
    line: finding.line,
    column: finding.column,
    endLine: finding.endLine,
    // StringEnum is typed for pi-schema, so typebox's Static sees the validated severity as unknown.
    severity: SEVERITIES[finding.severity as keyof typeof SEVERITIES],
    rule: rule.id,
    // The rule id cut the reviewer's wording short, so the message keeps it.
    message: rule.truncated ? `${finding.claim} (rule: ${finding.rule})` : finding.claim,
    fix: finding.fix || undefined,
    frame: finding.frame,
  };
}

// Shared by local and pull request audits so both apply the same definition of a finding.
// A reviewer's final message is not its report: pi-subagents keeps only the last assistant message,
// which after a late notification is often a one-line acknowledgement.
export function classifyResults(results: AuditorResult[]): {
  failures?: string;
  hasFindings: boolean;
  diagnostics: Diagnostic[];
  clean: string[];
  reviewers: ReviewerStatus[];
} {
  const failures: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const clean: string[] = [];
  const reviewers: ReviewerStatus[] = [];
  let hasFindings = false;

  for (const { source, title, idPrefix, ok, text, report } of results) {
    const name = reviewerName(source);

    if (!ok) {
      failures.push(`${title} failed (${text})`);
      reviewers.push({
        name,
        status: "failed",
        text: truncate(text),
      });
      continue;
    }

    if (!report) {
      failures.push(`${title} finished without report_findings`);

      // Reviewers without the tool are told to return exactly [] when there are no findings.
      if (text.trim() === "[]") {
        clean.push(name);
        continue;
      }

      // Its final message may hold findings, so it is delivered even without structured ones.
      hasFindings = true;
      reviewers.push({
        name,
        status: "no-report",
        text: truncate(text),
      });
      continue;
    }

    diagnostics.push(...report.findings.map((finding, index) => toDiagnostic(name, idPrefix, finding, index)));
    hasFindings ||=
      report.findings.length > 0 ||
      !report.clean;

    // A reviewer whose diagnostics say everything is not listed again.
    const listed =
      (!report.clean && report.findings.length === 0) ||
      Boolean(report.batches?.length) ||
      Boolean(report.notes);

    if (!listed) {
      if (report.clean) {
        clean.push(name);
      }

      continue;
    }

    reviewers.push({
      name,
      status: "reported",
      clean: report.clean,
      batches: report.batches,
      notes: report.notes,
    });
  }

  diagnostics.sort((a, b) => {
    return (
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      (a.column ?? 0) - (b.column ?? 0)
    );
  });

  return {
    failures: failures.length > 0 ? failures.join("; ") : undefined,
    hasFindings,
    diagnostics,
    // Hygiene reports its code-restraint and refactor rules separately.
    clean: [...new Set(clean)],
    reviewers,
  };
}
