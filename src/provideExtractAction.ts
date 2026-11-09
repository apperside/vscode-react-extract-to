import ts from "typescript";
import { buildEdits, type TextEdit } from "./buildEdits.js";
import { collectDependencies } from "./collectDependencies.js";
import { findExtractTarget, type Selection } from "./findExtractTarget.js";

export interface ExtractAction {
  title: "Extract in useMemo" | "Extract in useCallback";
  edits: TextEdit[];
}

export function provideExtractAction(
  source: string,
  selection: Selection,
  scriptKind: ts.ScriptKind,
): ExtractAction | undefined {
  const fileName = scriptKind === ts.ScriptKind.TSX || scriptKind === ts.ScriptKind.JSX ? "fixture.tsx" : "fixture.ts";
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const target = findExtractTarget(sourceFile, selection);
  if (!target) return undefined;
  return {
    title: target.hook === "useMemo" ? "Extract in useMemo" : "Extract in useCallback",
    edits: buildEdits(sourceFile, target, collectDependencies(sourceFile, target)),
  };
}
