import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { findExtractTarget } from "../findExtractTarget.js";

function parse(source: string, kind = ts.ScriptKind.TSX) {
  return ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, kind);
}

function at(source: string, needle: string, kind?: ts.ScriptKind) {
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, needle);
  return findExtractTarget(parse(source, kind), { start, end: start + needle.length });
}

test("useMemo for a const in a function component", () => {
  const source = "function Profile({ user }: Props) {\n  const label = user.name;\n}\n";
  const target = at(source, "label");
  assert.equal(target?.hook, "useMemo");
  assert.equal(target?.declaration.getText(), "label = user.name");
});

test("useCallback for an arrow, an async arrow, and a function expression", () => {
  assert.equal(at("function Profile() {\n  const handle = () => 1;\n}\n", "handle")?.hook, "useCallback");
  assert.equal(at("function Profile() {\n  const handle = async () => 1;\n}\n", "handle")?.hook, "useCallback");
  assert.equal(at("function Profile() {\n  const handle = function () { return 1; };\n}\n", "handle")?.hook, "useCallback");
  assert.equal(at("function Profile() {\n  const handle = async function () { return 1; };\n}\n", "handle")?.hook, "useCallback");
});

test("useCallback for a nested function declaration", () => {
  const source = "function Profile() {\n  function handle() { return 1; }\n}\n";
  const target = at(source, "handle");
  assert.equal(target?.hook, "useCallback");
  assert.equal(target?.declaration.kind, ts.SyntaxKind.FunctionDeclaration);
});

test("a conditional expression that returns functions is useMemo", () => {
  const source = "function Profile() {\n  const handle = flag ? () => 1 : () => 2;\n}\n";
  assert.equal(at(source, "handle")?.hook, "useMemo");
});

test("let and a destructuring pattern are targets", () => {
  assert.equal(at("function Profile({ user }: Props) {\n  let label = user.name;\n}\n", "label")?.hook, "useMemo");
  assert.equal(
    at("function Profile({ user }: Props) {\n  const { name } = user;\n}\n", "{ name }")?.hook,
    "useMemo",
  );
});

test("multi-declarator selection is the one overlapped binding", () => {
  const source = "function Profile(props: Props) {\n  const a = 1, b = props.b, c = 3;\n}\n";
  const target = at(source, "b");
  assert.equal(target?.declaration.getText(), "b = props.b");
  assert.equal(at(source, "a")?.declaration.getText(), "a = 1");
});

test("reactive scopes include components, hooks, anonymous default functions, and memo or forwardRef", () => {
  const cases = [
    "function Profile() {\n  const label = 1;\n}\n",
    "const Profile = () => {\n  const label = 1;\n};\n",
    "function useProfile() {\n  const label = 1;\n}\n",
    "export default function () {\n  const label = 1;\n}\n",
    "const Profile = memo(function () {\n  const label = 1;\n});\n",
    "const Profile = React.memo((props) => {\n  const label = props.name;\n});\n",
    "const Profile = React.forwardRef((props, ref) => {\n  const label = props.name;\n});\n",
    "const Profile = forwardRef(function (props, ref) {\n  const label = props.name;\n});\n",
  ];
  for (const source of cases) {
    assert.equal(at(source, "label")?.hook, "useMemo", source);
  }
});

test("the nearest reactive function wins", () => {
  const source = "function Outer() {\n  function useInner(props: Props) {\n    const label = props.name;\n  }\n}\n";
  const target = at(source, "label");
  assert.equal(target?.reactiveFunction.getText().startsWith("function useInner"), true);
});

test("nothing is offered outside a reactive scope or on a non-binding selection", () => {
  assert.equal(at("function profile() {\n  const label = 1;\n}\n", "label"), undefined);
  assert.equal(at("export default () => {\n  const label = 1;\n};\n", "label"), undefined);
  assert.equal(at("class Profile {\n  render() {\n    const label = 1;\n  }\n}\n", "label"), undefined);
  assert.equal(at("function Profile() {\n  var label = 1;\n}\n", "label"), undefined);
  const source = "function Profile({ user }: Props) {\n  const label = user.name;\n}\n";
  const init = source.indexOf("user.name");
  assert.equal(findExtractTarget(parse(source), { start: init, end: init + "user.name".length }), undefined);
  const fn = "function Profile() {\n  function handle(id: string) { return id; }\n}\n";
  const param = fn.indexOf("id: string");
  assert.equal(findExtractTarget(parse(fn), { start: param, end: param + 2 }), undefined);
});

test("nothing is offered when the hook call would be conditional", () => {
  const refused = [
    "function Profile(props: Props) {\n  if (flag) {\n    const label = props.name;\n  }\n}\n",
    "function Profile(props: Props) {\n  {\n    const label = props.name;\n  }\n}\n",
    "function Profile(props: Props) {\n  if (flag) return null;\n  const label = props.name;\n}\n",
    "function Profile(props: Props) {\n  if (flag) throw new Error();\n  const label = props.name;\n}\n",
    "function Profile(props: Props) {\n  function helper() {\n    const label = props.name;\n  }\n}\n",
  ];
  for (const source of refused) {
    assert.equal(at(source, "label"), undefined, source);
  }
  const allowed = "function Profile(props: Props) {\n  function helper() {\n    return props.name;\n  }\n  const label = props.name;\n}\n";
  assert.equal(at(allowed, "label")?.hook, "useMemo");
  const afterCall = "function Profile(props: Props) {\n  if (flag) doSomething();\n  const label = props.name;\n}\n";
  assert.equal(at(afterCall, "label")?.hook, "useMemo");
});

test("already wrapped, hook calls, generators, and overloads produce no target", () => {
  const refused = [
    "function Profile({ user }: Props) {\n  const label = useMemo(() => user.name, [user.name]);\n}\n",
    "function Profile({ user }: Props) {\n  const label = (useMemo(() => user.name, [user.name]));\n}\n",
    "function Profile({ user }: Props) {\n  const label = useMemo(() => user.name, [user.name]) as string;\n}\n",
    "function Profile({ user }: Props) {\n  const label = React.useCallback(() => user.name, [user.name]);\n}\n",
    "function Profile({ user }: Props) {\n  const label = useState(user.name);\n}\n",
    "function Profile() {\n  const handle = () => {\n    useState(1);\n  };\n}\n",
    "function Profile() {\n  function* handle() { return 1; }\n}\n",
    "function Profile() {\n  const handle = function* () { return 1; };\n}\n",
    "function Profile() {\n  function handle(x: string): string;\n  function handle(x: string) { return x; }\n}\n",
  ];
  for (const source of refused) {
    const name = source.includes("handle") ? "handle" : "label";
    assert.equal(at(source, name), undefined, source);
  }
});
