import { TEST_FILE, type Analysis } from "./analysis.ts";
import { openAnswerCache, type AnswerCache } from "./cache.ts";
import {
  BUILT_RULES,
  parsedCandidates,
  spanCandidates,
  splitSpan,
  type Candidate,
} from "./candidates.ts";
import { commentCandidates, type CommentCandidate } from "./comments.ts";
import { parseDiff, type ChangedFile } from "./diff.ts";
import {
  duplicationFindings,
  longLineFindings,
  parsedFindings,
  structureFindings,
  type FileFinding,
  type LintedFile,
} from "./local-rules.ts";
import type { ClefConfig } from "../shared/config.ts";
import { judge, type JudgeStats } from "./questions.ts";
import { analyzeRust, rustParser } from "./rust.ts";
import { sourceTree, type SourceTree } from "./source.ts";
import { CATEGORY_NAMES, TRAITS, type Trait } from "./traits.ts";

const TYPESCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const RUST_FILE = /\.rs$/;
const OTHER_CODE_FILE = /\.(?:go|py|c|cc|cpp|cxx|h|hh|hpp|java|kt|kts|swift|rb|sh|bash|cs|php|scala|zig|lua)$/;
const MAX_FILE_CHARS = 1_500_000;
const COMMENT_RULE = "code-restraint/comment";

// Each round is one batch of Clef calls; four rounds narrow a 60-line span to a few lines.
const BISECT_ROUNDS = 4;
const DEFAULT_NESTING_DEPTH = 4;
const DEFAULT_DUPLICATE_LINES = 5;
const DEFAULT_CLUSTER_SIZE = 3;

// A name these rules already flagged is not asked about again, nor reported twice for the same reason.
const NAME_RULES = new Set([
  "code-restraint/short-name",
  "code-restraint/ceremony-name",
  "code-restraint/generic-name",
  "code-restraint/coined-name",
]);

const LOCAL_RULES = new Set([
  "code-restraint/same-line-body",
  "code-restraint/deep-nesting",
  "code-restraint/swallowed-error",
  "code-restraint/short-name",
  "code-restraint/ceremony-name",
  "code-restraint/magic-offset",
  "code-restraint/magic-number",
  "code-restraint/generic-name",
  "code-restraint/dense-line",
  "refactor/forwarding-chain",
  "refactor/duplication",
  "refactor/structure-flat-cluster",
]);

export type Severity = "error" | "warning" | "info";

export interface HygieneDiagnostic {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  column?: number;
  severity: Severity;
  rule: string;
  message: string;
  fix: string;
  source: "hygiene";
  // Set for Clef rules; local rules are exact.
  probability?: number;
}

export interface LintStats extends JudgeStats {
  files: number;
  addedLines: number;
  changedLines: number;
  candidates: number;
  wallMs: number;
}

export interface LintResult {
  diagnostics: HygieneDiagnostic[];
  // Added comments, and unchanged ones next to edited code, for the post-change audit's comment-review agent to judge.
  comments: CommentCandidate[];
  // 100 is clean; each category decays with its non-info diagnostics per 100 added lines.
  scores: Record<string, number>;
  // off: Clef was not asked. unavailable: at least one call failed, so some candidates went unjudged.
  clef: "ok" | "unavailable" | "off";
  notices: string[];
  stats: LintStats;
}

export interface LintOptions {
  // Repository root: paths are relative to it.
  root: string;
  // Read files from this git tree or commit instead of the checkout on disk.
  ref?: string;
  // A unified diff; only its added lines are reported.
  diffText?: string;
  // Files linted as wholly added.
  paths?: string[];
  // Without it only the local rules run.
  clef?: ClefConfig;
  // A formatter already ran over the files, so formatter-owned rules are dropped.
  formatted?: boolean;
  signal?: AbortSignal;
}

type Finding = FileFinding & { probability?: number };

interface Context {
  traits: Map<string, Trait>;
  tree: SourceTree;
  notices: string[];
  stats: LintStats;
  signal?: AbortSignal;
}

async function changedFiles(options: LintOptions, tree: SourceTree): Promise<ChangedFile[]> {
  const files = options.diffText === undefined ? [] : parseDiff(options.diffText);

  for (const path of options.paths ?? []) {
    const lineCount = (await tree.read(path).catch(() => "")).split("\n").length;
    files.push({
      path,
      status: "A",
      added: new Set(Array.from({ length: lineCount }, (_, index) => index + 1)),
      changedLines: lineCount,
    });
  }

  return files;
}

function threshold(traits: Map<string, Trait>, rule: string, fallback: number): number {
  const trait = traits.get(rule);

  return trait?.check === "local" ? (trait.sizeThreshold ?? fallback) : fallback;
}

async function typeScriptAnalyzer(notices: string[]): Promise<typeof import("./typescript.ts") | undefined> {
  try {
    return await import("./typescript.ts");
  } catch (error) {
    notices.push(
      `TypeScript is not installed next to the hygiene extension (${String(error)}); run npm install in the pi-extensions package. TypeScript and JavaScript files got only the parser-free rules.`,
    );

    return undefined;
  }
}

async function rustParserPath(notices: string[]): Promise<string | undefined> {
  try {
    return await rustParser();
  } catch (error) {
    notices.push(
      `The Rust parser could not be built with cargo build --release --offline (${String(error).split("\n")[0]}); Rust files got only the parser-free rules.`,
    );

    return undefined;
  }
}

async function readFiles(files: ChangedFile[], context: Context): Promise<LintedFile[]> {
  const depth = threshold(context.traits, "code-restraint/deep-nesting", DEFAULT_NESTING_DEPTH);

  const code = files.filter((file) => {
    return TYPESCRIPT_FILE.test(file.path) || RUST_FILE.test(file.path) || OTHER_CODE_FILE.test(file.path);
  });

  const typescript = code.some((file) => TYPESCRIPT_FILE.test(file.path))
    ? await typeScriptAnalyzer(context.notices)
    : undefined;

  const rust = code.some((file) => RUST_FILE.test(file.path)) ? await rustParserPath(context.notices) : undefined;

  const linted: LintedFile[] = [];

  for (const file of code) {
    // Unreadable entries, such as submodules, are skipped.
    const source = await context.tree.read(file.path).catch(() => undefined);

    if (source === undefined || source.length > MAX_FILE_CHARS || source.includes("\0")) {
      continue;
    }

    let analysis: Analysis | undefined;

    if (typescript && TYPESCRIPT_FILE.test(file.path)) {
      analysis = typescript.analyzeTypeScript(file.path, source, depth);
    } else if (rust && RUST_FILE.test(file.path)) {
      // A parser crash or timeout leaves the file to the parser-free rules, like a parse error does.
      analysis = await analyzeRust(rust, source, depth).catch(() => undefined);
    }

    linted.push({
      file,
      lines: source.split("\n"),
      analysis,
    });
  }

  return linted;
}

async function localFindings(linted: LintedFile[], files: ChangedFile[], context: Context): Promise<Finding[]> {
  const { traits } = context;
  const findings: Finding[] = [];

  for (const { file, lines, analysis } of linted) {
    if (analysis) {
      findings.push(...parsedFindings(file.path, analysis, file));
    }

    findings.push(...longLineFindings(file.path, file, lines));
  }

  findings.push(
    ...duplicationFindings(linted, threshold(traits, "refactor/duplication", DEFAULT_DUPLICATE_LINES)),
    ...(await structureFindings(
      files,
      threshold(traits, "refactor/structure-flat-cluster", DEFAULT_CLUSTER_SIZE),
      (dir) => context.tree.listDir(dir),
    )),
  );

  return findings.filter((finding) => traits.get(finding.rule)?.check === "local");
}

async function candidatesFor(linted: LintedFile[], context: Context): Promise<Candidate[]> {
  const clefTraits = [...context.traits.values()].filter((trait) => trait.check === "clef");
  const unbuilt = clefTraits.filter((trait) => !BUILT_RULES.has(trait.name));
  const candidates: Candidate[] = [];

  for (const { file, lines, analysis } of linted) {
    if (!analysis) {
      candidates.push(...spanCandidates(file.path, file, clefTraits));
      continue;
    }

    candidates.push(
      ...(await parsedCandidates(
        file.path,
        file,
        analysis,
        lines.join("\n"),
        context.traits,
        (word) => context.tree.countWord(word),
      )),
      ...spanCandidates(file.path, file, unbuilt),
    );
  }

  return candidates;
}

function commentsFor(linted: LintedFile[], traits: Map<string, Trait>): CommentCandidate[] {
  if (traits.get(COMMENT_RULE)?.check !== "agent") {
    return [];
  }

  return linted.flatMap(({ file, lines, analysis }) => commentCandidates(file.path, file, lines, analysis));
}

// Spans of added lines that Clef flags are halved and asked again, so the diagnostic points at the lines that break the rule.
async function clefFindings(
  clef: ClefConfig,
  candidates: Candidate[],
  fileLines: Map<string, string[]>,
  cache: AnswerCache,
  context: Context,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  const flag = (candidate: Candidate, probability: number) => {
    findings.push({
      path: candidate.path,
      rule: candidate.rule,
      name: candidate.name,
      line: candidate.line,
      endLine: candidate.endLine,
      column: candidate.column,
      message: `${context.traits.get(candidate.rule)?.requirement.split(". ")[0]}: ${candidate.describe}.`,
      suggestion: candidate.suggestion,
      probability,
    });
  };

  type Asked = { candidate: Candidate; parent?: { candidate: Candidate; probability: number } };

  let round: Asked[] = candidates.map((candidate) => ({ candidate }));

  for (let depth = 0; depth < BISECT_ROUNDS && round.length > 0; depth += 1) {
    const probabilities = await judge(
      clef,
      round.map(({ candidate }) => candidate),
      fileLines,
      context.traits,
      cache,
      context.stats,
      context.signal,
    );

    const next: Asked[] = [];
    const confirmedParents = new Set<Asked["parent"]>();

    for (const { candidate, parent } of round) {
      const probability = probabilities.get(candidate);
      const trait = context.traits.get(candidate.rule);

      if (
        trait?.check !== "clef" ||
        probability === undefined ||
        probability < trait.probabilityThreshold
      ) {
        continue;
      }

      confirmedParents.add(parent);
      const halves = depth + 1 < BISECT_ROUNDS ? splitSpan(candidate, fileLines.get(candidate.path) ?? []) : [];

      if (halves.length === 0) {
        flag(candidate, probability);
        continue;
      }

      const located = { candidate, probability };
      next.push(...halves.map((half) => ({ candidate: half, parent: located })));
    }

    // A flagged span whose halves are not flagged on their own is reported whole.
    for (const parent of new Set(round.map((asked) => asked.parent))) {
      if (parent && !confirmedParents.has(parent)) {
        flag(parent.candidate, parent.probability);
      }
    }

    round = next;
  }

  return findings;
}

function fillFix(template: string, finding: Finding): string {
  const values: Record<string, string | undefined> = {
    name: finding.name,
    target: finding.target,
    prefix: finding.prefix,
  };

  const fix = template.replace(/(`?)\{(\w+)\}\1/g, (_match, tick: string, key: string) => {
    const value = values[key];

    return value ? `${tick}${value}${tick}` : "it";
  });

  return finding.suggestion ? `${fix} The code suggests \`${finding.suggestion}\`.` : fix;
}

function nameKey(finding: { path: string; line: number; name?: string }): string {
  return `${finding.path}:${finding.line}:${finding.name}`;
}

function withoutNamedTwice<Entry extends { rule: string; path: string; line: number; name?: string }>(
  entries: Entry[],
  flagged: Finding[],
): Entry[] {
  const named = new Set(flagged.filter((finding) => NAME_RULES.has(finding.rule)).map(nameKey));

  return entries.filter((entry) => entry.rule !== "code-restraint/undescriptive-name" || !named.has(nameKey(entry)));
}

function toDiagnostics(findings: Finding[], traits: Map<string, Trait>): HygieneDiagnostic[] {
  const sorted = findings
    .map((finding) => {
      const trait = traits.get(finding.rule);
      const testCopy = finding.rule === "refactor/duplication" && TEST_FILE.test(finding.path);

      return {
        file: finding.path,
        line: finding.line,
        endLine: finding.endLine > finding.line ? finding.endLine : undefined,
        column: finding.column,
        severity: testCopy ? "info" : trait?.severity ?? "warning",
        rule: finding.rule,
        message: finding.message,
        fix: fillFix(trait?.fix ?? "", finding),
        source: "hygiene" as const,
        probability: finding.probability === undefined ? undefined : Math.round(finding.probability * 1000) / 1000,
      } satisfies Omit<HygieneDiagnostic, "id">;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));

  return sorted.map((diagnostic, index) => ({
    id: `H${index + 1}`,
    ...diagnostic,
  }));
}

function scoreCategories(
  diagnostics: HygieneDiagnostic[],
  traits: Map<string, Trait>,
  addedLines: number,
): Record<string, number> {
  const scores: Record<string, number> = {};

  for (const category of CATEGORY_NAMES) {
    let weight = 0;

    for (const diagnostic of diagnostics) {
      if (traits.get(diagnostic.rule)?.category === category && diagnostic.severity !== "info") {
        weight += diagnostic.probability ?? 1;
      }
    }

    const per100Lines = addedLines > 0 ? (100 * weight) / addedLines : 0;
    scores[category] = Math.round(100 * Math.exp(-per100Lines / 3));
  }

  const values = Object.values(scores);
  scores.overall = Math.round(values.reduce((total, value) => total + value, 0) / values.length);

  return scores;
}

function loadedTraitNotices(traits: Map<string, Trait>): string[] {
  const notices: string[] = [];

  for (const trait of traits.values()) {
    if (trait.check === "local" && !LOCAL_RULES.has(trait.name)) {
      notices.push(`${trait.name} is a local rule the linter has no check for, so it was skipped.`);
    }
  }

  return notices;
}

export async function lint(options: LintOptions): Promise<LintResult> {
  const started = Date.now();

  const traits = new Map(
    [...TRAITS].filter(([, trait]) => !(options.formatted && trait.skipWhenFormatted)),
  );

  const context: Context = {
    traits,
    tree: sourceTree(options.root, options.ref),
    notices: loadedTraitNotices(traits),
    stats: {
      files: 0,
      addedLines: 0,
      changedLines: 0,
      candidates: 0,
      questions: 0,
      cacheHits: 0,
      cacheMisses: 0,
      clefCalls: 0,
      clefFailures: 0,
      oversized: 0,
      wallMs: 0,
    },
    signal: options.signal,
  };

  const files = await changedFiles(options, context.tree);
  const linted = await readFiles(files, context);
  const findings = await localFindings(linted, files, context);
  options.signal?.throwIfAborted();

  const { clef: clefConfig } = options;
  const candidates = clefConfig ? withoutNamedTwice(await candidatesFor(linted, context), findings) : [];

  if (clefConfig && candidates.length > 0) {
    const { cache, problem } = await openAnswerCache();

    if (problem) {
      context.notices.push(problem);
    }

    try {
      const fileLines = new Map(linted.map(({ file, lines }) => [file.path, lines]));
      const judged = await clefFindings(clefConfig, candidates, fileLines, cache, context);
      findings.push(...withoutNamedTwice(judged, judged));
    } finally {
      cache.close();
    }
  }

  options.signal?.throwIfAborted();

  const { stats } = context;
  stats.files = linted.length;
  stats.addedLines = linted.reduce((total, { file }) => total + file.added.size, 0);
  stats.changedLines = linted.reduce((total, { file }) => total + file.changedLines, 0);
  stats.candidates = candidates.length;

  if (stats.oversized > 0) {
    context.notices.push(`${stats.oversized} candidates were too large for one Clef state and were skipped.`);
  }

  let clef: LintResult["clef"] = clefConfig ? "ok" : "off";

  if (stats.clefFailures > 0) {
    clef = "unavailable";
    context.notices.push(
      `${stats.clefFailures} of ${stats.clefCalls} Clef calls failed (${stats.clefError}); their candidates were not judged.`,
    );
  }

  const diagnostics = toDiagnostics(findings, traits);
  stats.wallMs = Date.now() - started;

  return {
    diagnostics,
    comments: commentsFor(linted, traits),
    scores: scoreCategories(diagnostics, traits, stats.addedLines),
    clef,
    notices: context.notices,
    stats,
  };
}
