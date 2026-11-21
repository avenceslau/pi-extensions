import { createHash } from "node:crypto";
import {
  askClefInBatches,
  CLEF_MAX_QUESTIONS,
  CLEF_MAX_STATE_CHARS,
  type ClefBatch,
  type ClefQuestion,
} from "../shared/clef.ts";
import type { ClefConfig } from "../shared/config.ts";
import type { AnswerCache } from "./cache.ts";
import type { Candidate } from "./candidates.ts";
import type { Trait } from "./traits.ts";

// Candidates in one file within this many lines of each other share a state.
const WINDOW_LINES = 150;
// Snippet states stay small so one long excerpt does not crowd out the others.
const SNIPPET_STATE_CHARS = 60_000;
const MAX_LINE_CHARS = 1_000;
const LINE_REFERENCE = /\blines? \d+(?:-\d+)?/g;
const LINE_NUMBER_WIDTH = 5;
const EXCERPT_LINES_BEFORE = 3;
const EXCERPT_LINES_AFTER = 2;

export interface JudgeStats {
  questions: number;
  cacheHits: number;
  cacheMisses: number;
  clefCalls: number;
  clefFailures: number;
  clefError?: string;
  // Candidates whose state was too large to send.
  oversized: number;
}

interface Wording {
  question: ClefQuestion;
  key: string;
  probability?: number;
}

interface PendingCandidate {
  candidate: Candidate;
  trait: Trait;
  lines: string[];
}

function question(
  trait: Trait,
  candidate: Candidate,
  candidateId: string,
  suffix: string,
): ClefQuestion {
  return {
    type: "noul",
    instructions: [
      `Rule ${trait.name}: ${trait.requirement}`,
      trait.body,
      `This rule applies to: ${trait.subject}`,
      `Question: does candidate ${candidateId} (${candidate.describe}) break this rule? ${suffix}`,
    ]
      .filter(Boolean)
      .join("\n"),
    criteria: {
      true: `Candidate ${candidateId} breaks rule ${trait.name}`,
      false: `Candidate ${candidateId} follows rule ${trait.name}, or the rule does not apply to it`,
    },
  };
}

// The prototype's measurements moved single helper verdicts by up to 0.5 between wordings, so those rules average two.
function alternateQuestion(
  trait: Trait,
  candidate: Candidate,
  candidateId: string,
  suffix: string,
): ClefQuestion | undefined {
  if (!trait.alternate) {
    return undefined;
  }
  const asked = trait.alternate.replaceAll("{name}", candidate.name ?? "it").replaceAll("{candidate}", candidateId);
  return {
    type: "noul",
    instructions: `${asked}\n${suffix}`,
    criteria: {
      true: "Yes, inline or delete it",
      false: "No, keep it",
    },
  };
}

function numbered(lines: string[], from: number, to: number): string[] {
  const rows: string[] = [];
  for (let line = Math.max(1, from); line <= Math.min(lines.length, to); line += 1) {
    rows.push(`${String(line).padStart(LINE_NUMBER_WIDTH)}| ${lines[line - 1].slice(0, MAX_LINE_CHARS)}`);
  }
  return rows;
}

function excerptRange(candidate: Candidate): { from: number; to: number } {
  return {
    from: candidate.line - EXCERPT_LINES_BEFORE,
    to: candidate.endLine + EXCERPT_LINES_AFTER,
  };
}

// The candidate's code without line numbers, so moving it within the file keeps its cached answer.
function candidateText(candidate: Candidate, lines: string[]): string {
  const { from, to } = excerptRange(candidate);
  const ranges = [
    [from, to],
    ...(candidate.extraLines ?? []).map((line) => [line - 2, line + 2]),
  ];
  return ranges.map(([start, end]) => lines.slice(Math.max(0, start - 1), end).join("\n")).join("\n…\n");
}

function cacheKey(trait: Trait, text: string, asked: ClefQuestion, candidateId: string): string {
  const instructions = asked.instructions.replaceAll(candidateId, "C").replace(LINE_REFERENCE, "line");
  return createHash("sha256")
    .update(JSON.stringify([trait.name, trait.version, text, instructions]))
    .digest("hex");
}

function wordings(pending: PendingCandidate, candidateId: string): Wording[] {
  const { candidate, trait, lines } = pending;
  const text = candidateText(candidate, lines);
  const facts = candidate.facts ? `\nFacts computed by the linter: ${candidate.facts}` : "";
  const suffix = `Judge only the code between <<<CANDIDATE ${candidateId}>>> and <<<END ${candidateId}>>>; the rest is context.${facts}`;
  const asked = [
    question(trait, candidate, candidateId, suffix),
    alternateQuestion(trait, candidate, candidateId, suffix),
  ];
  return asked
    .filter((entry): entry is ClefQuestion => entry !== undefined)
    .map((entry) => ({
      question: entry,
      key: cacheKey(trait, text, entry, candidateId),
    }));
}

function markedRows(
  lines: string[],
  from: number,
  to: number,
  marked: { candidate: Candidate; candidateId: string }[],
): string[] {
  const rows: string[] = [];
  for (const row of numbered(lines, from, to)) {
    const line = Number(row.slice(0, LINE_NUMBER_WIDTH));
    for (const { candidate, candidateId } of marked) {
      if (candidate.line === line) {
        rows.push(`<<<CANDIDATE ${candidateId}>>>`);
      }
    }
    rows.push(row);
    for (const { candidate, candidateId } of marked) {
      if (candidate.endLine === line) {
        rows.push(`<<<END ${candidateId}>>>`);
      }
    }
  }
  return rows;
}

interface StateGroup {
  state: string;
  members: { pending: PendingCandidate; candidateId: string }[];
}

function windowState(group: PendingCandidate[]): StateGroup {
  const { lines, candidate: first } = group[0];
  const members = group.map((pending, index) => ({ pending, candidateId: `C${index + 1}` }));
  const from = Math.min(...group.map(({ candidate }) => excerptRange(candidate).from));
  const to = Math.max(...group.map(({ candidate }) => excerptRange(candidate).to));
  const marked = members.map(({ pending, candidateId }) => ({ candidate: pending.candidate, candidateId }));
  const outside = [...new Set(group.flatMap(({ candidate }) => candidate.extraLines ?? []))]
    .filter((line) => line < from || line > to)
    .sort((a, b) => a - b);

  const rows = [`File: ${first.path}`, ...markedRows(lines, from, to, marked)];
  if (outside.length > 0) {
    rows.push("Call sites:", ...outside.flatMap((line) => ["…", ...numbered(lines, line - 2, line + 2)]));
  }
  return {
    state: rows.join("\n"),
    members,
  };
}

function windowGroups(pending: PendingCandidate[]): PendingCandidate[][] {
  const byFile = new Map<string, PendingCandidate[]>();
  for (const entry of pending) {
    const list = byFile.get(entry.candidate.path) ?? [];
    list.push(entry);
    byFile.set(entry.candidate.path, list);
  }

  const groups: PendingCandidate[][] = [];
  for (const list of byFile.values()) {
    list.sort((a, b) => a.candidate.line - b.candidate.line);
    let group: PendingCandidate[] = [];
    let start = 0;
    for (const entry of list) {
      if (group.length > 0 && excerptRange(entry.candidate).to - start > WINDOW_LINES) {
        groups.push(group);
        group = [];
      }
      if (group.length === 0) {
        start = entry.candidate.line;
      }
      group.push(entry);
    }
    groups.push(group);
  }
  return groups;
}

function snippetExcerpt(candidate: Candidate, lines: string[], candidateId: string): string[] {
  const { from, to } = excerptRange(candidate);
  const rows = [`File: ${candidate.path}`, ...markedRows(lines, from, to, [{ candidate, candidateId }])];
  const outside = (candidate.extraLines ?? []).filter((line) => line < from || line > to);
  if (outside.length > 0) {
    rows.push("Used on:", ...outside.flatMap((line) => numbered(lines, line, line)));
  }
  return [...rows, ""];
}

function snippetStates(pending: PendingCandidate[]): StateGroup[] {
  const states: StateGroup[] = [];
  let rows: string[] = [];
  let size = 0;
  let members: StateGroup["members"] = [];
  // Candidates of different rules about the same lines, such as two naming rules on one name, share an excerpt.
  let shared = new Map<string, string>();
  const flush = () => {
    if (members.length > 0) {
      states.push({ state: rows.join("\n"), members });
    }
    rows = [];
    size = 0;
    members = [];
    shared = new Map();
  };

  const sorted = [...pending].sort((a, b) => {
    return a.candidate.path.localeCompare(b.candidate.path) || a.candidate.line - b.candidate.line;
  });
  // Ids are numbered across all snippet states, so they stay unique whichever state an excerpt lands in.
  sorted.forEach((entry, index) => {
    const { candidate, lines } = entry;
    const excerptKey = candidateText(candidate, lines);
    const sharedId = shared.get(excerptKey);
    if (sharedId && members.length < CLEF_MAX_QUESTIONS) {
      members.push({ pending: entry, candidateId: sharedId });
      return;
    }
    const candidateId = `${candidate.path}#C${index + 1}`;
    const excerpt = snippetExcerpt(candidate, lines, candidateId);
    const excerptSize = excerpt.join("\n").length;
    if (members.length >= CLEF_MAX_QUESTIONS || size + excerptSize > SNIPPET_STATE_CHARS) {
      flush();
    }
    rows.push(...excerpt);
    size += excerptSize;
    shared.set(excerptKey, candidateId);
    members.push({ pending: entry, candidateId });
  });
  flush();
  return states;
}

function states(pending: PendingCandidate[]): StateGroup[] {
  const snippets = pending.filter(({ candidate }) => candidate.layout === "snippet");
  const windows = pending.filter(({ candidate }) => candidate.layout === "window");
  return [
    ...snippetStates(snippets),
    ...windowGroups(windows).map(windowState),
  ];
}

// Probabilities by candidate, averaged over the rule's wordings; unanswered candidates are left out.
export async function judge(
  clef: ClefConfig,
  candidates: Candidate[],
  fileLines: Map<string, string[]>,
  traits: Map<string, Trait>,
  cache: AnswerCache,
  stats: JudgeStats,
  signal?: AbortSignal,
): Promise<Map<Candidate, number>> {
  const pending: PendingCandidate[] = [];
  for (const candidate of candidates) {
    const trait = traits.get(candidate.rule);
    const lines = fileLines.get(candidate.path);
    if (trait && lines) {
      pending.push({ candidate, trait, lines });
    }
  }

  const asked: { group: StateGroup; wordings: Wording[][] }[] = [];
  for (const group of states(pending)) {
    if (group.state.length > CLEF_MAX_STATE_CHARS) {
      stats.oversized += group.members.length;
      continue;
    }
    const groupWordings = group.members.map(({ pending: entry, candidateId }) => wordings(entry, candidateId));
    for (const wording of groupWordings.flat()) {
      stats.questions += 1;
      wording.probability = cache.get(wording.key);
      if (wording.probability === undefined) {
        stats.cacheMisses += 1;
      } else {
        stats.cacheHits += 1;
      }
    }
    asked.push({ group, wordings: groupWordings });
  }

  const requests: { request: ClefBatch; wordings: Wording[] }[] = [];
  for (const { group, wordings: groupWordings } of asked) {
    const missing = groupWordings.flat().filter((wording) => wording.probability === undefined);
    if (missing.length > 0) {
      requests.push({
        request: {
          state: group.state,
          questions: missing.map((wording) => wording.question),
        },
        wordings: missing,
      });
    }
  }

  const { answers, calls, failures, lastError } = await askClefInBatches(
    clef,
    requests.map(({ request }) => request),
    signal,
  );
  stats.clefCalls += calls;
  stats.clefFailures += failures;
  stats.clefError = lastError ?? stats.clefError;
  const answered: [string, number][] = [];
  requests.forEach(({ wordings: missing }, index) => {
    missing.forEach((wording, position) => {
      const probability = answers[index][position];
      if (probability !== undefined) {
        wording.probability = probability;
        answered.push([wording.key, probability]);
      }
    });
  });
  cache.set(answered);

  const results = new Map<Candidate, number>();
  for (const { group, wordings: groupWordings } of asked) {
    group.members.forEach(({ pending: entry }, index) => {
      const values = groupWordings[index].map((wording) => wording.probability);
      if (values.every((value) => value !== undefined)) {
        results.set(entry.candidate, values.reduce((total, value) => total + value, 0) / values.length);
      }
    });
  }
  return results;
}
