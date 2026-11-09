import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { collectDependencies } from "../collectDependencies.js";
import { findExtractTarget } from "../findExtractTarget.js";

function bindingStart(source: string, binding: string): number {
  const match = new RegExp(`(?:const|let|function)\\s+${binding}\\b`).exec(source);
  if (!match) return source.indexOf(binding);
  return match.index + match[0].lastIndexOf(binding);
}

function deps(source: string, binding: string): string[] {
  const sourceFile = ts.createSourceFile(
    "fixture.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const start = bindingStart(source, binding);
  assert.notEqual(start, -1, binding);
  const target = findExtractTarget(sourceFile, { start, end: start + binding.length });
  assert.ok(target, source);
  return collectDependencies(sourceFile, target);
}

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
  ["function Profile({ user }: Props) {\n  const label = user?.name;\n}\n", "label", ["user.name"]],
  [
    'function Comp() {\n  const n = 1;\n  const s = "a";\n  const empty = null;\n  const enabled = true;\n  const label = String(n) + s + empty + enabled;\n}\n',
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
    'import { format } from "./format";\nconst LIMIT = 10;\nfunction Comp({ user }: Props) {\n  const label = format(user.name, LIMIT);\n}\n',
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
  ["function Profile() {\n  function f() { f(); }\n}\n", "f", ["f"]],
  [
    "function Comp({ Icon, user }: Props) {\n  const label = <><Icon />{user.name}<div /></>;\n}\n",
    "label",
    ["Icon", "user.name"],
  ],
  [
    'import { Icon } from "./icon";\nfunction Comp({ user }: Props) {\n  const label = <Icon>{user.name}</Icon>;\n}\n',
    "label",
    ["user.name"],
  ],
  [
    "function Comp({ user }: Props) {\n  const handle = (n = user.id) => n;\n}\n",
    "handle",
    ["user.id"],
  ],
  [
    'function Comp({ user }: Props) {\n  const label = user.name;\n  function inner() {\n    const user = { name: "local" };\n    return user.name;\n  }\n}\n',
    "label",
    ["user.name"],
  ],
  [
    'function Comp({ user }: Props) {\n  const label = (() => { const user = { name: "local" }; return user.name; })();\n}\n',
    "label",
    [],
  ],
  [
    'function Comp({ user }: Props) {\n  const label = () => { const user = { name: "local" }; return user.name; };\n}\n',
    "label",
    [],
  ],
  ["function Comp({ obj }: Props) {\n  const run = () => { obj.foo = 1; };\n}\n", "run", ["obj"]],
  [
    "interface User { name: string }\nfunction Comp({ user }: { user: User }) {\n  const label: User = user;\n}\n",
    "label",
    ["user"],
  ],
];

for (const [source, binding, expected] of cases) {
  test(`${binding} -> ${expected.join(", ") || "(empty)"}`, () => {
    assert.deepEqual(deps(source, binding), expected);
  });
}
