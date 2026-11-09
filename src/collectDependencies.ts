import ts from "typescript";
import type { ExtractTarget } from "./findExtractTarget.js";

interface Scope {
  parent?: Scope;
  bindings: Map<string, ts.Node>;
}

interface Reference {
  ident: ts.Identifier;
  decl: ts.Node;
  write: boolean;
}

export function collectDependencies(sourceFile: ts.SourceFile, target: ExtractTarget): string[] {
  const references = collectReferences(sourceFile);
  const hits: Array<{ key: string; pos: number }> = [];
  for (const reference of references) {
    if (!isInside(reference.ident, target.callback)) continue;
    if (isDeclaredInsideCallback(reference.decl, target.callback)) continue;
    if (!isInside(reference.decl, target.reactiveFunction)) continue;
    if (isStable(reference.decl, target.reactiveFunction, references)) continue;
    const key = dependencyKey(reference.ident);
    if (!key) continue;
    hits.push({ key, pos: reference.ident.getStart(sourceFile) });
  }
  return reduce(hits);
}

function collectReferences(sourceFile: ts.SourceFile): Reference[] {
  const references: Reference[] = [];
  const moduleScope: Scope = { bindings: new Map() };
  bindModule(moduleScope, sourceFile);
  for (const statement of sourceFile.statements) visit(statement, moduleScope, references);
  return references;
}

function visit(node: ts.Node, scope: Scope, references: Reference[]): void {
  if (isFunctionLike(node)) {
    const functionScope: Scope = { parent: scope, bindings: new Map() };
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) {
      functionScope.bindings.set(node.name.text, node.name);
    }
    for (const parameter of node.parameters) bindBindingName(functionScope, parameter.name);
    if (node.body) bindFunctionVars(functionScope, node.body);
    for (const parameter of node.parameters) {
      if (parameter.initializer) visit(parameter.initializer, functionScope, references);
    }
    if (node.body && ts.isBlock(node.body)) {
      const blockScope: Scope = { parent: functionScope, bindings: new Map() };
      bindBlock(blockScope, node.body);
      for (const statement of node.body.statements) visit(statement, blockScope, references);
      return;
    }
    if (node.body) visit(node.body, functionScope, references);
    return;
  }
  if (ts.isBlock(node)) {
    const blockScope: Scope = { parent: scope, bindings: new Map() };
    bindBlock(blockScope, node);
    for (const statement of node.statements) visit(statement, blockScope, references);
    return;
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const loopScope: Scope = { parent: scope, bindings: new Map() };
    if (ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations)
        bindBindingName(loopScope, declaration.name);
    }
    visit(node.expression, scope, references);
    visit(node.statement, loopScope, references);
    return;
  }
  if (ts.isForStatement(node)) {
    const loopScope: Scope = { parent: scope, bindings: new Map() };
    if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations)
        bindBindingName(loopScope, declaration.name);
    } else if (node.initializer) visit(node.initializer, scope, references);
    if (node.condition) visit(node.condition, loopScope, references);
    if (node.incrementor) visit(node.incrementor, loopScope, references);
    visit(node.statement, loopScope, references);
    return;
  }
  if (ts.isCatchClause(node)) {
    const catchScope: Scope = { parent: scope, bindings: new Map() };
    if (node.variableDeclaration) bindBindingName(catchScope, node.variableDeclaration.name);
    visit(node.block, catchScope, references);
    return;
  }
  if (ts.isIdentifier(node) && isValueReference(node)) {
    const decl = resolve(scope, node.text);
    if (decl) references.push({ ident: node, decl, write: isWrite(node) });
  }
  ts.forEachChild(node, (child) => visit(child, scope, references));
}

function bindModule(scope: Scope, sourceFile: ts.SourceFile): void {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) scope.bindings.set(clause.name.text, clause.name);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) scope.bindings.set(named.name.text, named.name);
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) scope.bindings.set(element.name.text, element.name);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name)
      scope.bindings.set(statement.name.text, statement.name);
    if (ts.isVariableStatement(statement)) bindVariableStatement(scope, statement);
  }
}

function bindBlock(scope: Scope, block: ts.Block): void {
  for (const statement of block.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      scope.bindings.set(statement.name.text, statement.name);
    if (ts.isClassDeclaration(statement) && statement.name)
      scope.bindings.set(statement.name.text, statement.name);
    if (ts.isVariableStatement(statement)) bindVariableStatement(scope, statement);
  }
}

function bindFunctionVars(scope: Scope, body: ts.Node): void {
  const visitNode = (node: ts.Node) => {
    if (isFunctionLike(node)) return;
    if (ts.isVariableStatement(node) && isVarList(node.declarationList))
      bindVariableStatement(scope, node);
    ts.forEachChild(node, visitNode);
  };
  ts.forEachChild(body, visitNode);
}

function isVarList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.Let) === 0 && (list.flags & ts.NodeFlags.Const) === 0;
}

function bindVariableStatement(scope: Scope, statement: ts.VariableStatement): void {
  for (const declaration of statement.declarationList.declarations)
    bindBindingName(scope, declaration.name);
}

function bindBindingName(scope: Scope, name: ts.BindingName): void {
  if (ts.isIdentifier(name)) {
    scope.bindings.set(name.text, name);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindBindingName(scope, element.name);
  }
}

function resolve(scope: Scope, name: string): ts.Node | undefined {
  let current: Scope | undefined = scope;
  while (current) {
    const found = current.bindings.get(name);
    if (found) return found;
    current = current.parent;
  }
  return undefined;
}

function isValueReference(node: ts.Identifier): boolean {
  if (isInTypePosition(node)) return false;
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node)
    return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
    return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent))
    return false;
  if (
    ts.isClassDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent)
  )
    return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isJsxAttribute(parent)) return false;
  if (
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxSelfClosingElement(parent) ||
    ts.isJsxClosingElement(parent)
  ) {
    return parent.tagName === node && /^[A-Z]/.test(node.text);
  }
  return true;
}

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function isWrite(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    !!parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === node
  );
}

function dependencyKey(ident: ts.Identifier): string | undefined {
  return chainText(widen(ident));
}

function widen(node: ts.Node): ts.Node {
  const parent = significantParent(node);
  if (
    parent &&
    ts.isPropertyAccessExpression(parent) &&
    sameExpression(parent.expression, node) &&
    parent.name.text !== "current" &&
    !isCallee(parent)
  ) {
    return widen(parent);
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    sameExpression(parent.left, node)
  ) {
    return node.expression;
  }
  return node;
}

function significantParent(node: ts.Node): ts.Node | undefined {
  let current = node;
  while (current.parent && isWrapper(current.parent) && current.parent.expression === current)
    current = current.parent;
  return current.parent;
}

function sameExpression(candidate: ts.Node, target: ts.Node): boolean {
  let current = candidate;
  while (isWrapper(current)) current = current.expression;
  return current === target;
}

function isWrapper(
  node: ts.Node,
): node is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

function isCallee(member: ts.Node): boolean {
  const parent = significantParent(member);
  return !!parent && isCallLike(parent) && sameExpression(parent.expression, member);
}

function isCallLike(node: ts.Node | undefined): node is ts.CallExpression | ts.NewExpression {
  return !!node && (ts.isCallExpression(node) || ts.isNewExpression(node));
}

function chainText(node: ts.Node): string | undefined {
  if (isWrapper(node)) return chainText(node.expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const object = chainText(node.expression);
    return object ? `${object}.${node.name.text}` : undefined;
  }
  if (ts.isParenthesizedExpression(node)) return chainText(node.expression);
  return undefined;
}

function isStable(
  decl: ts.Node,
  reactive: ts.FunctionLikeDeclaration,
  references: Reference[],
): boolean {
  return (
    isStableKnownHookValue(decl, references) ||
    isFunctionWithoutCapturedValues(decl, reactive, references)
  );
}

function isStableKnownHookValue(decl: ts.Node, references: Reference[]): boolean {
  if (!ts.isIdentifier(decl)) return false;
  const declarator = variableDeclarator(decl);
  if (!declarator?.initializer) return false;
  const init = unwrapAs(declarator.initializer);
  if (isConst(declarator) && isStableLiteral(init)) return true;
  if (!ts.isCallExpression(init)) return false;
  const name = calleeName(init.expression);
  if (!name) return false;
  if ((name === "useRef" || name === "useEffectEvent") && declarator.name === decl) return true;
  if (name === "useState" || name === "useReducer" || name === "useActionState") {
    if (!ts.isArrayBindingPattern(declarator.name) || !isSecondElement(declarator.name, decl))
      return false;
    if (name === "useState" && writeCount(decl, references) > 1) return false;
    return true;
  }
  if (
    name === "useTransition" &&
    ts.isArrayBindingPattern(declarator.name) &&
    isSecondElement(declarator.name, decl)
  ) {
    return true;
  }
  return false;
}

function isFunctionWithoutCapturedValues(
  decl: ts.Node,
  reactive: ts.FunctionLikeDeclaration,
  references: Reference[],
): boolean {
  const fn = directFunction(decl, reactive);
  if (!fn) return false;
  for (const reference of references) {
    if (!isInside(reference.ident, fn)) continue;
    if (!isInside(reference.decl, reactive) || isDeclaredInsideCallback(reference.decl, fn))
      continue;
    if (isStableKnownHookValue(reference.decl, references)) continue;
    return false;
  }
  return true;
}

function directFunction(
  decl: ts.Node,
  reactive: ts.FunctionLikeDeclaration,
): ts.FunctionLikeDeclaration | undefined {
  if (!reactive.body || !ts.isBlock(reactive.body)) return undefined;
  for (const statement of reactive.body.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name === decl) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
      if (declaration.name === decl && initializer && isFunctionExpressionLike(initializer))
        return initializer;
    }
  }
  return undefined;
}

function isFunctionExpressionLike(
  node: ts.Expression,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function variableDeclarator(name: ts.Node): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = name.parent;
  while (current) {
    if (ts.isVariableDeclaration(current)) return current;
    if (isFunctionLike(current) || ts.isSourceFile(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function isConst(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const)
  );
}

function isStableLiteral(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.NullKeyword
  );
}

function unwrapAs(expr: ts.Expression): ts.Expression {
  return unwrapExpression(expr);
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (isWrapper(current)) current = current.expression;
  return current;
}

function calleeName(expr: ts.Expression): string | undefined {
  const unwrapped = unwrapAs(expr);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === "React" &&
    ts.isIdentifier(unwrapped.name)
  ) {
    return unwrapped.name.text;
  }
  return undefined;
}

function isSecondElement(pattern: ts.ArrayBindingPattern, decl: ts.Node): boolean {
  if (pattern.elements.length !== 2) return false;
  const second = pattern.elements[1];
  return !!second && ts.isBindingElement(second) && second.name === decl;
}

function writeCount(decl: ts.Node, references: Reference[]): number {
  return 1 + references.filter((reference) => reference.decl === decl && reference.write).length;
}

function isDeclaredInsideCallback(decl: ts.Node, callback: ts.Node): boolean {
  if (isFunctionLike(callback) && "name" in callback && callback.name === decl) return false;
  return isInside(decl, callback);
}

function reduce(hits: Array<{ key: string; pos: number }>): string[] {
  const keys = new Set(hits.map((hit) => hit.key));
  for (const key of keys) {
    const parts = key.split(".");
    for (let length = 1; length < parts.length; length++) {
      if (keys.has(parts.slice(0, length).join("."))) {
        keys.delete(key);
        break;
      }
    }
  }
  const first = new Map<string, number>();
  for (const hit of hits) {
    if (!keys.has(hit.key)) continue;
    const previous = first.get(hit.key);
    if (previous === undefined || hit.pos < previous) first.set(hit.key, hit.pos);
  }
  return [...keys].sort((left, right) => first.get(left)! - first.get(right)!);
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  );
}
