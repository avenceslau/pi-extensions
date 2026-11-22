import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { addCall, emptyAnalysis, mergeLineComments, type Analysis, type Comment } from "./analysis.ts";

const execFileAsync = promisify(execFile);

const SOURCE_DIR = join(import.meta.dirname, "rust-ast");
const SOURCE_FILES = ["Cargo.toml", "Cargo.lock", "src/main.rs"];
const CACHE_DIR = join(homedir(), ".cache", "pi-hygiene");
const BUILD_TIMEOUT_MS = 5 * 60_000;
const PARSE_TIMEOUT_MS = 30_000;
const RAW_STRING_START = /^r(#*)"/;
const CHAR_LITERAL = /^'(?:\\.|[^\\'])'/;
const HASH_CHARS = 16;

const RustItemSchema = Type.Object({
  kind: Type.String(),
  name: Type.Optional(Type.String()),
  line: Type.Integer(),
  endLine: Type.Optional(Type.Integer()),
  depth: Type.Optional(Type.Integer()),
  branches: Type.Optional(Type.Integer()),
  maxDepth: Type.Optional(Type.Integer()),
  singleCall: Type.Optional(Type.Boolean()),
  pub: Type.Optional(Type.Boolean()),
  functionId: Type.Optional(Type.Integer()),
  column: Type.Optional(Type.Integer()),
  valueType: Type.Optional(Type.Union([Type.Literal("boolean"), Type.Literal("number")])),
});

const RustItemsSchema = Type.Array(RustItemSchema);

type RustItem = Static<typeof RustItemSchema>;

let parserBuild: Promise<string> | undefined;

// The binary is cached by a hash of its sources, so an updated parser is rebuilt once and old builds are left alone.
async function buildParser(): Promise<string> {
  const hash = createHash("sha256");

  for (const file of SOURCE_FILES) {
    hash.update(await readFile(join(SOURCE_DIR, file)));
  }

  const binary = join(CACHE_DIR, `rust-ast-${hash.digest("hex").slice(0, HASH_CHARS)}`);

  if (existsSync(binary)) {
    return binary;
  }

  const targetDir = join(CACHE_DIR, "rust-ast-target");
  await mkdir(CACHE_DIR, { recursive: true });
  await execFileAsync(
    "cargo",
    [
      "build",
      "--release",
      "--offline",
      "--quiet",
      "--manifest-path",
      join(SOURCE_DIR, "Cargo.toml"),
      "--target-dir",
      targetDir,
    ],
    { timeout: BUILD_TIMEOUT_MS },
  );
  // Renamed into place so a concurrent run never executes a half-copied binary.
  const staging = `${binary}.${randomUUID()}`;
  await copyFile(join(targetDir, "release", "rust-ast"), staging);
  await rename(staging, binary);

  return binary;
}

// Rejects when cargo is missing or the dependencies are not in the local cargo cache; the caller skips Rust parsing then.
export function rustParser(): Promise<string> {
  parserBuild ??= buildParser();

  return parserBuild;
}

function lineCount(text: string): number {
  return text.match(/\n/g)?.length ?? 0;
}

function columnAt(source: string, index: number): number {
  return index - source.lastIndexOf("\n", index - 1);
}

// Returns the index of the closing quote of the string literal that opens at `start`, and the newlines inside it.
function skipString(source: string, start: number, raw: RegExpExecArray | null): { end: number; newlines: number } {
  const close = raw ? `"${raw[1]}` : '"';
  let cursor = start + (raw ? raw[0].length : 1);
  let newlines = 0;

  while (cursor < source.length && source.slice(cursor, cursor + close.length) !== close) {
    if (!raw && source[cursor] === "\\") {
      cursor += 1;
    }

    if (source[cursor] === "\n") {
      newlines += 1;
    }

    cursor += 1;
  }

  return { end: cursor + close.length - 1, newlines };
}

// syn drops comments, so they are lexed here, skipping string and character literals.
function rustComments(source: string): Comment[] {
  const comments: Comment[] = [];
  let line = 1;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === "\n") {
      line += 1;
      continue;
    }

    const raw = char === "r" ? RAW_STRING_START.exec(source.slice(index, index + 10)) : null;

    if (char === '"' || raw) {
      const skipped = skipString(source, index, raw);
      line += skipped.newlines;
      index = skipped.end;
      continue;
    }

    const charLiteral = char === "'" ? CHAR_LITERAL.exec(source.slice(index, index + 6)) : null;

    if (charLiteral) {
      index += charLiteral[0].length - 1;
      continue;
    }

    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      comments.push({
        line,
        endLine: line,
        column: columnAt(source, index),
        text: source.slice(index, stop),
      });
      index = stop - 1;
      continue;
    }

    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index);
      const stop = end === -1 ? source.length : end + 2;
      const text = source.slice(index, stop);
      comments.push({
        line,
        endLine: line + lineCount(text),
        column: columnAt(source, index),
        text,
      });
      line += lineCount(text);
      index = stop - 1;
    }
  }

  return mergeLineComments(comments);
}

function addItem(result: Analysis, item: RustItem): void {
  const name = item.name ?? "";

  const addIdentifier = (kind: string) => {
    result.identifiers.push({
      name,
      kind,
      line: item.line,
      column: item.column,
      functionLocal: kind === "parameter",
      loopCounter: false,
      sortComparator: false,
      constant: kind === "const",
      valueType: item.valueType,
    });
  };

  switch (item.kind) {
    case "fn":
      result.functions.push({
        name,
        line: item.line,
        endLine: item.endLine ?? item.line,
        branches: item.branches ?? 0,
        maxDepth: item.maxDepth ?? 0,
        single: item.singleCall ? { kind: "call" } : undefined,
        exported: item.pub ?? false,
      });

      return;
    case "function":
      addIdentifier("function");

      return;
    case "deep":
      result.local.push({
        rule: "code-restraint/deep-nesting",
        line: item.line,
        endLine: item.endLine ?? item.line,
        message: `Control flow is nested ${item.depth} levels deep.`,
        functionId: item.functionId,
      });

      return;
    case "magic":
      result.local.push({
        rule: "code-restraint/magic-number",
        line: item.line,
        endLine: item.line,
        column: item.column,
        message: `The literal ${name} has no name.`,
      });

      return;
    case "stmt":
      result.statements.push({
        line: item.line,
        endLine: item.endLine ?? item.line,
      });

      return;
    case "param":
      addIdentifier("parameter");

      return;
    case "let_underscore":
      result.local.push({
        rule: "code-restraint/swallowed-error",
        line: item.line,
        endLine: item.line,
        message: "`let _ =` discards a value that may be a Result.",
      });

      return;
    case "ident":
    case "type":
    case "const":
    case "field":
      addIdentifier(item.kind === "ident" ? "variable" : item.kind);
  }
}

// Undefined when syn cannot parse the file.
export async function analyzeRust(
  parser: string,
  source: string,
  nestingDepth: number,
): Promise<Analysis | undefined> {
  const child = execFileAsync(parser, [String(nestingDepth)], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: PARSE_TIMEOUT_MS,
  });

  child.child.stdin?.end(source);
  const { stdout } = await child;

  const items: unknown = JSON.parse(stdout);

  if (!Value.Check(RustItemsSchema, items)) {
    return undefined;
  }

  const result = emptyAnalysis();
  result.comments = rustComments(source);

  for (const item of items) {
    addItem(result, item);
  }

  const lines = source.split("\n");
  lines.forEach((text, index) => {
    if (/^\s*[^/]*\.ok\(\);\s*$/.test(text)) {
      result.local.push({
        rule: "code-restraint/swallowed-error",
        line: index + 1,
        endLine: index + 1,
        message: "`.ok();` discards the error.",
      });
    }
  });
  let line = 1;
  let counted = 0;

  for (const match of source.matchAll(/\b([a-z_]\w*)\s*\(/g)) {
    line += lineCount(source.slice(counted, match.index));
    counted = match.index;
    addCall(result.calls, match[1], line);
  }

  return result;
}
