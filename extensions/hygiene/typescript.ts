import ts from "typescript";
import {
  addCall,
  emptyAnalysis,
  mergeLineComments,
  TEST_FILE,
  type Analysis,
  type FunctionInfo,
  type Identifier,
  type LocalFinding,
} from "./analysis.ts";

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

const CONTROL_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
]);
const TOOL_COMMENT = /^\/\/\s*(?:@ts-|eslint|prettier|biome|oxlint|#region|#endregion)|^\/\/\/\s*<reference|^#!/;
const OPTION_TYPE_NAME = /(?:Options|Opts|Config|Configuration|Settings|Params|Parameters|Hooks)$/;
const SORT_METHOD = /^(?:sort|toSorted)$/;
const SLICE_METHOD = /^(?:slice|substring|substr|at)$/;
const EMPTY_HANDLER_BODY = /^(?:undefined|null|void 0|\{\}|false)$/;
const HAS_COMMENT = /\/\/|\/\*/;
const RADIX_METHOD = /^(?:parseInt|toString)$/;
const STRINGIFY_INDENT_POSITION = 2;
const ALL_CAPS = /^[A-Z][A-Z0-9_]+$/;
const ARITHMETIC_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
// Doubling and halving read as themselves; `x / 2` needs no name.
const HALVING_FACTORS = new Set([2, 0.5]);
const HALVING_OPERATORS = new Set([
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
]);
const RESULT_CALL = /^(?:get|fetch|load|read|find|parse|build|create|compute|make|resolve|lookup|collect|select)([A-Z]\w*)$/;
const QUALIFIER_SUFFIX = /(?:By|For|From|With|In|Of)[A-Z]\w*$/;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: FunctionLike): string | undefined {
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))) {
    return node.name.text;
  }

  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return undefined;
}

function singleStatement(node: FunctionLike): FunctionInfo["single"] {
  const body = node.body;
  if (!body) {
    return undefined;
  }

  let expression: ts.Expression | undefined;
  if (!ts.isBlock(body)) {
    expression = body;
  } else if (body.statements.length === 1) {
    const statement = body.statements[0];
    if (ts.isReturnStatement(statement) || ts.isExpressionStatement(statement)) {
      expression = statement.expression;
    }
  }
  while (expression && (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression))) {
    expression = expression.expression;
  }
  if (!expression) {
    return undefined;
  }

  if (!ts.isCallExpression(expression) && !ts.isNewExpression(expression)) {
    return { kind: "expression" };
  }
  // A call handed a function literal, such as new Promise((resolve) => ...), does its own work and is not forwarding.
  if (expression.arguments?.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) {
    return { kind: "expression" };
  }
  const callee = expression.expression;
  if (ts.isIdentifier(callee)) {
    return { kind: "call", name: callee.text };
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return { kind: "call", name: callee.name.text };
  }
  return { kind: "call" };
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function isExported(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isVariableStatement(current) || ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) {
      return hasExportModifier(current);
    }
    if (hasExportModifier(current)) {
      return true;
    }
  }
  return false;
}

function conditionClauses(node: ts.Expression): number {
  if (ts.isParenthesizedExpression(node)) {
    return conditionClauses(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return conditionClauses(node.left) + conditionClauses(node.right);
  }
  return 1;
}

function calleeName(node: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isNumericExpression(node: ts.Expression): boolean {
  const expression = unwrapExpression(node);
  if (ts.isNumericLiteral(expression)) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return ts.isNumericLiteral(expression.operand) || isNumericExpression(expression.operand);
  }
  if (!ts.isBinaryExpression(expression) || !ARITHMETIC_OPERATORS.has(expression.operatorToken.kind)) {
    return false;
  }
  const isNumericSide = (side: ts.Expression) => {
    return isNumericExpression(side) || (ts.isIdentifier(side) && ALL_CAPS.test(side.text));
  };
  return (
    isNumericSide(expression.left) &&
    isNumericSide(expression.right) &&
    (isNumericExpression(expression.left) || isNumericExpression(expression.right))
  );
}

function declaredValueType(
  type: ts.TypeNode | undefined,
  initializer: ts.Expression | undefined,
): "boolean" | "number" | undefined {
  if (type?.kind === ts.SyntaxKind.BooleanKeyword) {
    return "boolean";
  }
  if (type?.kind === ts.SyntaxKind.NumberKeyword) {
    return "number";
  }
  if (type || !initializer) {
    return undefined;
  }
  if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) {
    return "boolean";
  }
  return isNumericExpression(initializer) ? "number" : undefined;
}

function isTypeParameterName(node: ts.Node, name: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    const declared = "typeParameters" in current ? (current.typeParameters as ts.NodeArray<ts.TypeParameterDeclaration>) : undefined;
    if (declared?.some((parameter) => parameter.name.text === name)) {
      return true;
    }
  }
  return false;
}

function holdsAnyValue(type: ts.TypeNode | undefined): boolean {
  if (!type) {
    return false;
  }
  if (ts.isArrayTypeNode(type)) {
    return holdsAnyValue(type.elementType);
  }
  if (type.kind === ts.SyntaxKind.UnknownKeyword || type.kind === ts.SyntaxKind.AnyKeyword) {
    return true;
  }
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    !type.typeArguments &&
    isTypeParameterName(type, type.typeName.text)
  );
}

// `user` for `await fetchUserById(id)`, `parser` for `new Parser()`, `owner` for `repo.owner`.
function suggestedName(initializer: ts.Expression | undefined): string | undefined {
  if (!initializer) {
    return undefined;
  }
  const expression = unwrapExpression(initializer);
  let noun: string | undefined;
  if (ts.isCallExpression(expression)) {
    const callee = calleeName(expression);
    noun = callee ? RESULT_CALL.exec(callee)?.[1].replace(QUALIFIER_SUFFIX, "") : undefined;
  } else if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
    noun = expression.expression.text;
  } else if (ts.isPropertyAccessExpression(expression)) {
    noun = expression.name.text;
  }
  return noun ? noun[0].toLowerCase() + noun.slice(1) : undefined;
}

function isStatementLike(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isBlock(parent) || ts.isModuleBlock(parent)) {
    return true;
  }
  if (ts.isSourceFile(parent)) {
    return node.kind !== ts.SyntaxKind.EndOfFileToken;
  }
  if (ts.isCaseClause(parent)) {
    return node !== parent.expression;
  }
  if (ts.isDefaultClause(parent)) {
    return true;
  }
  return ts.isClassElement(node) || ts.isTypeElement(node) || ts.isEnumMember(node) || ts.isObjectLiteralElementLike(node);
}

// A literal is named when it is the value of a constant, property, parameter default or enum member.
function isNamedLiteral(literal: ts.Node): boolean {
  let current: ts.Node = literal;
  let passedThroughCall = false;
  while (current.parent) {
    const parent: ts.Node = current.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isPrefixUnaryExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      (ts.isBinaryExpression(parent) && ARITHMETIC_OPERATORS.has(parent.operatorToken.kind))
    ) {
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      passedThroughCall = true;
      current = parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const constant = (parent.parent.flags & ts.NodeFlags.Const) !== 0 || ALL_CAPS.test(parent.name.text);
      return constant && (!passedThroughCall || ALL_CAPS.test(parent.name.text));
    }
    if (passedThroughCall) {
      return false;
    }
    return (
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxExpression(parent) ||
      ts.isLiteralTypeNode(parent)
    );
  }
  return false;
}

// Indexes and slice offsets belong to magic-offset; radixes and JSON indentation read as themselves.
function isExemptArgument(literal: ts.NumericLiteral): boolean {
  const parent = literal.parent;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === literal) {
    return true;
  }
  if (!ts.isCallExpression(parent)) {
    return false;
  }
  const method = calleeName(parent) ?? "";
  const position = parent.arguments.indexOf(literal);
  if (SLICE_METHOD.test(method) || (RADIX_METHOD.test(method) && position === parent.arguments.length - 1)) {
    return true;
  }
  return method === "stringify" && position === STRINGIFY_INDENT_POSITION;
}

function optionTypeName(node: ts.PropertySignature | ts.PropertyDeclaration): string | undefined {
  const owner = node.parent;
  if (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) {
    return owner.name?.text;
  }
  if (ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent)) {
    return owner.parent.name.text;
  }
  return undefined;
}

export function analyzeTypeScript(path: string, source: string, nestingDepth: number): Analysis {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const sourceLines = source.split("\n");
  const lineOf = (position: number) => file.getLineAndCharacterOfPosition(position).line + 1;
  const columnOf = (position: number) => file.getLineAndCharacterOfPosition(position).character + 1;
  const result = emptyAnalysis();
  const isTest = TEST_FILE.test(path);
  const functionStack: FunctionInfo[] = [];

  // Comment ranges come from the AST, because a raw token scan gets them wrong after regex and template literals.
  const commentStarts = new Set<number>();
  const collectComments = (node: ts.Node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ];
    for (const range of ranges) {
      if (commentStarts.has(range.pos)) {
        continue;
      }
      commentStarts.add(range.pos);
      const text = source.slice(range.pos, range.end);
      if (TOOL_COMMENT.test(text)) {
        continue;
      }
      result.comments.push({
        line: lineOf(range.pos),
        endLine: lineOf(range.end),
        column: columnOf(range.pos),
        text,
      });
    }
    ts.forEachChild(node, collectComments);
  };
  collectComments(file);
  result.comments.sort((a, b) => a.line - b.line);
  result.comments = mergeLineComments(result.comments);

  const addLocal = (rule: string, node: ts.Node, message: string, endLine?: number) => {
    const start = node.getStart(file);
    const finding: LocalFinding = {
      rule,
      line: lineOf(start),
      endLine: endLine ?? lineOf(node.getEnd()),
      column: columnOf(start),
      message,
    };
    result.local.push(finding);
    return finding;
  };

  const addIdentifier = (
    nameNode: ts.Node | undefined,
    declarationKind: string,
    properties: Partial<Omit<Identifier, "name" | "kind" | "line" | "column">> = {},
  ) => {
    if (!nameNode || !ts.isIdentifier(nameNode)) {
      return;
    }
    const start = nameNode.getStart(file);
    result.identifiers.push({
      ...properties,
      name: nameNode.text,
      kind: declarationKind,
      line: lineOf(start),
      column: columnOf(start),
      functionLocal: properties.functionLocal ?? false,
      loopCounter: properties.loopCounter ?? false,
      sortComparator: properties.sortComparator ?? false,
    });
  };

  const addKnob = (name: string, knobKind: string, node: ts.Node) => {
    result.knobs.push({
      name,
      kind: knobKind,
      line: lineOf(node.getStart(file)),
      endLine: lineOf(node.getEnd()),
    });
  };

  const checkSameLineBody = (header: ts.Node, body: ts.Statement | undefined) => {
    if (!body || ts.isIfStatement(body)) {
      return;
    }
    if (!ts.isBlock(body)) {
      addLocal(
        "code-restraint/same-line-body",
        header,
        "The control-flow body is not braced on its own line.",
        lineOf(body.getEnd()),
      );
      return;
    }
    const first = body.statements[0];
    if (first && lineOf(first.getStart(file)) === lineOf(body.getStart(file))) {
      addLocal(
        "code-restraint/same-line-body",
        header,
        "The control-flow body shares a line with its header.",
        lineOf(body.getEnd()),
      );
    }
  };

  const onOneLine = (node: ts.Node) => lineOf(node.getStart(file)) === lineOf(node.getEnd());

  const visitFunction = (node: FunctionLike) => {
    const name = functionName(node);
    const info: FunctionInfo = {
      name,
      line: lineOf(node.getStart(file)),
      endLine: lineOf(node.getEnd()),
      branches: 0,
      maxDepth: 0,
      single: singleStatement(node),
      exported: isExported(node),
    };
    result.functions.push(info);
    functionStack.push(info);

    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      addIdentifier(node.name, "function");
    }
    const sortComparator =
      ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      SORT_METHOD.test(node.parent.expression.name.text);
    const callback =
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent));
    for (const parameter of node.parameters) {
      addIdentifier(parameter.name, "parameter", {
        functionLocal: true,
        sortComparator,
        contextual: callback || ts.isSetAccessorDeclaration(node),
        valueType: declaredValueType(parameter.type, parameter.initializer),
        holdsAnyValue: holdsAnyValue(parameter.type),
      });
      if (parameter.initializer) {
        addKnob(parameter.name.getText(file), "default parameter", parameter);
      } else if (parameter.questionToken) {
        addKnob(parameter.name.getText(file), "optional parameter", parameter);
      }
    }
    for (const parameter of node.typeParameters ?? []) {
      addKnob(parameter.name.text, "generic type parameter", parameter);
    }

    if (!ts.isArrowFunction(node) && node.parameters.length > 0) {
      const header = lineOf(node.getStart(file));
      const headerEnd = node.body ? lineOf(node.body.getStart(file)) : lineOf(node.getEnd());
      const text = sourceLines[header - 1] ?? "";
      if (header === headerEnd && text.length >= 100 && (node.parameters.length >= 2 || node.type)) {
        addLocal(
          "code-restraint/dense-line",
          node.name ?? node,
          "The signature packs its parameters and return type onto one long line.",
          header,
        );
      }
    }

    ts.forEachChild(node, (child) => visit(child, 0));
    functionStack.pop();
  };

  const visitControl = (node: ts.Node, depth: number): number => {
    const owner = functionStack.at(-1);
    const isElseIf = ts.isIfStatement(node) && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
    const childDepth = isElseIf ? depth : depth + 1;
    if (owner) {
      owner.branches += 1;
      owner.maxDepth = Math.max(owner.maxDepth, childDepth);
    }
    if (childDepth >= nestingDepth) {
      const finding = addLocal(
        "code-restraint/deep-nesting",
        node,
        `Control flow is nested ${childDepth} levels deep in ${owner?.name ?? "this function"}.`,
      );
      finding.functionId = ts.findAncestor(node.parent, isFunctionLike)?.getStart(file);
    }
    if (isTest && owner && (ts.isIfStatement(node) || ts.isTryStatement(node))) {
      result.testBranches.push({
        line: lineOf(node.getStart(file)),
        endLine: lineOf(node.getEnd()),
        kind: ts.isIfStatement(node) ? "if" : "try/catch",
      });
    }
    return childDepth;
  };

  const visitLayout = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      checkSameLineBody(node, node.thenStatement);
      checkSameLineBody(node, node.elseStatement);
      const clauses = conditionClauses(node.expression);
      if (clauses >= 3 && onOneLine(node.expression)) {
        addLocal("code-restraint/dense-line", node.expression, `A ${clauses}-clause condition is on one line.`);
      }
    }
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      checkSameLineBody(node, node.statement);
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      (node.arguments?.length ?? 0) >= 3 &&
      onOneLine(node) &&
      node.getText(file).length >= 60
    ) {
      addLocal("code-restraint/dense-line", node, `A call with ${node.arguments?.length} arguments is on one line.`);
    }
    if ((ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) && node.elements.length >= 4 && onOneLine(node)) {
      addLocal("code-restraint/dense-line", node, `A destructuring of ${node.elements.length} fields is on one line.`);
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.length >= 3 && onOneLine(node)) {
      addLocal("code-restraint/dense-line", node, `An object literal with ${node.properties.length} fields is on one line.`);
    }
  };

  const visitErrorHandling = (node: ts.Node) => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      const inner = source.slice(node.block.getStart(file) + 1, node.block.getEnd() - 1);
      if (!HAS_COMMENT.test(inner)) {
        addLocal("code-restraint/swallowed-error", node, "The catch block is empty, so the error is dropped silently.");
      }
    }
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "catch" ||
      node.arguments.length !== 1
    ) {
      return;
    }
    const handler = node.arguments[0];
    if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) {
      return;
    }
    const body = handler.body;
    const empty = ts.isBlock(body)
      ? body.statements.length === 0 && !HAS_COMMENT.test(body.getText(file))
      : EMPTY_HANDLER_BODY.test(body.getText(file));
    // A comment on the line of the .catch or the line above says why the error does not matter.
    const line = lineOf(node.expression.name.getStart(file));
    const explained = [sourceLines[line - 2], sourceLines[line - 1]].some((text) => text?.includes("//"));
    if (empty && !explained) {
      addLocal("code-restraint/swallowed-error", node.expression.name, "`.catch` discards the error.", lineOf(node.getEnd()));
    }
  };

  const visitOffsets = (node: ts.Node) => {
    if (isTest) {
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isNumericLiteral(node.argumentExpression) &&
      Number(node.argumentExpression.text) >= 2
    ) {
      addLocal("code-restraint/magic-offset", node, `Indexing with the literal ${node.argumentExpression.text}.`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      SLICE_METHOD.test(node.expression.name.text)
    ) {
      const literal = node.arguments.find((argument) => {
        const text = argument.getText(file);
        return /^-?\d+$/.test(text) && Math.abs(Number(text)) >= 2;
      });
      if (literal) {
        addLocal(
          "code-restraint/magic-offset",
          node,
          `\`${node.expression.name.text}\` with the literal ${literal.getText(file)}.`,
        );
      }
    }
  };

  const visitNumbers = (node: ts.Node) => {
    if (isTest || !ts.isNumericLiteral(node)) {
      return;
    }
    const magnitude = Math.abs(Number(node.text.replaceAll("_", "")));
    const parent = node.parent;
    const halving =
      HALVING_FACTORS.has(magnitude) &&
      ts.isBinaryExpression(parent) &&
      HALVING_OPERATORS.has(parent.operatorToken.kind);
    if (magnitude === 0 || magnitude === 1 || halving || isExemptArgument(node) || isNamedLiteral(node)) {
      return;
    }
    const negative = ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.MinusToken;
    addLocal("code-restraint/magic-number", node, `The literal ${negative ? "-" : ""}${node.getText(file)} has no name.`);
  };

  const visitDeclarations = (node: ts.Node) => {
    const insideFunction = functionStack.length > 0;
    if (ts.isVariableDeclaration(node)) {
      const statement = node.parent.parent;
      const loopCounter =
        ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isForInStatement(statement);
      const constant = (node.parent.flags & ts.NodeFlags.Const) !== 0;
      if (!ts.isIdentifier(node.name)) {
        const elements: readonly ts.ArrayBindingElement[] = node.name.elements;
        for (const element of elements.filter(ts.isBindingElement)) {
          addIdentifier(element.name, "variable", {
            functionLocal: insideFunction,
            loopCounter,
            constant,
            nameFromProperty: ts.isObjectBindingPattern(node.name) && !element.propertyName,
          });
        }
        return;
      }
      const initializer = node.initializer;
      const holdsFunction = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
      addIdentifier(node.name, holdsFunction ? "function" : "variable", {
        functionLocal: insideFunction && !holdsFunction,
        loopCounter,
        constant,
        valueType: declaredValueType(node.type, initializer),
        holdsAnyValue: holdsAnyValue(node.type),
        suggestion: suggestedName(initializer),
      });
      const isModuleConstant =
        !insideFunction &&
        ALL_CAPS.test(node.name.text) &&
        initializer &&
        (ts.isNumericLiteral(initializer) || ts.isStringLiteral(initializer) || ts.isObjectLiteralExpression(initializer));
      if (isModuleConstant) {
        addKnob(node.name.text, "module constant", node);
      }
      return;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addIdentifier(node.variableDeclaration.name, "catch", { functionLocal: true, loopCounter: true });
      return;
    }
    if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      addIdentifier(node.name, "type");
      return;
    }
    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)) {
      addIdentifier(node.name, "property");
      // Optional fields of data shapes are not knobs; only fields of option and config types are.
      const owner = optionTypeName(node);
      if (node.questionToken && owner && OPTION_TYPE_NAME.test(owner)) {
        addKnob(node.name.text, "optional property", node);
      }
    }
  };

  const visitCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node);
      if (name) {
        addCall(result.calls, name, lineOf(node.getStart(file)));
      }
    }
    // A function passed by reference is also a use.
    if (ts.isIdentifier(node) && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)) {
      addCall(result.calls, node.text, lineOf(node.getStart(file)));
    }
  };

  const visit = (node: ts.Node, depth: number) => {
    if (isStatementLike(node)) {
      result.statements.push({
        line: lineOf(node.getStart(file)),
        endLine: lineOf(node.getEnd()),
      });
    }
    if (isFunctionLike(node)) {
      visitFunction(node);
      return;
    }

    const owner = functionStack.at(-1);
    let childDepth = depth;
    if (CONTROL_KINDS.has(node.kind)) {
      childDepth = visitControl(node, depth);
    }
    if (owner && (ts.isCaseClause(node) || ts.isConditionalExpression(node) || ts.isCatchClause(node))) {
      owner.branches += 1;
    }
    visitLayout(node);
    visitErrorHandling(node);
    visitOffsets(node);
    visitNumbers(node);
    visitDeclarations(node);
    visitCalls(node);
    ts.forEachChild(node, (child) => visit(child, childDepth));
  };
  visit(file, 0);

  return result;
}
