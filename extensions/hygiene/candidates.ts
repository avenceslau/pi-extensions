import { TEST_FILE, type Analysis, type FunctionInfo, type Identifier } from "./analysis.ts";
import { addedRuns, countAdded, type ChangedFile } from "./diff.ts";
import { SHORT_NAME_MAX_CHARS, usefulSuggestion } from "./names.ts";
import type { Trait } from "./traits.ts";

// snippet: a short excerpt batched with excerpts from other files, for rules that need little context.
// window: marked inside the surrounding code, together with nearby candidates.
export type CandidateLayout = "snippet" | "window";

export interface Candidate {
  rule: string;
  path: string;
  line: number;
  endLine: number;
  column?: number;
  name?: string;
  describe: string;
  facts?: string;
  layout: CandidateLayout;
  // Lines elsewhere in the file the excerpt also shows, such as the only call site.
  extraLines?: number[];
  // A span of added lines asked about because no parser built candidates; split further while Clef flags it.
  bisect?: boolean;
  suggestion?: string;
}

// Counts whole-word occurrences across the repository, or undefined when it cannot.
export type CountWord = (word: string) => Promise<number | undefined>;

// The clef rules a parser builds candidates for; other clef rules are asked about spans of added lines.
export const BUILT_RULES = new Set([
  "code-restraint/coined-name",
  "code-restraint/undescriptive-name",
  "code-restraint/speculative-knob",
  "code-restraint/one-use-helper",
  "code-restraint/trivial-wrapper",
  "code-restraint/test-either-outcome",
  "refactor/tangled-branching",
  "refactor/mixed-responsibilities",
]);
// Rules about a whole function: a flagged span of added lines is reported as is instead of being split.
const FUNCTION_RULES = new Set(["refactor/tangled-branching", "refactor/mixed-responsibilities"]);
// A one-use helper needs a call-site count.
const NEEDS_PARSER = new Set(["code-restraint/one-use-helper"]);
const ENTRY_POINT = /^(?:constructor|default|main|fetch|alarm|scheduled|queue|webSocketMessage|webSocketClose|render)$/;
const SPAN_GAP = 3;
const MIN_SPLIT_LINES = 5;
const MAX_NAME_USES = 3;
const NAME_RULE_KINDS = new Set(["function", "variable", "parameter", "type", "const"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function usesElsewhere(
  name: string,
  fileUses: number,
  countWord: CountWord,
): Promise<number> {
  if (name.length < 3) {
    return fileUses;
  }
  const total = await countWord(name);
  // The declaration itself is one of the occurrences.
  return total === undefined ? fileUses : total - 1;
}

// Added lines other than the declaration that use the name, so the excerpt shows what the name stands for.
function nameUses(identifier: Identifier, lines: string[], file: ChangedFile): number[] {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(identifier.name)}(?![\\w$])`);
  const uses: number[] = [];
  for (const line of [...file.added].sort((a, b) => a - b)) {
    if (uses.length >= MAX_NAME_USES) {
      break;
    }
    if (line !== identifier.line && pattern.test(lines[line - 1] ?? "")) {
      uses.push(line);
    }
  }
  return uses;
}

function nameCandidates(
  identifier: Identifier,
  path: string,
  lines: string[],
  file: ChangedFile,
  wanted: (rule: string) => boolean,
): Candidate[] {
  const { name } = identifier;
  if (name.length <= SHORT_NAME_MAX_CHARS || name.startsWith("_")) {
    return [];
  }
  const coined = wanted("code-restraint/coined-name") && !identifier.functionLocal;
  const undescriptive =
    wanted("code-restraint/undescriptive-name") &&
    NAME_RULE_KINDS.has(identifier.kind) &&
    !identifier.loopCounter &&
    !identifier.sortComparator &&
    !identifier.contextual &&
    !identifier.nameFromProperty &&
    !identifier.holdsAnyValue;
  const base = {
    path,
    name,
    line: identifier.line,
    endLine: identifier.line,
    column: identifier.column,
    describe: `the ${identifier.kind} name \`${name}\` declared on line ${identifier.line}`,
    layout: "snippet" as const,
    extraLines: nameUses(identifier, lines, file),
    suggestion: usefulSuggestion(identifier),
  };
  return [
    ...(coined ? [{ ...base, rule: "code-restraint/coined-name" }] : []),
    ...(undescriptive ? [{ ...base, rule: "code-restraint/undescriptive-name" }] : []),
  ];
}

async function functionCandidates(
  fn: FunctionInfo,
  path: string,
  file: ChangedFile,
  analysis: Analysis,
  wanted: (rule: string) => boolean,
  countWord: CountWord,
): Promise<Candidate[]> {
  const name = fn.name ?? "";
  const length = fn.endLine - fn.line + 1;
  const addedLines = countAdded(file.added, fn.line, fn.endLine);
  const isNew = file.added.has(fn.line);
  const fileUses = (analysis.calls.get(name) ?? []).filter((line) => line < fn.line || line > fn.endLine);
  const base = {
    path,
    name,
    line: fn.line,
    endLine: fn.endLine,
    describe: `the function \`${name}\` on lines ${fn.line}-${fn.endLine}`,
  };
  const candidates: Candidate[] = [];

  if (isNew && !ENTRY_POINT.test(name) && wanted("code-restraint/one-use-helper")) {
    const uses = fn.exported ? await usesElsewhere(name, fileUses.length, countWord) : fileUses.length;
    if (uses === 1) {
      candidates.push({
        ...base,
        rule: "code-restraint/one-use-helper",
        layout: "window",
        facts: `\`${name}\` has exactly one call site, on line ${fileUses[0] ?? "?"}; its body is ${length} lines long.`,
        extraLines: fileUses,
      });
    }
  }
  if (isNew && fn.single && length <= 6 && wanted("code-restraint/trivial-wrapper")) {
    const callee = fn.single.kind === "call" ? `call to \`${fn.single.name ?? "another function"}\`` : "expression";
    candidates.push({
      ...base,
      rule: "code-restraint/trivial-wrapper",
      layout: "window",
      facts: `Its body is a single ${callee}.`,
    });
  }
  if (fn.branches >= 6 && addedLines >= 5 && wanted("refactor/tangled-branching")) {
    candidates.push({
      ...base,
      rule: "refactor/tangled-branching",
      layout: "window",
      facts: `It has ${fn.branches} branches and nests ${fn.maxDepth} levels deep; ${addedLines} of its lines were added by this change.`,
    });
  }
  if (length >= 30 && addedLines >= 10 && wanted("refactor/mixed-responsibilities")) {
    candidates.push({
      ...base,
      rule: "refactor/mixed-responsibilities",
      layout: "window",
      facts: `It is ${length} lines long; ${addedLines} of its lines were added by this change.`,
    });
  }
  return candidates;
}

export async function parsedCandidates(
  path: string,
  file: ChangedFile,
  analysis: Analysis,
  source: string,
  traits: Map<string, Trait>,
  countWord: CountWord,
): Promise<Candidate[]> {
  const added = file.added;
  const wanted = (rule: string) => traits.get(rule)?.check === "clef";
  const candidates: Candidate[] = [];

  const lines = source.split("\n");
  const seen = new Set<string>();
  for (const identifier of analysis.identifiers) {
    const key = `${identifier.name}:${identifier.line}`;
    if (seen.has(key) || !added.has(identifier.line)) {
      continue;
    }
    seen.add(key);
    candidates.push(...nameCandidates(identifier, path, lines, file, wanted));
  }

  if (wanted("code-restraint/speculative-knob")) {
    for (const knob of analysis.knobs.filter((entry) => added.has(entry.line))) {
      const pattern = new RegExp(`\\b${escapeRegExp(knob.name.replace(/[^\w$]/g, ""))}\\b`, "g");
      const inFile = (source.match(pattern) ?? []).length - 1;
      const inRepository = Math.max(inFile, await usesElsewhere(knob.name, inFile, countWord));
      candidates.push({
        rule: "code-restraint/speculative-knob",
        path,
        name: knob.name,
        line: knob.line,
        endLine: knob.endLine,
        describe: `the ${knob.kind} \`${knob.name}\` on line ${knob.line}`,
        facts: `\`${knob.name}\` appears ${inRepository} other times in the repository (${inFile} in this file).`,
        layout: "window",
      });
    }
  }

  for (const fn of analysis.functions) {
    if (!fn.name) {
      continue;
    }
    candidates.push(...(await functionCandidates(fn, path, file, analysis, wanted, countWord)));
  }

  if (wanted("code-restraint/test-either-outcome")) {
    for (const branch of analysis.testBranches) {
      if (countAdded(added, branch.line, branch.endLine) === 0) {
        continue;
      }
      candidates.push({
        rule: "code-restraint/test-either-outcome",
        path,
        line: branch.line,
        endLine: branch.endLine,
        describe: `the ${branch.kind} on lines ${branch.line}-${branch.endLine} inside a test`,
        layout: "window",
      });
    }
  }
  return candidates;
}

// Added lines close together form one span, so scattered one-line edits do not each cost a question.
function addedSpans(file: ChangedFile): { line: number; endLine: number }[] {
  const spans: { line: number; endLine: number }[] = [];
  for (const run of addedRuns(file)) {
    const last = spans.at(-1);
    if (last && run.line - last.endLine <= SPAN_GAP) {
      last.endLine = run.endLine;
      continue;
    }
    spans.push({ ...run });
  }
  return spans;
}

export function spanCandidate(rule: string, path: string, line: number, endLine: number): Candidate {
  return {
    rule,
    path,
    line,
    endLine,
    describe: `the code on lines ${line}-${endLine}`,
    layout: "window",
    bisect: !FUNCTION_RULES.has(rule),
  };
}

// For clef rules without parser-built candidates in this file.
export function spanCandidates(path: string, file: ChangedFile, rules: Trait[]): Candidate[] {
  const applicable = rules.filter((trait) => {
    if (NEEDS_PARSER.has(trait.name)) {
      return false;
    }
    return trait.name !== "code-restraint/test-either-outcome" || TEST_FILE.test(path);
  });
  return addedSpans(file).flatMap((span) => {
    return applicable.map((trait) => spanCandidate(trait.name, path, span.line, span.endLine));
  });
}

// Splits at the blank or statement-ending line nearest the middle, so halves tend to hold whole statements.
export function splitSpan(candidate: Candidate, lines: string[]): Candidate[] {
  const { line, endLine } = candidate;
  if (!candidate.bisect || endLine - line + 1 < MIN_SPLIT_LINES) {
    return [];
  }

  const middle = Math.floor((line + endLine) / 2);
  let cut = middle;
  for (let distance = 0; distance <= (endLine - line) / 2; distance += 1) {
    const found = [middle - distance, middle + distance].find((at) => {
      const text = lines[at - 1]?.trimEnd() ?? "";
      return at >= line && at < endLine && (text.trim() === "" || /[;}]$|\}\);$/.test(text));
    });
    if (found !== undefined) {
      cut = found;
      break;
    }
  }
  return [
    spanCandidate(candidate.rule, candidate.path, line, cut),
    spanCandidate(candidate.rule, candidate.path, cut + 1, endLine),
  ];
}
