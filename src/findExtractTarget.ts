import ts from "typescript";

export interface Selection {
  start: number;
  end: number;
}

export type HookKind = "useMemo" | "useCallback";

export interface ExtractTarget {
  reactiveFunction: ts.FunctionLikeDeclaration;
  statement: ts.Statement;
  declaration: ts.VariableDeclaration | ts.FunctionDeclaration;
  hook: HookKind;
  callback: ts.Node;
}

export function findExtractTarget(
  sourceFile: ts.SourceFile,
  selection: Selection,
): ExtractTarget | undefined {
  let found: ExtractTarget | undefined;
  const visit = (node: ts.Node) => {
    const target = targetForNode(sourceFile, node, selection);
    if (target) found = target;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function targetForNode(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  selection: Selection,
): ExtractTarget | undefined {
  if (ts.isFunctionDeclaration(node)) {
    if (!node.name || !overlaps(selection, functionSpan(sourceFile, node))) return undefined;
    return finish(node, node);
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (!overlaps(selection, spanOf(node.name))) return undefined;
    const statement = statementOf(node);
    if (!statement || !ts.isVariableStatement(statement)) return undefined;
    return finish(node, statement);
  }
  return undefined;
}

function finish(
  declaration: ts.VariableDeclaration | ts.FunctionDeclaration,
  statement: ts.Statement,
): ExtractTarget | undefined {
  if (isInsideClass(declaration)) return undefined;
  const reactive = nearestReactive(statement);
  if (!reactive || reactive === declaration) return undefined;
  if (!reactive.body || !ts.isBlock(reactive.body) || statement.parent !== reactive.body) return undefined;
  if (precedingExit(reactive.body, statement)) return undefined;

  if (ts.isFunctionDeclaration(declaration)) {
    if (declaration.asteriskToken || !declaration.body || hasOverload(reactive.body, declaration)) return undefined;
    if (containsHookCall(declaration.body)) return undefined;
    return { reactiveFunction: reactive, statement, declaration, hook: "useCallback", callback: declaration };
  }

  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return undefined;
  const kind = list.flags & ts.NodeFlags.Const || list.flags & ts.NodeFlags.Let;
  if (!kind) return undefined;
  const initializer = declaration.initializer;
  if (!initializer) return undefined;
  if (isGenerator(initializer) || containsHookCall(initializer)) return undefined;
  const hook: HookKind = isCallbackInitializer(initializer) ? "useCallback" : "useMemo";
  return {
    reactiveFunction: reactive,
    statement,
    declaration,
    hook,
    callback: initializer,
  };
}

function functionSpan(sourceFile: ts.SourceFile, fn: ts.FunctionDeclaration): { start: number; end: number } {
  const keyword = sourceFile.text.indexOf("function", fn.getStart(sourceFile));
  const start = keyword === -1 ? fn.getStart(sourceFile) : keyword;
  const end = fn.name ? fn.name.getEnd() : start + "function".length;
  return { start, end };
}

function spanOf(name: ts.BindingName): { start: number; end: number } {
  return { start: name.getStart(), end: name.getEnd() };
}

function overlaps(selection: Selection, span: { start: number; end: number }): boolean {
  if (selection.start === selection.end) {
    return span.start <= selection.start && selection.start <= span.end;
  }
  return selection.start < span.end && selection.end > span.start;
}

function statementOf(declaration: ts.VariableDeclaration): ts.Statement | undefined {
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return undefined;
  const statement = list.parent;
  return ts.isVariableStatement(statement) ? statement : undefined;
}

function isInsideClass(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isClassLike(current)) return true;
    current = current.parent;
  }
  return false;
}

function nearestReactive(statement: ts.Statement): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = statement.parent;
  while (current) {
    if (isFunctionLike(current) && isReactive(current)) {
      if (current.body && ts.isBlock(current.body) && statement.parent === current.body) return current;
      if (isInside(statement, current)) return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function isReactive(fn: ts.FunctionLikeDeclaration): boolean {
  if (isInsideClass(fn)) return false;
  const name = ownName(fn) ?? assignedName(fn);
  if (name && (/^[A-Z]/.test(name) || /^use[A-Z0-9]/.test(name))) return true;
  if (ts.isFunctionDeclaration(fn) && !fn.name && hasModifier(fn, ts.SyntaxKind.ExportKeyword) && hasModifier(fn, ts.SyntaxKind.DefaultKeyword)) {
    return true;
  }
  return isFunctionPassedToMemo(fn);
}

function ownName(fn: ts.FunctionLikeDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  return undefined;
}

function assignedName(fn: ts.Node): string | undefined {
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === fn) {
    return parent.name.text;
  }
  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isFunctionPassedToMemo(fn: ts.Node): boolean {
  const parent = fn.parent;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== fn) return false;
  return isMemoCallee(parent.expression);
}

function isMemoCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "memo" || expr.text === "forwardRef";
  if (
    ts.isPropertyAccessExpression(expr) &&
    !("questionDot" in expr && expr.questionDot) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "React" &&
    ts.isIdentifier(expr.name)
  ) {
    return expr.name.text === "memo" || expr.name.text === "forwardRef";
  }
  return false;
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function precedingExit(body: ts.Block, statement: ts.Statement): boolean {
  const index = body.statements.indexOf(statement);
  for (let i = 0; i < index; i++) {
    if (exitsOutsideNestedFunction(body.statements[i]!)) return true;
  }
  return false;
}

function exitsOutsideNestedFunction(root: ts.Node): boolean {
  if (ts.isReturnStatement(root) || ts.isThrowStatement(root)) return true;
  if (isFunctionLike(root)) return false;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

function hasOverload(body: ts.Block, fn: ts.FunctionDeclaration): boolean {
  if (!fn.body || !fn.name) return !fn.body;
  const index = body.statements.indexOf(fn);
  for (let i = 0; i < index; i++) {
    const sibling = body.statements[i];
    if (ts.isFunctionDeclaration(sibling) && sibling.name?.text === fn.name.text && !sibling.body) return true;
  }
  return false;
}

function isGenerator(initializer: ts.Expression): boolean {
  return ts.isFunctionExpression(initializer) && !!initializer.asteriskToken;
}

function isCallbackInitializer(initializer: ts.Expression): boolean {
  return ts.isArrowFunction(initializer) || (ts.isFunctionExpression(initializer) && !initializer.asteriskToken);
}

function containsHookCall(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && isHookCallee(unwrapExpression(node.expression))) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  const unwrapped = ts.isExpression(root) ? unwrapExpression(root) : root;
  if (ts.isCallExpression(unwrapped) && isHookCallee(unwrapExpression(unwrapped.expression))) return true;
  visit(root);
  return found;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.expression;
  return current;
}

function isHookCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return /^use[A-Z]/.test(expr.text);
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "React" &&
    ts.isIdentifier(expr.name)
  ) {
    return /^use[A-Z]/.test(expr.name.text);
  }
  return false;
}
