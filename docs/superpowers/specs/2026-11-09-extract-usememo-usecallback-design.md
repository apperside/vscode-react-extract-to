# Extract in useMemo and useCallback

A VS Code extension that rewrites a declaration inside a React function component or custom hook into `useMemo` or `useCallback`. The dependency array is the one `react-hooks/exhaustive-deps` would require if that array were empty.

The behavior below is the whole product. Class components, `var`, generators, `useEffect` extraction, and editing an existing dependency array are out of scope.

## The edit

The lightbulb offers one refactor when the selection sits on a declaration. Languages: `javascript`, `javascriptreact`, `typescript`, `typescriptreact`.

The selection qualifies when it lies inside the statement and overlaps the binding pattern, or, for a function declaration, the `function` keyword or the function name. One binding is extracted at a time.

| Declaration | Result |
| --- | --- |
| `const` or `let` whose initializer is an arrow function, an async arrow, or a function expression | `const name = useCallback(initializer, deps)` |
| Nested `function name() {}` or `async function name() {}` | `const name = useCallback(arrow, deps)` |
| Any other `const` or `let` initializer, including object and array patterns | `const pattern = useMemo(() => initializer, deps)` |

`let` becomes `const`. A type annotation on a simple binding stays on the binding: `const label: string = user.name` becomes `const label: string = useMemo(() => user.name, [user.name])`. The initializer's source text is copied unchanged, except an object-literal body is parenthesized (`() => ({ a: 1 })`).

A function declaration is printed as an arrow with the same type parameters, parameters, return type, async flag, and body. In JSX and TSX, a single type parameter gains a trailing comma (`<T,>`) so it is not parsed as a tag. The binding is no longer hoisted; it exists from this statement downward.

A multi-declarator statement splits. Extracting `b` from `const a = 1, b = props.b, c = 3` produces:

```tsx
const a = 1, c = 3;
const b = useMemo(() => props.b, [props.b]);
```

Untouched declarators keep their original text and their original `const` or `let`. Only the extracted binding is rewritten as `const`. When it was the only declarator, the whole statement is replaced.

Props are ordinary render-scope bindings. These two forms are the ones the edit is built around:

```tsx
function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = () => onSelect(user.id);
}
```

```tsx
function Profile({ user, onSelect }: Props) {
  const label = useMemo(() => user.name.toUpperCase(), [user.name]);
  const handleSelect = useCallback(() => onSelect(user.id), [onSelect, user.id]);
}
```

`useMemo` or `useCallback` is added to the existing named `react` import. A default import becomes `import React, { useMemo } from "react"`. A namespace import (`import * as React from "react"`) is left as it is and the call is printed `React.useMemo` or `React.useCallback`. When `react` is not imported, the edit inserts `import { useMemo } from "react"` as the first import. An import that already has the name is left alone. Type-only specifiers stay type-only.

The printed call is one line when the initializer is one line. Otherwise the dependency array is on its own line. Dependency order is the order defined in the next section. The extension does not run Prettier.

## When nothing is offered

The declaration's statement is a direct child of the reactive function body, and no preceding sibling returns or throws outside a nested function. That keeps the inserted hook unconditional. A preceding `if` that does not return is fine. A preceding `if` that returns is not.

The enclosing function is a reactive scope when any of these hold:

- Its name matches a component (`/^[A-Z]/`) or a custom hook (`/^use[A-Z0-9]/`). The name may be the function name or the `const` it is assigned to.
- It is an anonymous `export default function`.
- It is the function passed to `memo` or `forwardRef`, including `React.memo` and `React.forwardRef`.

The nearest enclosing reactive function is the one that counts. Bindings from an outer component are not dependencies.

Nothing is offered when:

- The initializer is already a `useMemo` or `useCallback` call, with or without a `React.` prefix.
- The extracted callback would contain a hook call (`use` followed by an uppercase letter, or `React.useX`).
- The function is a generator, or it has overload signatures.
- The statement is `var`.
- The cursor is in a class, or in a function that is not a reactive scope.

Malformed code yields no action. The extension does not report a diagnostic.

## Dependencies

Given the callback that will sit inside `useMemo` or `useCallback`, and an empty dependency array, the printed array is the missing set from `exhaustive-deps`. Stable values are omitted. The implementation follows the rule in `eslint-plugin-react-hooks` (`ExhaustiveDeps`), including the property-chain walk, not a looser "every identifier" walk.

A reference is a candidate when the identifier is in a value position and resolves to a declaration in the reactive function. Type nodes, import bindings, module-level bindings, and globals are not candidates. A binding declared inside the callback is not a candidate. Shadowing uses the nearest declaration.

Each candidate is widened to a property chain:

- Static access extends the chain: `user.name` is `user.name`, and `props.user.name` is `props.user.name`. Optional access uses the same dotted key: `user?.name` is `user.name`.
- The chain stops before `.current`. `ref.current` is the key `ref`.
- The chain stops before the member that is actually called. `user.name.toUpperCase()` is `user.name`. `props.onSelect(id)` is `props` plus `id`, because the called member is dropped and `id` is its own reference. A destructured `onSelect(user.id)` stays `onSelect` and `user.id`.
- A computed access does not extend the chain. `items[index]` contributes `items` and `index`. `items[props.id]` contributes `items` and `props.id`.
- Assignment to a member depends on the object. `obj.foo = 1` contributes `obj`.

When several keys share a prefix and a shorter key is itself read, only the shorter key is kept. Reading `user` and `user.name` produces `user`. Reading `user.name` and `user.email` produces both. Keys are unique. Order is first-seen source order of the keys that survive this reduction.

A candidate is stable, and dropped, when its declaration is one of:

- A `const` initialized with a string literal, a number literal, or `null`, after unwrapping `as` expressions. `const n = 1` is stable. `const enabled = true` is not, because the rule only treats string, number, and `null` literals as stable. `satisfies` is not unwrapped.
- `const ref = useRef(...)` or `React.useRef(...)`, bound to an identifier.
- `const onStuff = useEffectEvent(...)` or `React.useEffectEvent(...)`, bound to an identifier.
- The second element of a two-element array pattern from `useState`, `useReducer`, `useActionState`, or `useTransition` (with or without a `React.` prefix). A `useState` setter that is assigned again later is not stable. A three-element `useActionState` pattern does not get this exemption, matching the rule's length check.
- A function declared directly in the reactive function that captures nothing from that function except stable bindings. Capturing another function still counts as unstable. The rule does not look through functions transitively.

Stability is recognized only on that direct declaration. `const setX2 = setX` is its own binding and is not stable. A recursive call such as `function f() { f(); }` refers to a binding in the reactive function, so the result is `const f = useCallback(() => { f(); }, [f])`.

## Modules

The VS Code provider is a thin adapter. Three modules do the work, and each can be tested without the editor.

`findExtractTarget(sourceFile, selection)` returns one target or nothing. A target records the reactive function, the statement, the declarator or function declaration, which hook to insert, and the callback node whose reads are dependencies. For `useMemo`, that callback is the initializer. For `useCallback`, it is the function itself.

`collectDependencies(sourceFile, target)` returns the dependency keys. It parses with the TypeScript compiler API and resolves bindings with a scope walk over the one open file. It does not load ESLint, and it does not require a project program. Imports still resolve to their import clause, which is outside the reactive function, so imported names stay out of the array.

`buildEdits(sourceFile, target, dependencies)` returns the text edits: the statement rewrite, and the import or `React.` qualification when the chosen hook is not already in scope.

`provideExtractAction` calls these three and returns a single `refactor.rewrite` code action titled `Extract in useMemo` or `Extract in useCallback`.

Suggested layout:

```text
src/extension.ts
src/provideExtractAction.ts
src/findExtractTarget.ts
src/collectDependencies.ts
src/buildEdits.ts
src/test/
```

The extension activates on the four script languages. It contributes no commands.

## Tests

Node's test runner covers the three modules with source fixtures. Each dependency fixture is an input fragment plus the expected key list. The set that must pass:

- Destructured props, as in the `Profile` example. `user.name.toUpperCase()` contributes `user.name`. `onSelect(user.id)` contributes `onSelect` and `user.id`.
- A props parameter. `props.user.name` contributes `props.user.name`. `props.onSelect(id)` contributes `props` and `id`.
- Reading both `user` and `user.name` contributes `user` only.
- `items[props.id]` contributes `items` and `props.id`.
- A `const` number, string, or `null` is omitted. A `const` boolean is kept.
- `useState` and `useReducer` setters, `useRef`, `useEffectEvent`, and `useTransition`'s `startTransition` are omitted. `ref.current` contributes nothing when `ref` comes from `useRef`.
- An imported function and a module-level constant are omitted.
- A helper declared in the component that closes over a prop is kept. A helper that closes over nothing reactive is omitted.
- A declaration inside `if`, after a conditional return, or inside a nested non-reactive function produces no target.
- A hook call in the initializer produces no target. An initializer that is already `useMemo` or `useCallback` produces no target.
- `let`, a destructuring pattern, and a multi-declarator split rewrite as specified, and the React import is added or extended.

`buildEdits` fixtures assert the full resulting source for the `Profile` example, a `props.user.name` example, a split declarator, a function-declaration rewrite, and each import shape.
