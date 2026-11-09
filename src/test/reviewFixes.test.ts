import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { collectDependencies } from "../collectDependencies.js";
import { findExtractTarget } from "../findExtractTarget.js";
import { provideExtractAction } from "../provideExtractAction.js";

function rewritten(source: string, binding: string, kind = ts.ScriptKind.TSX): string {
  const sourceFile = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, kind);
  const start = source.indexOf(binding);
  const action = provideExtractAction(source, { start, end: start + binding.length }, kind);
  assert.ok(action, source);
  const ordered = [...action.edits].sort((left, right) => right.start - left.start);
  return ordered.reduce((text, edit) => text.slice(0, edit.start) + edit.newText + text.slice(edit.end), source);
}

function keys(source: string, binding: string): string[] {
  const sourceFile = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const marker = source.indexOf(`const ${binding}`);
  const start = source.indexOf(binding, marker === -1 ? 0 : marker);
  const target = findExtractTarget(sourceFile, { start, end: start + binding.length });
  assert.ok(target, source);
  return collectDependencies(sourceFile, target);
}

test("an object followed by as stays parenthesized", () => {
  const source = "function Profile() {\n  const label = { a: 1 } as const;\n}\n";
  assert.match(rewritten(source, "label"), /useMemo\(\(\) => \(\{ a: 1 \} as const\), \[\]\)/);
});

test("a function body keeps template text", () => {
  const source = "function Profile() {\n  function handle() {\n    return `hello\nworld`;\n  }\n}\n";
  const result = rewritten(source, "function handle");
  assert.match(result, /`hello\nworld`/);
  assert.doesNotMatch(result, /`hello\n {2}world`/);
});

test("use client stays ahead of the inserted import", () => {
  const source = "\"use client\";\nfunction Profile({ user }: Props) {\n  const label = user.name;\n}\n";
  assert.match(rewritten(source, "label"), /^"use client";\nimport \{ useMemo \} from "react";/);
});

test("a jsx attribute name is not a dependency", () => {
  const source = "function Comp({ id, user }: Props) {\n  const label = <div id={user.name} />;\n}\n";
  assert.deepEqual(keys(source, "label"), ["user.name"]);
});

test("a nested var and a local class are dependencies", () => {
  const varSource = "function Comp(props: Props) {\n  if (ready) {\n    var value = props.value;\n  }\n  const label = value;\n}\n";
  assert.deepEqual(keys(varSource, "label"), ["value"]);
  const classSource = "function Comp() {\n  class Row {}\n  const label = Row;\n}\n";
  assert.deepEqual(keys(classSource, "label"), ["Row"]);
});

test("for, catch, and a function expression shadow outer props", () => {
  const loop = "function Comp({ item, items }: Props) {\n  const label = () => {\n    for (const item of items) {\n      return item.id;\n    }\n  };\n}\n";
  assert.deepEqual(keys(loop, "label"), ["items"]);
  const caught = "function Comp({ error }: Props) {\n  const run = () => {\n    try {\n      return 1;\n    } catch (error) {\n      return error.message;\n    }\n  };\n}\n";
  assert.deepEqual(keys(caught, "run"), []);
  const named = "function Comp({ inner }: Props) {\n  const run = () => {\n    const value = function inner() {\n      return inner();\n    };\n    return value;\n  };\n}\n";
  assert.deepEqual(keys(named, "run"), []);
});

test("a called member is recognized through a non-null assertion", () => {
  const source = "function Comp(props: Props) {\n  const run = () => props.onSelect!(props.id);\n}\n";
  assert.deepEqual(keys(source, "run"), ["props"]);
});

test("a parenthesized arrow is useCallback", () => {
  const source = "function Comp({ onSelect }: Props) {\n  const handle = (() => onSelect());\n}\n";
  const result = rewritten(source, "handle");
  assert.match(result, /useCallback\(\(\(\) => onSelect\(\)\), \[onSelect\]\)/);
  assert.doesNotMatch(result, /useMemo/);
});

test("a lowercase function expression assigned to a component const is reactive", () => {
  const source = "const Profile = function profile({ user }: Props) {\n  const label = user.name;\n};\n";
  assert.match(rewritten(source, "label"), /useMemo\(\(\) => user\.name, \[user\.name\]\)/);
});

test("a type annotation on a binding pattern is kept", () => {
  const source = "function Profile({ user }: Props) {\n  const { name }: { name: string } = user;\n}\n";
  assert.match(rewritten(source, "{ name }"), /const \{ name \}: \{ name: string \} = useMemo\(\(\) => user, \[user\]\)/);
});
