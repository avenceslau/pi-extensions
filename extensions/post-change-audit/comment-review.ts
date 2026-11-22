import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { openVerdictCache } from "../hygiene/cache.ts";
import type { CommentCandidate } from "../hygiene/comments.ts";
import commentTrait from "../hygiene/traits/code-restraint/comment.ts";
import type { AuditorResult, FindingsReport } from "./findings.ts";

// Part of every cached verdict's key: bump it when the prompt changes, so comments are judged again.
const PROMPT_VERSION = 1;
const MAX_AGENTS = 3;
const MAX_COMMENTS_PER_AGENT = 50;
const MAX_LINE_CHARS = 300;
const LINE_NUMBER_WIDTH = 5;
const DELETE_FIX = "Delete the comment.";
const MAX_LISTED_LOCATIONS = 10;

const VerdictSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal("delete"),
    Type.Literal("replace"),
    Type.Literal("keep"),
  ]),
  reason: Type.String(),
  change: Type.Optional(Type.String()),
});

type Verdict = Static<typeof VerdictSchema>;

export interface ReviewedComment extends CommentCandidate {
  root: string;
}

interface Judged {
  comment: ReviewedComment;
  verdict: Verdict;
}

export interface CommentAuditor {
  type: string;
  title: string;
  idPrefix: string;
  focus: string;
}

function verdictKey(comment: ReviewedComment): string {
  return createHash("sha256")
    .update(JSON.stringify([PROMPT_VERSION, comment.change, comment.text, comment.contextLines.join("\n")]))
    .digest("hex");
}

function byLocation(a: ReviewedComment, b: ReviewedComment): number {
  return a.root.localeCompare(b.root) || a.path.localeCompare(b.path) || a.line - b.line;
}

// Added comments come first when there are more than the agents take; each file stays in one batch where the sizes allow.
function batches(comments: ReviewedComment[]): {
  batches: ReviewedComment[][];
  skipped: ReviewedComment[];
} {
  const prioritized = [
    ...comments.filter((comment) => comment.change === "added"),
    ...comments.filter((comment) => comment.change === "stale"),
  ];

  const capacity = MAX_AGENTS * MAX_COMMENTS_PER_AGENT;
  const selected = prioritized.slice(0, capacity).sort(byLocation);
  const agents = Math.ceil(selected.length / MAX_COMMENTS_PER_AGENT);
  const target = Math.ceil(selected.length / agents);

  const grouped: ReviewedComment[][] = [[]];
  let previousFile = "";

  for (const comment of selected) {
    const file = `${comment.root}\n${comment.path}`;
    const full = grouped[grouped.length - 1].length >= target;

    if (
      file !== previousFile &&
      full &&
      grouped.length < agents
    ) {
      grouped.push([]);
    }

    grouped[grouped.length - 1].push(comment);
    previousFile = file;
  }

  return {
    batches: grouped.filter((batch) => batch.length > 0),
    skipped: prioritized.slice(capacity),
  };
}

interface Numbered {
  comment: ReviewedComment;
  id: string;
}

function contextEnd(comment: ReviewedComment): number {
  return comment.contextStart + comment.contextLines.length - 1;
}

// Comments in one file whose surrounding code overlaps share one excerpt.
function excerptGroups(batch: Numbered[]): Numbered[][] {
  const groups: Numbered[][] = [];
  let end = 0;

  for (const entry of batch) {
    const group = groups[groups.length - 1];
    const previous = group?.[0].comment;
    const sameFile = previous?.root === entry.comment.root && previous.path === entry.comment.path;

    if (group && sameFile && entry.comment.contextStart <= end + 1) {
      group.push(entry);
      end = Math.max(end, contextEnd(entry.comment));
      continue;
    }

    groups.push([entry]);
    end = contextEnd(entry.comment);
  }

  return groups;
}

function describe({ comment, id }: Numbered): string {
  const range = comment.endLine > comment.line ? `lines ${comment.line}-${comment.endLine}` : `line ${comment.line}`;

  const stale = comment.change === "stale"
    ? ` (this change edited lines ${comment.editedLines} and left the comment as it was)`
    : "";

  return `${id} ${comment.change} on ${range}${stale}`;
}

function excerptSection(group: Numbered[]): string {
  const texts = new Map<number, string>();

  for (const { comment } of group) {
    comment.contextLines.forEach((text, index) => texts.set(comment.contextStart + index, text));
  }

  const markerWidth = Math.max(...group.map(({ id }) => id.length));

  const rows = [...texts.keys()]
    .sort((a, b) => a - b)
    .map((line) => {
      const marker = group.find(({ comment }) => line >= comment.line && line <= comment.endLine)?.id ?? "";
      const text = (texts.get(line) ?? "").slice(0, MAX_LINE_CHARS);

      return `${marker.padStart(markerWidth)} ${String(line).padStart(LINE_NUMBER_WIDTH)}| ${text}`;
    });

  return [`${group[0].comment.path}: ${group.map(describe).join("; ")}`, ...rows].join("\n");
}

function reviewPrompt(
  auditor: CommentAuditor,
  intro: string,
  batch: Numbered[],
): string {
  const roots = [...new Set(batch.map(({ comment }) => comment.root))];

  const sections = roots.map((root) => {
    const comments = batch.filter(({ comment }) => comment.root === root);

    return [`Repository: ${root}`, ...excerptGroups(comments).map(excerptSection)].join("\n\n");
  });

  return [
    auditor.focus,
    intro,
    `Rule ${commentTrait.name}: ${commentTrait.requirement}\n${commentTrait.body}`,
    [
      "Give every comment one verdict:",
      "- delete: it says nothing a reader cannot get from the code, or it no longer matches the code.",
      `- replace: a concrete code change would make it unnecessary. Name the exact change, such as "rename \`finish\` to \`releaseLeaseAndNotify\`", "extract lines 12-18 into \`parseHeader\`", "assert \`count > 0\` before the loop", or "add a test that the retry stops after five attempts". The rule's fix: ${commentTrait.fix}`,
      "- keep: only with a reason the code cannot express: an external constraint, a linked bug or ticket, a specification or protocol detail, or the reason for a counterintuitive choice. Being a doc comment, a `SAFETY:` note or a TODO is not a reason.",
      "A stale comment was left as it was by a change that edited the code around it; if it no longer describes that code exactly, delete or replace it.",
    ].join("\n"),
    [
      "Call report_findings exactly once with one finding per comment: id is the comment's id (M1, M2, ...), rule is the verdict (delete, replace or keep), claim is one sentence on why (for keep, what the code cannot express), fix is the change for replace, \"Delete the comment.\" for delete and \"Keep.\" for keep, severity is medium, and file and line are the comment's. Set clean to false. Only that report is read.",
      "Each comment is shown with the code around it, its own lines marked with its id; comments close together share one excerpt. Read a file only when you need more of it.",
    ].join(" "),
    ...sections,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function verdictsFromReport(report: FindingsReport, ids: Set<string>): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();

  for (const finding of report.findings) {
    const verdict = {
      verdict: finding.rule.trim().toLowerCase(),
      reason: finding.claim,
      change: finding.fix || undefined,
    };

    if (ids.has(finding.id) && Value.Check(VerdictSchema, verdict)) {
      verdicts.set(finding.id, verdict);
    }
  }

  return verdicts;
}

function location(comment: ReviewedComment): string {
  return `${comment.path}:${comment.line}`;
}

function locations(comments: ReviewedComment[]): string {
  const listed = comments.slice(0, MAX_LISTED_LOCATIONS).map(location).join(", ");

  return comments.length > MAX_LISTED_LOCATIONS ? `${listed} and ${comments.length - MAX_LISTED_LOCATIONS} more` : listed;
}

function toReport(judged: Judged[], problems: string[]): FindingsReport {
  const sorted = [...judged].sort((a, b) => byLocation(a.comment, b.comment));

  const findings = sorted
    .filter(({ verdict }) => verdict.verdict !== "keep")
    .map(({ comment, verdict }, index) => ({
      id: String(index + 1),
      severity: "medium" as const,
      file: comment.path,
      line: comment.line,
      column: comment.column,
      endLine: comment.endLine > comment.line ? comment.endLine : undefined,
      rule: commentTrait.name,
      claim: verdict.reason,
      fix: verdict.verdict === "replace" && verdict.change ? verdict.change : DELETE_FIX,
    }));

  const kept = sorted
    .filter(({ verdict }) => verdict.verdict === "keep")
    .map(({ comment, verdict }) => `${location(comment)} (${verdict.reason})`);

  const notes = [
    kept.length > 0 ? `Kept: ${kept.join("; ")}.` : "",
    ...problems,
  ].filter(Boolean);

  return {
    clean: findings.length === 0 && problems.length === 0,
    findings,
    notes: notes.length > 0 ? notes.join(" ") : undefined,
  };
}

function cachedVerdict(value: string | undefined): Verdict | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(value);

  return Value.Check(VerdictSchema, parsed) ? parsed : undefined;
}

interface Round {
  judged: Judged[];
  // False when no agent reported.
  reported: boolean;
}

async function judgeWithAgents(
  pending: ReviewedComment[],
  auditor: CommentAuditor,
  intro: string,
  spawn: (prompt: string) => Promise<AuditorResult>,
  problems: string[],
): Promise<Round> {
  const planned = batches(pending);

  if (planned.skipped.length > 0) {
    problems.push(
      `${planned.skipped.length} comments were not judged, because ${MAX_AGENTS} agents take at most ${MAX_COMMENTS_PER_AGENT} each: ${locations(planned.skipped)}.`,
    );
  }

  let nextId = 1;

  const numbered: Numbered[][] = planned.batches.map((batch) => {
    return batch.map((comment) => ({ comment, id: `M${nextId++}` }));
  });

  const results = await Promise.all(
    numbered.map((batch) => spawn(reviewPrompt(auditor, intro, batch))),
  );

  const round: Round = { judged: [], reported: false };
  results.forEach((result, index) => {
    const batch = numbered[index];

    if (!result.ok || !result.report) {
      const reason = result.ok ? "finished without report_findings" : `failed (${result.text})`;
      problems.push(`A comment-review agent ${reason}, so ${batch.length} comments were not judged.`);

      return;
    }

    round.reported = true;
    const verdicts = verdictsFromReport(result.report, new Set(batch.map(({ id }) => id)));
    const missing = batch.filter(({ id }) => !verdicts.has(id)).map(({ comment }) => comment);

    if (missing.length > 0) {
      problems.push(`comment-review gave no verdict for ${locations(missing)}.`);
    }

    for (const { comment, id } of batch) {
      const verdict = verdicts.get(id);

      if (verdict) {
        round.judged.push({ comment, verdict });
      }
    }
  });

  return round;
}

// Comments whose text and surrounding code were judged before keep their verdict, so only new ones reach an agent.
export async function reviewComments(
  comments: ReviewedComment[],
  auditor: CommentAuditor,
  intro: string,
  spawn: (prompt: string) => Promise<AuditorResult>,
): Promise<AuditorResult> {
  const identity = {
    source: auditor.type,
    title: auditor.title,
    idPrefix: auditor.idPrefix,
  };

  const { cache, problem } = await openVerdictCache();
  const problems = problem ? [problem] : [];
  const cached: Judged[] = [];
  const pending: ReviewedComment[] = [];
  let round: Round = { judged: [], reported: false };

  try {
    for (const comment of comments) {
      const verdict = cachedVerdict(cache.get(verdictKey(comment)));

      if (verdict) {
        cached.push({ comment, verdict });
      } else {
        pending.push(comment);
      }
    }

    if (pending.length > 0) {
      round = await judgeWithAgents(pending, auditor, intro, spawn, problems);
    }

    cache.set(round.judged.map(({ comment, verdict }) => [verdictKey(comment), JSON.stringify(verdict)]));
  } finally {
    cache.close();
  }

  if (cached.length === 0 && !round.reported) {
    return {
      ...identity,
      ok: false,
      text: problems.join(" "),
    };
  }

  const report = toReport([...cached, ...round.judged], problems);

  return {
    ...identity,
    ok: true,
    text: `${report.findings.length} comments to delete or replace`,
    report,
  };
}
