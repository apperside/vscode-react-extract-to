# Extract in useMemo and useCallback

Project home: https://apperside.github.io/vscode-react-extract-to/

A refactor for React. Put the cursor on a variable or function inside a component, and wrap it in `useMemo` or `useCallback` with the dependency array `react-hooks/exhaustive-deps` would require.

Works in JavaScript, JSX, TypeScript, and TSX.

## Before and after

```tsx
function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = () => onSelect(user.id);
}
```

Cursor on `lepo create label`, then **Extract in useMemo**:

```tsx
import { useMemo } from "react";

function Profile({ user, onSelect }: Props) {
  const label = useMemo(() => user.name.toUpperCase(), [user.name]);
  const handleSelect = () => onSelect(user.id);
}
```

Cursor on `handleSelect`, then **Extract in useCallback**:

```tsx
import { useCallback } from "react";

function Profile({ user, onSelect }: Props) {
  const label = user.name.toUpperCase();
  const handleSelect = useCallback(() => onSelect(user.id), [onSelect, user.id]);
}
```

The same rules apply in custom hooks (`useSomething`) and in components passed to `memo` or `forwardRef`.

## How to use it

1. Place the cursor on the binding name. For a function declaration, the cursor can also sit on the `function` keyword.
2. Open the lightbulb (`⌘.` on macOS, `Ctrl+.` on Windows and Linux), or run **Refactor…** from the Command Palette.
3. Choose **Extract in useMemo** or **Extract in useCallback**.

The extension picks the hook from the declaration. A function becomes `useCallback`. Anything else becomes `useMemo`. You only see the action that applies.

`useMemo` or `useCallback` is added to the existing `react` import. If the file imports `React` as a namespace, the call is written `React.useMemo` or `React.useCallback` and the import is left alone. If `react` is not imported yet, a named import is inserted.

## What you can extract

| You select | You get |
| --- | --- |
| `const label = user.name` | `const label = useMemo(() => user.name, [user.name])` |
| `let label = user.name` | the same, rewritten as `const` |
| `const { name } = user` | `const { name } = useMemo(() => user, [user])` |
| `const handle = () => onSelect(id)` | `const handle = useCallback(() => onSelect(id), [onSelect, id])` |
| `function handle() { onSelect(id); }` | `const handle = useCallback(() => { onSelect(id); }, [onSelect, id])` |

A statement with several bindings is split. Extracting `b` from `const a = 1, b = props.b, c = 3` leaves `a` and `c` as they were, and writes `b` on the next line.

Type annotations stay on the binding: `const label: string = user.name` keeps `: string`.

## Dependencies

The array is the one the React hooks lint rule would ask for if it were empty.

A prop is recorded as the value the expression actually reads. `user.name.toUpperCase()` depends on `user.name`. `onSelect(user.id)` depends on `onSelect` and `user.id`. Calling `props.onSelect(id)` depends on `props` and `id`, because the method is called on `props`.

These stay out of the array:

- imports and values declared outside the component
- `const` strings, numbers, and `null`
- `useState` setters, `useReducer` dispatch, `useRef`, `useEffectEvent`, and `startTransition`
- `ref.current`

A helper declared in the component is included when it closes over a prop, and omitted when it does not.

## When the lightbulb stays quiet

The new hook call has to be unconditional, so the action is offered only for a declaration that sits directly in the body of a function component or custom hook. It is not offered inside `if`, after a conditional `return` or `throw`, or inside a nested helper.

It is also skipped when:

- the initializer is already `useMemo` or `useCallback`
- the extracted code would call a hook
- the declaration is `var`, a generator, or a function overload
- the cursor is in a class, or in a function that is not a component or a hook

## Requirements

Visual Studio Code 1.85 or newer.

## Development

```bash
npm install
npm test
npm run lint
npm run fmt:check
npm run compile
```

`npm run compile` writes the extension to `out/`. Launch an Extension Development Host with this folder as the extension path to try a change.

## License

[MIT](LICENSE)
