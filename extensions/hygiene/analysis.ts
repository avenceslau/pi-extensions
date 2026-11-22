// What a language parser extracts from one file. Lines are 1-based; columns are 1-based and only set
// when the parser knows the exact start of a span.

export interface FunctionInfo {
  name?: string;
  line: number;
  endLine: number;
  branches: number;
  maxDepth: number;
  // Set when the body is one statement: a call (with the callee's name, when it has one) or an expression.
  single?: {
    kind: "call" | "expression";
    name?: string;
  };
  exported: boolean;
}

export interface Comment {
  line: number;
  endLine: number;
  column: number;
  text: string;
}

export interface Identifier {
  name: string;
  kind: string;
  line: number;
  column?: number;
  // Parameters, catch bindings, and variables declared inside a function.
  functionLocal: boolean;
  loopCounter: boolean;
  sortComparator: boolean;
  // Declared with const, or a Rust const.
  constant?: boolean;
  // Set only when the declaration shows the type: an annotation, or a literal initializer.
  valueType?: "boolean" | "number";
  // Parameters of inline callbacks and setters, whose meaning the call around them gives.
  contextual?: boolean;
  // Typed unknown, any or a type parameter, so a generic name such as `value` is accurate.
  holdsAnyValue?: boolean;
  // A destructured binding that keeps the property's name.
  nameFromProperty?: boolean;
  // A name the initializer makes obvious, such as `user` for `await fetchUser(id)`.
  suggestion?: string;
}

export interface Span {
  line: number;
  endLine: number;
}

export interface Knob {
  name: string;
  kind: string;
  line: number;
  endLine: number;
}

export interface TestBranch {
  line: number;
  endLine: number;
  kind: string;
}

export interface LocalFinding {
  rule: string;
  line: number;
  endLine: number;
  column?: number;
  message: string;
  // Values for the trait's fix template.
  name?: string;
  target?: string;
  prefix?: string;
  suggestion?: string;
  // Identifies the innermost function around a deep-nesting finding, unique within the file.
  functionId?: number;
}

export interface Analysis {
  functions: FunctionInfo[];
  identifiers: Identifier[];
  knobs: Knob[];
  comments: Comment[];
  testBranches: TestBranch[];
  // Statements, declarations and members, for finding the code next to a comment.
  statements: Span[];
  local: LocalFinding[];
  // Callee name to the lines that call it or pass it by reference.
  calls: Map<string, number[]>;
}

export const TEST_FILE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)tests?\/|_test\.(?:go|py|rs)$)/;

export function emptyAnalysis(): Analysis {
  return {
    functions: [],
    identifiers: [],
    knobs: [],
    comments: [],
    testBranches: [],
    statements: [],
    local: [],
    calls: new Map(),
  };
}

export function addCall(
  calls: Map<string, number[]>,
  name: string,
  line: number,
): void {
  const lines = calls.get(name) ?? [];
  lines.push(line);
  calls.set(name, lines);
}

const LINE_COMMENT_MARKER = /^(?:\/\/|#|--)/;

// Runs of single-line comments on consecutive lines at the same column read as one comment.
export function mergeLineComments(comments: Comment[]): Comment[] {
  const merged: Comment[] = [];

  for (const comment of comments) {
    const previous = merged.at(-1);
    const marker = LINE_COMMENT_MARKER.exec(comment.text)?.[0];

    if (
      previous &&
      marker &&
      previous.text.startsWith(marker) &&
      comment.line === previous.endLine + 1 &&
      comment.column === previous.column
    ) {
      previous.text += `\n${comment.text}`;
      previous.endLine = comment.line;
      continue;
    }

    merged.push({ ...comment });
  }

  return merged;
}
