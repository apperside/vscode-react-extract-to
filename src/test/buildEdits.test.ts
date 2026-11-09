import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { buildEdits, type TextEdit } from "../buildEdits.js";
import { collectDependencies } from "../collectDependencies.js";
import { findExtractTarget } from "../findExtractTarget.js";

function apply(source: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  return ordered.reduce((text, edit) => text.slice(0, edit.start) + edit.newText + text.slice(edit.end), source);
}

function rewrite(source: string, binding: string, kind = ts.ScriptKind.TSX): string {
  const fileName = kind === ts.ScriptKind.TS ? "fixture.ts" : "fixture.tsx";
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const start = bindingStart(source, binding);
  const target = findExtractTarget(sourceFile, { start, end: start + binding.length });
  assert.ok(target, source);
  return apply(source, buildEdits(sourceFile, target, collectDependencies(sourceFile, target)));
}

function bindingStart(source: string, binding: string): number {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:const|let|function)\\s+${escaped}\\b`).exec(source);
  if (!match) return source.indexOf(binding);
  return match.index + match[0].lastIndexOf(binding);
}

test("Profile label", () => {
  const source = `function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = () => onSelect(user.id);
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
function Profile({ user, onSelect }: Props) {
  const label = useMemo(() => user.name.toUpperCase(), [user.name]);
  const handleSelect = () => onSelect(user.id);
}
`);
});

test("Profile handler", () => {
  const source = `function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = () => onSelect(user.id);
}
`;
  assert.equal(rewrite(source, "handleSelect"), `import { useCallback } from "react";
function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = useCallback(() => onSelect(user.id), [onSelect, user.id]);
}
`);
});

test("props parameter", () => {
  const source = `function Profile(props: Props) {
  const label = props.user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
function Profile(props: Props) {
  const label = useMemo(() => props.user.name, [props.user.name]);
}
`);
});

test("split declarator", () => {
  const source = `function Profile(props: Props) {
  const a = 1, b = props.b, c = 3;
}
`;
  assert.equal(rewrite(source, "b"), `import { useMemo } from "react";
function Profile(props: Props) {
  const a = 1, c = 3;
  const b = useMemo(() => props.b, [props.b]);
}
`);
});

test("split keeps let on the untouched declarator", () => {
  const source = `function Profile(props: Props) {
  let a = 1, b = props.b;
}
`;
  assert.equal(rewrite(source, "b"), `import { useMemo } from "react";
function Profile(props: Props) {
  let a = 1;
  const b = useMemo(() => props.b, [props.b]);
}
`);
});

test("let becomes const", () => {
  const source = `function Profile({ user }: Props) {
  let label = user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`);
});

test("destructuring pattern", () => {
  const source = `function Profile({ user }: Props) {
  const { name } = user;
}
`;
  assert.equal(rewrite(source, "{ name }"), `import { useMemo } from "react";
function Profile({ user }: Props) {
  const { name } = useMemo(() => user, [user]);
}
`);
});

test("type annotation stays on the binding", () => {
  const source = `function Profile({ user }: Props) {
  const label: string = user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label: string = useMemo(() => user.name, [user.name]);
}
`);
});

test("object literal is parenthesized", () => {
  const source = `function Profile() {
  const label = { a: 1 };
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
function Profile() {
  const label = useMemo(() => ({ a: 1 }), []);
}
`);
});

test("multiline initializer", () => {
  const source = `function Profile({ user }: Props) {
  const label = user.name +
    user.email;
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(
    () => user.name +
    user.email,
    [user.name, user.email],
  );
}
`);
});

test("one-line function declaration", () => {
  const source = `function Profile({ id, onSelect }: Props) {
  function handleSelect() { onSelect(id); }
}
`;
  assert.equal(rewrite(source, "handleSelect"), `import { useCallback } from "react";
function Profile({ id, onSelect }: Props) {
  const handleSelect = useCallback(() => { onSelect(id); }, [onSelect, id]);
}
`);
});

test("multiline function declaration", () => {
  const source = `function Profile({ user, onSelect }: Props) {
  function handleSelect() {
    onSelect(user.id);
  }
}
`;
  assert.equal(rewrite(source, "handleSelect"), `import { useCallback } from "react";
function Profile({ user, onSelect }: Props) {
  const handleSelect = useCallback(
    () => {
    onSelect(user.id);
  },
    [onSelect, user.id],
  );
}
`);
});

test("async function declaration", () => {
  const source = `function Profile({ user, onSelect }: Props) {
  async function handleSelect() {
    onSelect(user.id);
  }
}
`;
  assert.equal(rewrite(source, "handleSelect"), `import { useCallback } from "react";
function Profile({ user, onSelect }: Props) {
  const handleSelect = useCallback(
    async () => {
    onSelect(user.id);
  },
    [onSelect, user.id],
  );
}
`);
});

test("tsx generic gains a trailing comma", () => {
  const source = `function Profile() {
  function identity<T>(value: T): T {
    return value;
  }
}
`;
  assert.equal(rewrite(source, "identity"), `import { useCallback } from "react";
function Profile() {
  const identity = useCallback(
    <T,>(value: T): T => {
    return value;
  },
    [],
  );
}
`);
});

test("ts generic has no trailing comma", () => {
  const source = `function Profile() {
  function identity<T>(value: T): T { return value; }
}
`;
  assert.equal(rewrite(source, "identity", ts.ScriptKind.TS), `import { useCallback } from "react";
function Profile() {
  const identity = useCallback(<T>(value: T): T => { return value; }, []);
}
`);
});

test("named import is extended", () => {
  const source = `import { useState } from "react";
function Profile({ user }: Props) {
  const label = user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import { useState, useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`);
});

test("default import gains a named specifier", () => {
  const source = `import React from "react";
function Profile({ user }: Props) {
  const label = user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import React, { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`);
});

test("namespace import qualifies the call", () => {
  const source = `import * as React from "react";
function Profile(props: Props) {
  const label = props.user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import * as React from "react";
function Profile(props: Props) {
  const label = React.useMemo(() => props.user.name, [props.user.name]);
}
`);
});

test("existing hook import is left alone", () => {
  const source = `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`);
});

test("type-only react import stays type-only", () => {
  const source = `import type { ReactNode } from "react";
function Profile({ user }: Props) {
  const label = user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import type { ReactNode } from "react";
import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`);
});

test("existing quotes are preserved", () => {
  const source = `import { useState } from 'react';
function Profile({ user }: Props) {
  const label = user.name;
}
`;
  assert.equal(rewrite(source, "label"), `import { useState, useMemo } from 'react';
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`);
});

test("new react import is inserted first", () => {
  const source = `import { format } from "./format";
function Profile({ user }: Props) {
  const label = format(user.name);
}
`;
  assert.equal(rewrite(source, "label"), `import { useMemo } from "react";
import { format } from "./format";
function Profile({ user }: Props) {
  const label = useMemo(() => format(user.name), [user.name]);
}
`);
});
