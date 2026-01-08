import * as vscode from "vscode";
import {
  parseScriptForState,
  extractFunctionsFromScript,
} from "../utils/html-parser";

const STANDARD_JS_GLOBALS = [
  {
    label: "Date",
    kind: vscode.CompletionItemKind.Class,
    detail: "JS Core: Date",
  },
  {
    label: "Math",
    kind: vscode.CompletionItemKind.Class,
    detail: "JS Core: Math",
  },
  {
    label: "JSON",
    kind: vscode.CompletionItemKind.Class,
    detail: "JS Core: JSON",
  },
  {
    label: "console",
    kind: vscode.CompletionItemKind.Variable,
    detail: "JS Core: Console",
  },
];

export class MustacheCompletionProvider
  implements vscode.CompletionItemProvider
{
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const range = new vscode.Range(
      new vscode.Position(position.line, 0),
      position
    );
    const linePrefix = document.getText(range);

    const openBraceIndex = linePrefix.lastIndexOf("{");
    const closeBraceIndex = linePrefix.lastIndexOf("}");
    if (
      openBraceIndex === -1 ||
      (closeBraceIndex > -1 && closeBraceIndex > openBraceIndex)
    ) {
      return undefined;
    }

    const fullText = document.getText();

    // Use centralized AST-based parsing
    const stateVars = parseScriptForState(fullText);
    const functions = extractFunctionsFromScript(fullText);

    // Object access (user.name)
    if (linePrefix.trim().endsWith(".")) {
      const dotMatch = linePrefix.match(/([a-zA-Z0-9_]+)\.$/);
      if (dotMatch) {
        const targetVar = stateVars.find((v) => v.name === dotMatch[1]);
        if (targetVar && targetVar.type === "Object" && targetVar.keys) {
          return targetVar.keys.map((key) => {
            const item = new vscode.CompletionItem(
              key,
              vscode.CompletionItemKind.Field
            );
            item.detail = `Property of ${dotMatch[1]}`;
            return item;
          });
        }
      }
      return undefined;
    }

    // Top level completions
    const completions: vscode.CompletionItem[] = [];

    for (const v of stateVars) {
      let kind = vscode.CompletionItemKind.Variable;
      if (v.type === "Boolean") kind = vscode.CompletionItemKind.Constant;
      if (v.type === "Object") kind = vscode.CompletionItemKind.Class;

      const item = new vscode.CompletionItem(v.name, kind);
      item.detail = `Pulse State: ${v.type}`;
      item.sortText = "00_";
      completions.push(item);
    }

    for (const fn of functions) {
      const item = new vscode.CompletionItem(
        fn.name,
        vscode.CompletionItemKind.Function
      );
      item.detail = fn.isStateSetter ? "Pulse State Setter" : "Function";
      item.insertText = new vscode.SnippetString(`${fn.name}($1)`);
      item.sortText = "01_";
      completions.push(item);
    }

    for (const global of STANDARD_JS_GLOBALS) {
      const item = new vscode.CompletionItem(global.label, global.kind);
      item.detail = global.detail;
      item.sortText = "10_";
      completions.push(item);
    }

    return completions;
  }
}
