import * as vscode from "vscode";
import ts from "typescript";
import { provideExtractAction } from "./provideExtractAction.js";

const scriptKinds: Record<string, ts.ScriptKind> = {
  javascript: ts.ScriptKind.JS,
  javascriptreact: ts.ScriptKind.JSX,
  typescript: ts.ScriptKind.TS,
  typescriptreact: ts.ScriptKind.TSX,
};

const languages = Object.keys(scriptKinds);

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(languages, new ExtractProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite],
    }),
  );
}

export function deactivate(): void {}

class ExtractProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] | undefined {
    const scriptKind = scriptKinds[document.languageId];
    if (!scriptKind) return undefined;
    const action = provideExtractAction(
      document.getText(),
      { start: document.offsetAt(range.start), end: document.offsetAt(range.end) },
      scriptKind,
    );
    if (!action) return undefined;
    const codeAction = new vscode.CodeAction(action.title, vscode.CodeActionKind.RefactorRewrite);
    const edit = new vscode.WorkspaceEdit();
    for (const change of action.edits) {
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)),
        change.newText,
      );
    }
    codeAction.edit = edit;
    return [codeAction];
  }
}
