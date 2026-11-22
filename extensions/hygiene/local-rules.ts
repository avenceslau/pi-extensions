import { basename, dirname } from "node:path";
import { TEST_FILE, type Analysis, type LocalFinding } from "./analysis.ts";
import type { ChangedFile } from "./diff.ts";
import { genericNameProblem, SHORT_NAME_MAX_CHARS, usefulSuggestion } from "./names.ts";

export interface FileFinding extends LocalFinding {
  path: string;
}

export interface LintedFile {
  file: ChangedFile;
  lines: string[];
  analysis?: Analysis;
}

const SHORT_NAME_ALLOWED = new Set([
  "_",
  "pr",
  "mr",
  "id",
  "ok",
  "db",
  "fs",
  "io",
  "ms",
  "fn",
  "to",
  "at",
  "op",
  "os",
  "ui",
  "pi",
  "ctx",
  "x",
  "y",
]);

const CEREMONY_SUFFIX = /(?:Factory|Manager|Helpers?|Utils?|Wrapper|Impl)$/;

// Properties and fields often mirror a shape chosen elsewhere, such as a wire format.
const GENERIC_NAME_KINDS = new Set(["function", "variable", "parameter", "type", "const"]);

const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "new",
  "await",
  "async",
  "const",
  "let",
  "var",
  "function",
  "class",
  "extends",
  "import",
  "export",
  "from",
  "type",
  "interface",
  "of",
  "in",
  "typeof",
  "instanceof",
  "void",
  "yield",
  "break",
  "continue",
  "default",
  "this",
  "super",
  "null",
  "undefined",
  "true",
  "false",
  "fn",
  "mut",
  "pub",
  "impl",
  "struct",
  "enum",
  "match",
  "use",
  "mod",
  "self",
  "Self",
  "Some",
  "None",
  "Ok",
  "Err",
]);

const LAYER_DIR = /(?:^|\/)(handlers|services|managers|controllers|stores|clients)$/;
const GENERIC_PREFIX = /^(?:index|test|tests|main|mod|lib|types|utils?)$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|rs|go|py)$/;
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1).)*\1/g;

// Findings the parser computed, plus the identifier and forwarding rules, limited to added lines.
export function parsedFindings(path: string, analysis: Analysis, file: ChangedFile): FileFinding[] {
  const findings: FileFinding[] = [];
  const deepEndByFunction = new Map<number | undefined, number>();
  const testFile = TEST_FILE.test(path);

  for (const finding of analysis.local) {
    if (!file.added.has(finding.line) || (testFile && finding.rule === "code-restraint/magic-number")) {
      continue;
    }

    if (finding.rule === "code-restraint/deep-nesting") {
      // Parsers list a statement before the ones nested in it, so of each added run of deep statements only the
      // outermost is reported and only the end of the last one reported matters. This is kept per function,
      // because nesting depth restarts in each one.
      const reportedEnd = deepEndByFunction.get(finding.functionId) ?? 0;

      if (finding.endLine <= reportedEnd) {
        continue;
      }

      deepEndByFunction.set(finding.functionId, finding.endLine);
    }

    findings.push({ path, ...finding });
  }

  const seen = new Set<string>();

  for (const identifier of analysis.identifiers) {
    const key = `${identifier.name}:${identifier.line}`;

    if (!file.added.has(identifier.line) || seen.has(key)) {
      continue;
    }

    seen.add(key);

    const span = {
      path,
      name: identifier.name,
      line: identifier.line,
      endLine: identifier.line,
      column: identifier.column,
    };

    const short =
      identifier.name.length <= SHORT_NAME_MAX_CHARS &&
      !SHORT_NAME_ALLOWED.has(identifier.name) &&
      !identifier.name.startsWith("_") &&
      !identifier.loopCounter &&
      !identifier.sortComparator;

    if (short) {
      findings.push({
        ...span,
        rule: "code-restraint/short-name",
        message: `\`${identifier.name}\` is too short to say what it holds.`,
      });
    }

    const ceremony = CEREMONY_SUFFIX.test(identifier.name) && identifier.kind !== "parameter";

    if (ceremony) {
      findings.push({
        ...span,
        rule: "code-restraint/ceremony-name",
        message: `\`${identifier.name}\` names a pattern, not a responsibility.`,
      });
    }

    const exempt =
      short ||
      ceremony ||
      identifier.name.length <= SHORT_NAME_MAX_CHARS ||
      identifier.name.startsWith("_") ||
      identifier.loopCounter ||
      identifier.sortComparator ||
      identifier.contextual ||
      identifier.nameFromProperty ||
      !GENERIC_NAME_KINDS.has(identifier.kind);

    const problem = exempt ? undefined : genericNameProblem(identifier);

    if (problem) {
      findings.push({
        ...span,
        rule: "code-restraint/generic-name",
        message: problem,
        suggestion: usefulSuggestion(identifier),
      });
    }
  }

  const byName = new Map(analysis.functions.filter((fn) => fn.name).map((fn) => [fn.name, fn]));

  for (const fn of analysis.functions) {
    const target = fn.single?.kind === "call" ? byName.get(fn.single.name) : undefined;

    if (!fn.name || !target || target === fn || target.single?.kind !== "call" || !file.added.has(fn.line)) {
      continue;
    }

    findings.push({
      path,
      rule: "refactor/forwarding-chain",
      name: fn.name,
      target: target.name,
      line: fn.line,
      endLine: fn.endLine,
      message: `\`${fn.name}\` only calls \`${target.name}\`, which only calls \`${target.single.name}\`.`,
    });
  }

  return findings;
}

// Needs no parser, so it runs on every language.
export function longLineFindings(path: string, file: ChangedFile, lines: string[]): FileFinding[] {
  const findings: FileFinding[] = [];
  lines.forEach((text, index) => {
    const line = index + 1;

    if (!file.added.has(line) || text.length < 110 || /^\s*(?:\/\/|\*|#|import\b)/.test(text)) {
      return;
    }

    const code = text.replace(STRING_LITERAL, "''");

    if ((code.match(/\(/g) ?? []).length >= 4) {
      findings.push({
        path,
        rule: "code-restraint/dense-line",
        line,
        endLine: line,
        message: "Several calls are compressed into one long line.",
      });
    }
  });

  return findings;
}

function normalizeLine(text: string): string {
  return text
    .replace(STRING_LITERAL, "S")
    .replace(/\b\d[\d_.]*\b/g, "N")
    .replace(/#?[A-Za-z_$][\w$]*/g, (word) => (KEYWORDS.has(word) ? word : "I"))
    .replace(/\s+/g, "");
}

// A line counts when it holds more than punctuation, an import, or a comment.
function significant(normalized: string, text: string): boolean {
  return normalized.length >= 6 && !/^\s*(?:import|export\s*\{|use\s|\/\/|\*|\/\*|#)/.test(text);
}

interface DuplicateWindow {
  path: string;
  start: number;
  end: number;
  index: number;
  added: boolean;
}

function windowsByText(files: LintedFile[], size: number): Map<string, DuplicateWindow[]> {
  const windows = new Map<string, DuplicateWindow[]>();

  for (const { file, lines } of files) {
    const rows: { line: number; normalized: string }[] = [];
    lines.forEach((text, index) => {
      const normalized = normalizeLine(text);

      if (significant(normalized, text)) {
        rows.push({ line: index + 1, normalized });
      }
    });

    for (let index = 0; index + size <= rows.length; index += 1) {
      const slice = rows.slice(index, index + size);
      const first = slice[0];
      const last = slice[slice.length - 1];
      // A run of same-shaped lines, such as object fields or an || chain, is a list rather than copied logic.
      const distinct = new Set(slice.map((row) => row.normalized)).size;

      if (last.line - first.line > size * 3 || distinct < 3) {
        continue;
      }

      const key = slice.map((row) => row.normalized).join("\n");
      const list = windows.get(key) ?? [];
      list.push({
        path: file.path,
        start: first.line,
        end: last.line,
        index,
        added: slice.some((row) => file.added.has(row.line)),
      });
      windows.set(key, list);
    }
  }

  return windows;
}

function overlaps(first: DuplicateWindow, second: DuplicateWindow): boolean {
  return first.path === second.path && first.start <= second.end && second.start <= first.end;
}

// Runs of `size` significant lines that match after renaming identifiers and literals, where one copy is added code.
export function duplicationFindings(files: LintedFile[], size: number): FileFinding[] {
  const pairs = new Map<string, { copy: DuplicateWindow; original: DuplicateWindow }>();

  for (const list of windowsByText(files, size).values()) {
    // Very common shapes, such as a run of similar imports or table rows, are not copies of one block.
    if (list.length < 2 || list.length > 6) {
      continue;
    }

    for (const copy of list.filter((window) => window.added)) {
      const original = list.find((window) => window !== copy && !overlaps(window, copy));

      if (!original) {
        continue;
      }

      // Consecutive windows of one copied block share an index offset, so they merge into one pair.
      const key = `${copy.path}|${original.path}|${copy.index - original.index}`;
      const pair = pairs.get(key) ?? { copy: { ...copy }, original: { ...original } };
      pair.copy.start = Math.min(pair.copy.start, copy.start);
      pair.copy.end = Math.max(pair.copy.end, copy.end);
      pair.original.start = Math.min(pair.original.start, original.start);
      pair.original.end = Math.max(pair.original.end, original.end);
      pairs.set(key, pair);
    }
  }

  const findings: FileFinding[] = [];
  const reported = new Set<string>();

  for (const { copy, original } of pairs.values()) {
    const key = `${copy.path}:${copy.start}`;

    if (reported.has(key)) {
      continue;
    }

    reported.add(key);
    findings.push({
      path: copy.path,
      rule: "refactor/duplication",
      line: copy.start,
      endLine: copy.end,
      message: `Lines ${copy.start}-${copy.end} repeat ${original.path}:${original.start}-${original.end} with only names or literals changed.`,
    });
  }

  return findings;
}

function fileStem(name: string): string {
  return name.replace(/\.(?:test|spec)?\.?[cm]?[jt]sx?$|\.(?:rs|go|py)$/, "").replace(/\.(?:test|spec)$/, "");
}

function namePrefix(name: string): string | undefined {
  const stem = fileStem(name);
  const dashed = /^([a-z0-9]+)[-_.]/i.exec(stem);

  if (dashed) {
    return dashed[1].toLowerCase();
  }

  const camel = /^([a-z]+[A-Z][a-z]+|[a-z]+)(?=[A-Z])/.exec(stem);

  return camel?.[1].toLowerCase();
}

export async function structureFindings(
  files: ChangedFile[],
  clusterSize: number,
  listDir: (dir: string) => Promise<string[]>,
): Promise<FileFinding[]> {
  const findings: FileFinding[] = [];
  const reported = new Set<string>();

  for (const file of files.filter((entry) => entry.status === "A")) {
    const directory = dirname(file.path);
    const name = basename(file.path);
    const layer = LAYER_DIR.exec(directory);

    if (layer && fileStem(name).endsWith(layer[1].replace(/s$/, ""))) {
      findings.push({
        path: file.path,
        rule: "refactor/structure-flat-cluster",
        line: 1,
        endLine: 1,
        message: `\`${name}\` repeats the layer folder name \`${layer[1]}/\`; group by primitive instead.`,
      });
    }

    const prefix = namePrefix(name);
    const key = `${directory}/${prefix}`;

    if (!prefix || GENERIC_PREFIX.test(prefix) || reported.has(key) || basename(directory).toLowerCase() === prefix) {
      continue;
    }

    const siblings = (await listDir(directory)).filter((sibling) => SOURCE_FILE.test(sibling));

    const cluster = siblings.filter((sibling) => {
      return namePrefix(sibling) === prefix || fileStem(sibling).toLowerCase() === prefix;
    });

    if (cluster.length < clusterSize) {
      continue;
    }

    reported.add(key);
    findings.push({
      path: file.path,
      rule: "refactor/structure-flat-cluster",
      line: 1,
      endLine: 1,
      message: `\`${name}\` joins ${cluster.length} files prefixed \`${prefix}\` in \`${directory}/\`.`,
      prefix,
    });
  }

  return findings;
}
