import { mergeLineComments, type Analysis, type Comment, type FunctionInfo, type Span } from "./analysis.ts";
import { countAdded, type ChangedFile } from "./diff.ts";

// How much of the code around a comment its candidate shows; the reviewer can read the file for more.
const COMMENT_CONTEXT_BEFORE_LINES = 12;
const COMMENT_CONTEXT_AFTER_LINES = 30;
const COMMENT_CONTEXT_MIN_AFTER_LINES = 8;
// A comment inside a longer statement, such as a whole function, is too far from most of its lines to describe them.
const STALE_COMMENT_MAX_STATEMENT_LINES = 60;
const HASH_COMMENT_FILE = /\.(?:py|rb|sh|bash)$/;
const LUA_FILE = /\.lua$/;
const TRIPLE_QUOTES = ['"""', "'''"];
const QUOTES = new Set(['"', "'", "`"]);

export interface CommentCandidate {
  path: string;
  line: number;
  endLine: number;
  column: number;
  text: string;
  // added: this change wrote the comment. stale: it left the comment as it was next to code it edited.
  change: "added" | "stale";
  // The enclosing function or statement, clamped around the comment.
  contextStart: number;
  contextLines: string[];
  // For a stale comment, the lines this change edited inside the context.
  editedLines?: string;
}

interface LineRange {
  start: number;
  end: number;
}

interface CommentSyntax {
  line: string;
  block?: [string, string];
  // Shell `$#` and `${#name}` are not comments, so `#` starts one only at the start of a line or after a space.
  lineAfterSpace?: boolean;
}

const C_SYNTAX: CommentSyntax = {
  line: "//",
  block: ["/*", "*/"],
};
const HASH_SYNTAX: CommentSyntax = {
  line: "#",
  lineAfterSpace: true,
};
const LUA_SYNTAX: CommentSyntax = {
  line: "--",
  block: ["--[[", "]]"],
};

function syntaxFor(path: string): CommentSyntax {
  if (HASH_COMMENT_FILE.test(path)) {
    return HASH_SYNTAX;
  }
  return LUA_FILE.test(path) ? LUA_SYNTAX : C_SYNTAX;
}

function lineCount(text: string): number {
  return text.match(/\n/g)?.length ?? 0;
}

// The index just past the string literal that opens at `start`: triple-quoted and backtick strings may span lines,
// the others end at the closing quote or the end of the line.
function stringEnd(source: string, start: number): number {
  const triple = TRIPLE_QUOTES.find((quote) => source.startsWith(quote, start));
  if (triple) {
    const close = source.indexOf(triple, start + triple.length);
    return close === -1 ? source.length : close + triple.length;
  }

  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    if (source[index] === "\n" && quote !== "`") {
      return index;
    }
  }
  return source.length;
}

function lineCommentStarts(source: string, index: number, syntax: CommentSyntax): boolean {
  if (!source.startsWith(syntax.line, index)) {
    return false;
  }
  return !syntax.lineAfterSpace || index === 0 || /\s/.test(source[index - 1]);
}

// For languages without a parser: comments outside string literals, with consecutive line comments merged.
export function lexComments(path: string, source: string): Comment[] {
  const syntax = syntaxFor(path);
  const comments: Comment[] = [];
  let line = 1;
  let lineStart = 0;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\n") {
      line += 1;
      index += 1;
      lineStart = index;
      continue;
    }

    if (QUOTES.has(char)) {
      const end = stringEnd(source, index);
      const text = source.slice(index, end);
      if (text.includes("\n")) {
        line += lineCount(text);
        lineStart = index + text.lastIndexOf("\n") + 1;
      }
      index = end;
      continue;
    }

    const [open, close] = syntax.block ?? [];
    let end: number | undefined;
    if (open && close && source.startsWith(open, index)) {
      const found = source.indexOf(close, index + open.length);
      end = found === -1 ? source.length : found + close.length;
    } else if (lineCommentStarts(source, index, syntax)) {
      const found = source.indexOf("\n", index);
      end = found === -1 ? source.length : found;
    }
    if (end === undefined) {
      index += 1;
      continue;
    }

    const text = source.slice(index, end);
    comments.push({
      line,
      endLine: line + lineCount(text),
      column: index - lineStart + 1,
      text,
    });
    if (text.includes("\n")) {
      line += lineCount(text);
      lineStart = index + text.lastIndexOf("\n") + 1;
    }
    index = end;
  }
  return mergeLineComments(comments);
}

// The outermost statement that starts on the comment's last line or the line after it.
function statementBelow(comment: Comment, statements: Span[]): Span | undefined {
  let below: Span | undefined;
  for (const statement of statements) {
    const startsNext = statement.line >= comment.line && statement.line <= comment.endLine + 1;
    const longer = !below || statement.endLine > below.endLine;
    if (
      startsNext &&
      statement.endLine > comment.endLine &&
      longer
    ) {
      below = statement;
    }
  }
  return below;
}

function innermostAround(comment: Comment, spans: Span[]): Span | undefined {
  let around: Span | undefined;
  for (const span of spans) {
    const encloses = span.line < comment.line && span.endLine >= comment.endLine;
    const shorter = !around || span.endLine - span.line < around.endLine - around.line;
    if (encloses && shorter) {
      around = span;
    }
  }
  return around;
}

// The enclosing function or block and the statement under the comment, clamped around the comment.
function commentContext(comment: Comment, analysis: Analysis | undefined): LineRange {
  const functions: FunctionInfo[] = analysis?.functions ?? [];
  const statements = analysis?.statements ?? [];
  const around = innermostAround(comment, functions) ?? innermostAround(comment, statements);
  const below = statementBelow(comment, statements);
  const scopeStart = around?.line ?? comment.line;
  const scopeEnd = Math.max(
    around?.endLine ?? 0,
    below?.endLine ?? 0,
    comment.endLine + COMMENT_CONTEXT_MIN_AFTER_LINES,
  );
  return {
    start: Math.max(scopeStart, comment.line - COMMENT_CONTEXT_BEFORE_LINES),
    end: Math.min(scopeEnd, comment.endLine + COMMENT_CONTEXT_AFTER_LINES),
  };
}

function lineRanges(lines: number[]): string {
  const ranges: string[] = [];
  let start = lines[0];
  lines.forEach((line, index) => {
    if (lines[index + 1] === line + 1) {
      return;
    }
    ranges.push(start === line ? `${line}` : `${start}-${line}`);
    start = lines[index + 1];
  });
  return ranges.join(", ");
}

// The statement an unchanged comment sits over, or inside when that statement is short, if this change edited it.
function staleContext(
  comment: Comment,
  file: ChangedFile,
  analysis: Analysis,
): (LineRange & { edited: number[] }) | undefined {
  const below = statementBelow(comment, analysis.statements);
  const around = innermostAround(comment, analysis.statements);
  const statement =
    below ?? (around && around.endLine - around.line < STALE_COMMENT_MAX_STATEMENT_LINES ? around : undefined);
  if (!statement) {
    return undefined;
  }

  const start = Math.max(statement.line, comment.line - COMMENT_CONTEXT_BEFORE_LINES);
  const end = Math.min(statement.endLine, comment.endLine + COMMENT_CONTEXT_AFTER_LINES);
  const edited: number[] = [];
  for (let line = start; line <= end; line += 1) {
    if (file.added.has(line)) {
      edited.push(line);
    }
  }
  if (edited.length === 0) {
    return undefined;
  }
  return {
    start,
    end,
    edited,
  };
}

function candidate(
  path: string,
  comment: Comment,
  lines: string[],
  context: LineRange,
  change: CommentCandidate["change"],
): CommentCandidate {
  const start = Math.max(1, Math.min(context.start, comment.line));
  return {
    path,
    line: comment.line,
    endLine: comment.endLine,
    column: comment.column,
    text: comment.text,
    change,
    contextStart: start,
    contextLines: lines.slice(start - 1, Math.min(lines.length, context.end)),
  };
}

// Every comment with an added line, and, in parsed files that existed before, unchanged comments over or inside edited statements.
export function commentCandidates(
  path: string,
  file: ChangedFile,
  lines: string[],
  analysis: Analysis | undefined,
): CommentCandidate[] {
  const comments = analysis?.comments ?? lexComments(path, lines.join("\n"));
  const candidates: CommentCandidate[] = [];
  for (const comment of comments) {
    if (countAdded(file.added, comment.line, comment.endLine) > 0) {
      const context = commentContext(comment, analysis);
      candidates.push(candidate(path, comment, lines, context, "added"));
      continue;
    }
    const stale = analysis && file.status !== "A" ? staleContext(comment, file, analysis) : undefined;
    if (stale) {
      candidates.push({
        ...candidate(path, comment, lines, stale, "stale"),
        editedLines: lineRanges(stale.edited),
      });
    }
  }
  return candidates;
}
