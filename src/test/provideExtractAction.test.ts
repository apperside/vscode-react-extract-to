import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { provideExtractAction, type ExtractAction } from "../provideExtractAction.js";

function apply(source: string, action: ExtractAction | undefined): string {
  const ordered = [...(action?.edits ?? [])].sort((left, right) => right.start - left.start);
  return ordered.reduce(
    (text, edit) => text.slice(0, edit.start) + edit.newText + text.slice(edit.end),
    source,
  );
}

test("Profile label becomes one useMemo action", () => {
  const source =
    "function Profile({ user, onSelect }: Props) {\n  const label = user.name.toUpperCase();\n  const handleSelect = () => onSelect(user.id);\n}\n";
  const start = source.indexOf("label");
  const action = provideExtractAction(
    source,
    { start, end: start + "label".length },
    ts.ScriptKind.TSX,
  );
  assert.equal(action?.title, "Extract in useMemo");
  assert.equal(
    apply(source, action),
    `import { useMemo } from "react";
function Profile({ user, onSelect }: Props) {
  const label = useMemo(() => user.name.toUpperCase(), [user.name]);
  const handleSelect = () => onSelect(user.id);
}
`,
  );
});

test("a cursor in a plain function returns nothing", () => {
  const source = "function profile() {\n  const label = 1;\n}\n";
  const start = source.indexOf("label");
  assert.equal(
    provideExtractAction(source, { start, end: start + "label".length }, ts.ScriptKind.TS),
    undefined,
  );
});
