# Extract in useMemo and useCallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a VS Code extension that rewrites one declaration inside a React function component or custom hook into `useMemo` or `useCallback`, with the dependency array `react-hooks/exhaustive-deps` would require.

**Architecture:** The editor adapter is `provideExtractAction`. It parses the open buffer with the TypeScript compiler API and calls three pure functions: `findExtractTarget` chooses the declaration, `collectDependencies` computes the dependency keys, and `buildEdits` returns the text edits. Nothing loads ESLint or a project program.

**Tech Stack:** TypeScript, the `typescript` package, VS Code extension API, Node's test runner via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-09-extract-usememo-usecallback-design.md`

## Global Constraints

- Languages are `javascript`, `javascriptreact`, `typescript`, and `typescriptreact`. The extension contributes no commands and reports no diagnostic on malformed code.
- `let` is rewritten as `const`. `var`, generators, overload signatures, and class bodies produce no action.
- The dependency array is the missing set from `exhaustive-deps` for an empty array. Order is first-seen source order of the keys that survive prefix reduction. Optional access is stored as a dotted key: `user?.name` is `user.name`.
- A `const` initialized with a string literal, a number literal, or `null` is stable after unwrapping `as` expressions. `const enabled = true` is not stable. `satisfies` is not unwrapped.
- Stable hook values are omitted: `useRef`, `useEffectEvent`, and the second element of a two-element array pattern from `useState`, `useReducer`, `useActionState`, or `useTransition`, with or without a `React.` prefix. A three-element `useActionState` pattern does not get this exemption. A `useState` setter assigned again later is not stable.
- The chain stops before `.current` and before the member that is actually called. `user.name.toUpperCase()` is `user.name`. `props.onSelect(id)` is `props` plus `id`.
- The initializer's source text is copied unchanged, except an object-literal body is parenthesized. The extension does not run Prettier.
- Import edits: add the name to an existing value import from `"react"`; a default import becomes `import React, { useMemo } from "react"`; a namespace import is left untouched and the call is qualified with that namespace's local name; a missing import is inserted as `import { useMemo } from "react"` using double quotes. Type-only specifiers stay type-only.

## Review Focus

- A capitalized JSX tag declared in the component is a dependency. An imported component and a lowercase intrinsic tag are not. A person extracting a memoized element expects the local component in the array and the import out of it.
- Default parameter expressions are part of the callback. `(n = user.id) => n` contributes `user.id`.
- A name shadowed inside the callback resolves to the inner binding, so the outer prop of the same name stays out of the array.
- Assignment to a member contributes the object. `obj.foo = 1` contributes `obj`. A type annotation on the extracted binding contributes nothing: `const label: User = user` contributes `user`.
- An initializer that is already `useMemo` or `useCallback` after unwrapping parentheses and `as` expressions produces no action. `const label = (useMemo(() => user.name, [user.name]))` is left alone.

---

## File structure

```text
package.json
tsconfig.json
.gitignore
src/extension.ts                 VS Code registration and language mapping
src/provideExtractAction.ts      parses the buffer and joins the three functions
src/findExtractTarget.ts         selection, reactive scope, eligibility
src/collectDependencies.ts       exhaustive-deps key list
src/buildEdits.ts                statement rewrite and react import
src/test/findExtractTarget.test.ts
src/test/collectDependencies.test.ts
src/test/buildEdits.test.ts
src/test/provideExtractAction.test.ts
```

Import specifiers in `src/` use the `.js` extension (`from "./findExtractTarget.js"`). Tests live outside the extension compile.

### Task 1: Extension package and `findExtractTarget`

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/findExtractTarget.ts`
- Test: `src/test/findExtractTarget.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:

```typescript
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
): ExtractTarget | undefined;
```

`callback` is the initializer for `useMemo`, and the function itself for `useCallback`. `declaration` is the single binding being extracted. `statement` is the whole statement that contains it.

- [ ] **Step 1: Write the failing test**

Create `src/test/findExtractTarget.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/test/findExtractTarget.test.ts`

Expected: FAIL because `src/findExtractTarget.ts` does not exist.

- [ ] **Step 3: Scaffold the package and implement `findExtractTarget`**

`package.json` name `extract-in-memo-callback`, `main` `./out/extension.js`, engines `vscode` `^1.85.0`, activation on the four language ids, empty `contributes`, dependencies `typescript`, devDependencies `tsx`, `@types/vscode`, and `@types/node`. Scripts: `"test": "node --import tsx --test src/test/*.test.ts"` and `"compile": "tsc -p ."`. `"type": "module"`.

`tsconfig.json`: `target` ES2022, `module` and `moduleResolution` Node16, `outDir` `out`, `rootDir` `src`, `strict` true, `sourceMap` true, `include` `src/**/*.ts`, `exclude` `src/test/**`.

`.gitignore`: `node_modules/`, `out/`, `*.vsix`.

Install with `npm install`.

`findExtractTarget` walks the AST at the selection. A target requires every condition below.

- The selection overlaps the binding. A zero-width caret overlaps when `span.start <= position && position <= span.end`. A range overlaps when the intervals intersect. The span is the binding pattern (`VariableDeclaration.name`). For a function declaration it is the range from the `function` keyword through the function name.
- That declaration's statement is a direct child of a reactive function's body block.
- No preceding sibling contains a `return` or `throw` outside a nested function. An `if` that only calls a function does not count. `for`, `while`, `switch`, and `try` are included in the same walk.
- The nearest enclosing reactive function is one of: a function whose own name or whose assigned `const` name matches `/^[A-Z]/` or `/^use[A-Z0-9]/`; an anonymous `export default function`; the function argument of `memo` or `forwardRef`, including `React.memo` and `React.forwardRef`. An anonymous `export default () => {}` is not reactive.
- `var` is refused. A generator function declaration or generator function expression is refused. A function declaration with an overload signature (`body` absent, or a preceding overload of the same name) is refused.
- The initializer, after unwrapping parentheses and `as` / `TSAsExpression`, is a hook call when the callee is `React.useX` or a name matching `/^use[A-Z]/`. That includes an initializer that is already `useMemo` or `useCallback`. Either case returns nothing. The same hook-call walk over a function body refuses `useCallback` extraction.
- An initializer that is an arrow function or a non-generator function expression selects `useCallback`. A function declaration selects `useCallback`. Every other initializer selects `useMemo`.
- On a multi-declarator statement, `declaration` is only the overlapped declarator. `statement` stays the whole `VariableStatement`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/test/findExtractTarget.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/findExtractTarget.ts src/test/findExtractTarget.test.ts
git commit -m "feat: find useMemo and useCallback extract targets"
```

### Task 2: `collectDependencies`

**Files:**
- Create: `src/collectDependencies.ts`
- Test: `src/test/collectDependencies.test.ts`

**Interfaces:**
- Consumes: `ExtractTarget` and `findExtractTarget` from `src/findExtractTarget.ts`
- Produces:

```typescript
export function collectDependencies(
  sourceFile: ts.SourceFile,
  target: ExtractTarget,
): string[];
```

The returned keys are already stable-filtered and prefix-reduced, in first-seen source order.

- [ ] **Step 1: Write the failing test**

Create `src/test/collectDependencies.test.ts`. Parse with `ScriptKind.TSX`, select the binding with `findExtractTarget`, and assert `collectDependencies` against these exact lists.

```typescript
const cases: Array<[string, string, string[]]> = [
  [
    "function Profile({ user, onSelect }: Props) {\n  const label = user.name.toUpperCase();\n}\n",
    "label",
    ["user.name"],
  ],
  [
    "function Profile({ user, onSelect }: Props) {\n  const handleSelect = () => onSelect(user.id);\n}\n",
    "handleSelect",
    ["onSelect", "user.id"],
  ],
  [
    "function Profile(props: Props) {\n  const label = props.user.name;\n}\n",
    "label",
    ["props.user.name"],
  ],
  [
    "function Profile(props: Props) {\n  const id = props.id;\n  const handleSelect = () => props.onSelect(id);\n}\n",
    "handleSelect",
    ["props", "id"],
  ],
  [
    "function Profile({ user, onSelect }: Props) {\n  const label = user.name + onSelect + user;\n}\n",
    "label",
    ["onSelect", "user"],
  ],
  [
    "function Profile({ user }: Props) {\n  const label = user.name + user.email;\n}\n",
    "label",
    ["user.name", "user.email"],
  ],
  [
    "function List({ items, props }: { items: string[]; props: { id: number } }) {\n  const item = items[props.id];\n}\n",
    "item",
    ["items", "props.id"],
  ],
  [
    "function Profile({ user }: Props) {\n  const label = user?.name;\n}\n",
    "label",
    ["user.name"],
  ],
  [
    "function Comp() {\n  const n = 1;\n  const s = \"a\";\n  const empty = null;\n  const enabled = true;\n  const label = String(n) + s + empty + enabled;\n}\n",
    "label",
    ["enabled"],
  ],
  [
    "function Comp() {\n  const n = 1 as number;\n  const enabled = true satisfies boolean;\n  const label = String(n) + enabled;\n}\n",
    "label",
    ["enabled"],
  ],
  [
    "function reducer(state: number) { return state; }\nfunction Comp() {\n  const [value, setValue] = useState(0);\n  const ref = useRef(0);\n  const onStuff = useEffectEvent(() => {});\n  const [pending, startTransition] = useTransition();\n  const [state, dispatch] = useReducer(reducer, 0);\n  const run = () => { setValue(value); ref.current; onStuff(); startTransition(() => {}); dispatch(1); };\n}\n",
    "run",
    ["value"],
  ],
  [
    "function reducer(state: number) { return state; }\nfunction Comp() {\n  let [value, setValue] = useState(0);\n  setValue = () => {};\n  const run = () => setValue(1);\n}\n",
    "run",
    ["setValue"],
  ],
  [
    "function reducer(state: number) { return state; }\nfunction Comp() {\n  const [state, dispatch, isPending] = useActionState(reducer, 0);\n  const run = () => dispatch(1);\n}\n",
    "run",
    ["dispatch"],
  ],
  [
    "function reducer(state: number) { return state; }\nfunction Comp() {\n  const [state, dispatch] = useActionState(reducer, 0);\n  const run = () => dispatch(1);\n}\n",
    "run",
    [],
  ],
  [
    "import { format } from \"./format\";\nconst LIMIT = 10;\nfunction Comp({ user }: Props) {\n  const label = format(user.name, LIMIT);\n}\n",
    "label",
    ["user.name"],
  ],
  [
    "function Comp({ user }: Props) {\n  function helper() { return user.name; }\n  const label = helper();\n}\n",
    "label",
    ["helper"],
  ],
  [
    "function Comp() {\n  function helper() { return 1; }\n  const label = helper();\n}\n",
    "label",
    [],
  ],
  [
    "function Comp() {\n  function inner() { return 1; }\n  function outer() { return inner(); }\n  const label = outer();\n}\n",
    "label",
    ["outer"],
  ],
  [
    "function Profile() {\n  function f() { f(); }\n}\n",
    "f",
    ["f"],
  ],
  [
    "function Comp({ Icon, user }: Props) {\n  const label = <><Icon />{user.name}<div /></>;\n}\n",
    "label",
    ["Icon", "user.name"],
  ],
  [
    "import { Icon } from \"./icon\";\nfunction Comp({ user }: Props) {\n  const label = <Icon>{user.name}</Icon>;\n}\n",
    "label",
    ["user.name"],
  ],
  [
    "function Comp({ user }: Props) {\n  const handle = (n = user.id) => n;\n}\n",
    "handle",
    ["user.id"],
  ],
  [
    "function Comp({ user }: Props) {\n  const label = user.name;\n  function inner() {\n    const user = { name: \"local\" };\n    return user.name;\n  }\n}\n",
    "label",
    ["user.name"],
  ],
  [
    "function Comp({ user }: Props) {\n  const label = (() => { const user = { name: \"local\" }; return user.name; })();\n}\n",
    "label",
    [],
  ],
  [
    "function Comp({ obj }: Props) {\n  const run = () => { obj.foo = 1; };\n}\n",
    "run",
    ["obj"],
  ],
  [
    "interface User { name: string }\nfunction Comp({ user }: { user: User }) {\n  const label: User = user;\n}\n",
    "label",
    ["user"],
  ],
];
```

Assert each row. The shadowed-callback case extracts `label`, whose initializer does not see the inner `user`. Add one more direct case for the shadow itself: the callback `() => { const user = { name: "local" }; return user.name; }` inside `function Comp({ user }: Props)` has key list `[]`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/test/collectDependencies.test.ts`

Expected: FAIL because `src/collectDependencies.ts` does not exist.

- [ ] **Step 3: Implement `collectDependencies`**

Resolve every value-position identifier inside `target.callback` to its nearest declaration by a scope walk of this file. Skip type positions (`TSTypeReference`, `TSTypeQuery`, type arguments, and import-type bindings). A capitalized JSX tag is a value reference. A lowercase JSX intrinsic name is not. Unresolved names and declarations outside `target.reactiveFunction` are not candidates. A declaration inside `target.callback` is not a candidate.

Widen each candidate with the property-chain rules in the spec's Dependencies section. Drop stable bindings using that same section, including the direct-helper rule: a function declared as a direct child of the reactive body is stable only when every value it captures is a stable known hook value. Capturing another function keeps it unstable. Do not treat the extracted binding's own recursive reference as stable.

Prefix reduction: if a shorter dotted key is itself a candidate, drop longer keys under it. `user` drops `user.name`. `user.name` and `user.email` both stay. Order the survivors by the earliest source position of a reference that produced that exact key.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/test/collectDependencies.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/collectDependencies.ts src/test/collectDependencies.test.ts
git commit -m "feat: collect exhaustive-deps keys for an extract target"
```

### Task 3: `buildEdits`

**Files:**
- Create: `src/buildEdits.ts`
- Test: `src/test/buildEdits.test.ts`

**Interfaces:**
- Consumes: `ExtractTarget` from `src/findExtractTarget.ts`
- Produces:

```typescript
export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

export function buildEdits(
  sourceFile: ts.SourceFile,
  target: ExtractTarget,
  dependencies: readonly string[],
): TextEdit[];
```

Edits do not overlap. Applying them from the highest `start` downward yields the rewritten buffer.

- [ ] **Step 1: Write the failing test**

Create `src/test/buildEdits.test.ts`. Helper: parse TSX, find the target by binding text, call `buildEdits` with `collectDependencies`, apply edits from the end, and compare the full source.

Cases and expected buffers:

```typescript
// Profile, both extractions, starting with no react import.
const profile = `function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = () => onSelect(user.id);
}
`;
// Extracting label:
const profileLabel = `import { useMemo } from "react";
function Profile({ user, onSelect }: Props) {
  const label = useMemo(() => user.name.toUpperCase(), [user.name]);
  const handleSelect = () => onSelect(user.id);
}
`;
// Extracting handleSelect from the original profile:
const profileHandler = `import { useCallback } from "react";
function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = useCallback(() => onSelect(user.id), [onSelect, user.id]);
}
`;

const propsLabel = `import { useMemo } from "react";
function Profile(props: Props) {
  const label = useMemo(() => props.user.name, [props.user.name]);
}
`;

const split = `function Profile(props: Props) {
  const a = 1, c = 3;
  const b = useMemo(() => props.b, [props.b]);
}
`;
// Source of `split` before the edit:
const splitSource = `function Profile(props: Props) {
  const a = 1, b = props.b, c = 3;
}
`;

const fromLet = `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`;

const destructure = `import { useMemo } from "react";
function Profile({ user }: Props) {
  const { name } = useMemo(() => user, [user]);
}
`;

const typed = `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label: string = useMemo(() => user.name, [user.name]);
}
`;

const objectLiteral = `import { useMemo } from "react";
function Profile() {
  const label = useMemo(() => ({ a: 1 }), []);
}
`;

const multiline = `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(
    () => user.name +
    user.email,
    [user.name, user.email],
  );
}
`;
// The initializer in the source keeps its own second-line indent:
//   const label = user.name +\n    user.email;

const oneLineFunction = `import { useCallback } from "react";
function Profile({ id, onSelect }: Props) {
  const handleSelect = useCallback(() => { onSelect(id); }, [onSelect, id]);
}
`;
// Source declaration is one line: function handleSelect() { onSelect(id); }

const functionDecl = `import { useCallback } from "react";
function Profile({ user, onSelect }: Props) {
  const handleSelect = useCallback(
    () => {
      onSelect(user.id);
    },
    [onSelect, user.id],
  );
}
`;

const asyncFunctionDecl = `import { useCallback } from "react";
function Profile({ user, onSelect }: Props) {
  const handleSelect = useCallback(
    async () => {
      onSelect(user.id);
    },
    [onSelect, user.id],
  );
}
`;
// Source: an async function declaration whose body starts on the next line.

const letSplit = `function Profile(props: Props) {
  let a = 1;
  const b = useMemo(() => props.b, [props.b]);
}
`;
// Source: let a = 1, b = props.b;

const generic = `import { useCallback } from "react";
function Profile() {
  const identity = useCallback(<T,>(value: T): T => {
    return value;
  }, []);
}
`;
// Source function declaration: function identity<T>(value: T): T { return value; }
// In a TS file (ScriptKind.TS), the same declaration prints <T> with no trailing comma.

const namedImport = `import { useState, useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`;

const defaultImport = `import React, { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`;

const namespaceImport = `import * as React from "react";
function Profile(props: Props) {
  const label = React.useMemo(() => props.user.name, [props.user.name]);
}
`;

const existingName = `import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`;

const typeOnly = `import type { ReactNode } from "react";
import { useMemo } from "react";
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`;

const singleQuotes = `import { useState, useMemo } from 'react';
function Profile({ user }: Props) {
  const label = useMemo(() => user.name, [user.name]);
}
`;

const firstImport = `import { useMemo } from "react";
import { format } from "./format";
function Profile({ user }: Props) {
  const label = useMemo(() => format(user.name), [user.name]);
}
`;
```

`oneLineFunction` stays on one line because the original declaration contains no newline. `multiline`, `functionDecl`, and `asyncFunctionDecl` use the multiline call because the copied initializer or function contains a newline. `letSplit` keeps the untouched declarator's `let`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/test/buildEdits.test.ts`

Expected: FAIL because `src/buildEdits.ts` does not exist.

- [ ] **Step 3: Implement `buildEdits`**

Replace the extracted statement. Copy the initializer text unchanged, and parenthesize it when it is an object literal. Print `const <pattern> = useMemo(() => <initializer>, [<keys>])` or `const <name> = useCallback(<function>, [<keys>])`. Keep a type annotation on a simple binding. Print a function declaration as an arrow with the same type parameters, parameters, return type, async flag, and body. In JSX and TSX, one type parameter is printed `<T,>`.

When the original initializer or function declaration contains a newline, print:

```tsx
const label = useMemo(
  () => <initializer>,
  [<keys>],
);
```

The same shape is used for `useCallback`. Otherwise print the call on one line.

A namespace value import of `react` qualifies the callee (`React.useMemo`) and adds no specifier. Otherwise ensure a value import: append the hook name to the existing named specifiers, preserving that clause's quotes; add `{ useMemo }` beside a default import; when the only `react` import is type-only, insert `import { useMemo } from "react"` immediately after it; when `react` is not imported, insert that line as the first import.

For a multi-declarator statement, remove only the extracted declarator and its surrounding comma from the original statement, then insert the new `const` statement on the following line. If no declarator remains, the original statement is removed rather than left empty.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/test/buildEdits.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/buildEdits.ts src/test/buildEdits.test.ts
git commit -m "feat: rewrite a declaration into useMemo or useCallback"
```

### Task 4: Wire the code action

**Files:**
- Create: `src/provideExtractAction.ts`
- Create: `src/extension.ts`
- Test: `src/test/provideExtractAction.test.ts`

**Interfaces:**
- Consumes: `findExtractTarget`, `collectDependencies`, `buildEdits`, and `TextEdit`
- Produces:

```typescript
export interface ExtractAction {
  title: "Extract in useMemo" | "Extract in useCallback";
  edits: TextEdit[];
}

export function provideExtractAction(
  source: string,
  selection: Selection,
  scriptKind: ts.ScriptKind,
): ExtractAction | undefined;
```

`extension.ts` exports `activate` and `deactivate`. `activate` registers a `CodeActionProvider` for the four language ids with `providedCodeActionKinds` of `refactor.rewrite`. The provider calls `provideExtractAction` and returns one `CodeAction` whose `WorkspaceEdit` carries the edits. It contributes no command.

- [ ] **Step 1: Write the failing test**

```typescript
test("Profile label becomes one useMemo action", () => {
  const source = "function Profile({ user, onSelect }: Props) {\n  const label = user.name.toUpperCase();\n  const handleSelect = () => onSelect(user.id);\n}\n";
  const start = source.indexOf("label");
  const action = provideExtractAction(source, { start, end: start + "label".length }, ts.ScriptKind.TSX);
  assert.equal(action?.title, "Extract in useMemo");
  assert.equal(apply(source, action?.edits ?? []), `import { useMemo } from "react";
function Profile({ user, onSelect }: Props) {
  const label = useMemo(() => user.name.toUpperCase(), [user.name]);
  const handleSelect = () => onSelect(user.id);
}
`);
});

test("a cursor in a plain function returns nothing", () => {
  const source = "function profile() {\n  const label = 1;\n}\n";
  const start = source.indexOf("label");
  assert.equal(
    provideExtractAction(source, { start, end: start + "label".length }, ts.ScriptKind.TS),
    undefined,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/test/provideExtractAction.test.ts`

Expected: FAIL because `src/provideExtractAction.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

`provideExtractAction` creates a source file named `fixture.tsx` for `TSX` and `JSX`, and `fixture.ts` for `TS` and `JS`, using the given `scriptKind`. It returns `undefined` when `findExtractTarget` returns nothing. Otherwise the title is `Extract in useMemo` or `Extract in useCallback`, and the edits are `buildEdits(sourceFile, target, collectDependencies(sourceFile, target))`.

Map language ids `javascript`, `javascriptreact`, `typescript`, and `typescriptreact` to `JS`, `JSX`, `TS`, and `TSX`. The code action kind is `refactor.rewrite`.

- [ ] **Step 4: Run the full test script and compile**

Run: `npm test`

Expected: PASS

Run: `npm run compile`

Expected: exit 0, with `out/extension.js` emitted.

- [ ] **Step 5: Commit**

```bash
git add src/provideExtractAction.ts src/extension.ts src/test/provideExtractAction.test.ts
git commit -m "feat: offer extract in useMemo and useCallback as a refactor"
```
