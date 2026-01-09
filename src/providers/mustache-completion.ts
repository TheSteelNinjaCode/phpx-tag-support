import * as vscode from "vscode";
import {
  parseScriptForState,
  extractFunctionsFromScript,
  parseHTMLDocument,
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
    const offset = document.offsetAt(position);

    // Parse Document & Script
    const htmlDoc = parseHTMLDocument(fullText);
    const stateVars = parseScriptForState(fullText);
    const functions = extractFunctionsFromScript(fullText);

    // 1. CHECK FOR LOOP SCOPE
    const loopScope = htmlDoc.getLoopScopeAtOffset(offset);

    // 2. CHECK OBJECT/LOOP ACCESS (e.g. "user." or "u.")
    const trimmedPrefix = linePrefix.trim();
    if (trimmedPrefix.endsWith(".")) {
      const dotMatch = trimmedPrefix.match(/([a-zA-Z0-9_]+)\.$/);
      if (dotMatch) {
        const varName = dotMatch[1];

        // A. Is it a top-level State Object?
        const targetVar = stateVars.find((v) => v.name === varName);
        if (targetVar && targetVar.type === "Object" && targetVar.keys) {
          return targetVar.keys.map((key) => {
            const item = new vscode.CompletionItem(
              key,
              vscode.CompletionItemKind.Field
            );
            item.detail = `Property of ${varName}`;
            return item;
          });
        }

        // B. Is it a Loop Alias? (e.g. 'u' from 'u in users')
        if (loopScope && loopScope.alias === varName) {
          // Find the source list ('users') in state
          const sourceList = stateVars.find((v) => v.name === loopScope.list);

          // If it's an Array and we found keys (schema)
          if (sourceList && sourceList.type === "Array" && sourceList.keys) {
            return sourceList.keys.map((key) => {
              const item = new vscode.CompletionItem(
                key,
                vscode.CompletionItemKind.Field
              );
              item.detail = `Property of ${sourceList.name} item`;
              return item;
            });
          }
        }
      }
      return undefined;
    }

    // 3. TOP LEVEL COMPLETIONS
    const completions: vscode.CompletionItem[] = [];

    // Add Loop Variable itself (e.g. 'u')
    if (loopScope) {
      const item = new vscode.CompletionItem(
        loopScope.alias,
        vscode.CompletionItemKind.Variable
      );
      item.detail = `Loop Variable (from ${loopScope.list})`;
      item.sortText = "00_";
      completions.push(item);
    }

    // Add Global State
    for (const v of stateVars) {
      let kind = vscode.CompletionItemKind.Variable;
      if (v.type === "Boolean") kind = vscode.CompletionItemKind.Constant;
      if (v.type === "Object") kind = vscode.CompletionItemKind.Class;
      if (v.type === "Array") kind = vscode.CompletionItemKind.Enum;

      const item = new vscode.CompletionItem(v.name, kind);
      item.detail = `Pulse State: ${v.type}`;
      item.sortText = "00_";
      completions.push(item);
    }

    // Add Functions
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

    // Add Globals
    for (const global of STANDARD_JS_GLOBALS) {
      const item = new vscode.CompletionItem(global.label, global.kind);
      item.detail = global.detail;
      item.sortText = "10_";
      completions.push(item);
    }

    return completions;
  }
}
